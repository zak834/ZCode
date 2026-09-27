/**
 * PersistentProtocol —— 可靠性层（从 protocol.ts 拆出，避免单文件超限）。
 *
 * 在 SocketProtocol 之上添加：
 * - 消息 ACK 确认机制
 * - 心跳保活 (keepAlive)
 * - 断线重连时重放未确认的消息（有界：字节上限 + 时间宽限窗）
 * - 拥塞信号：unacknowledgedBytes 水位 + onSaturated/onDrained
 *   （帧级对事件级的唯一新增接口——事件级据此暂停
 *   drain，丢弃/降级永远发生在通道层、进 rpc 之前；接了 send() 的帧绝不丢）
 *
 * 关键：Channel RPC 层完全不知道 PersistentProtocol 的存在，
 * 它只看到 IMessagePassingProtocol 接口。这就是分层抽象的威力。
 */

import { VSBuffer } from "./buffer.js";
import { Emitter, DisposableStore } from "./foundation.js";
import {
  ChunkStream,
  HEADER_SIZE,
  ProtocolMessage,
  ProtocolMessageType,
  writeProtocolMessage,
  type ConnectionFlowControl,
  type IMessagePassingProtocol,
  type ISocket,
} from "./protocol.js";

/** PersistentProtocol 可调参数（v4 通道层补丁）。 */
export interface PersistentProtocolOptions {
  /** 未 ACK 字节高水位：越过即 onSaturated（上层暂停 drain，让 coalesce 吸收）。 */
  saturationHighWaterMarkBytes?: number;
  /** 未 ACK 字节低水位：饱和后回落至此即 onDrained（上层恢复 drain）。 */
  saturationLowWaterMarkBytes?: number;
  /** 重放缓冲字节上限：越界 = 放弃协议会话（onClose），客户端走 subscribe(base)。 */
  replayBufferMaxBytes?: number;
  /** 重放缓冲时间宽限窗（ms）：最老未 ACK 消息超龄同样放弃会话。 */
  replayBufferGraceMs?: number;
}

// 重放缓冲的一条记录：消息本身 + 入队时间戳（宽限窗判定要用，见 startAckCheck）。
interface UnackEntry {
  msg: ProtocolMessage;
  queuedAt: number;
}

// `implements A, B`（第一次遇到多接口）：同时满足两个契约——
// 它既是消息传输（IMessagePassingProtocol），又自带拥塞观测（ConnectionFlowControl）。
export class PersistentProtocol implements IMessagePassingProtocol, ConnectionFlowControl {
  // 三个"坏消息"事件要分清层级：
  // onClose：协议会话结束（对端主动断开/重放缓冲越界，恢复成本高）；
  // onSocketClose：底层传输断了（换 socket 重连还能救回来）。
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage = this._onMessage.event;

  private readonly _onClose = new Emitter<void>();
  readonly onClose = this._onClose.event;

  private readonly _onSocketClose = new Emitter<void>();
  readonly onSocketClose = this._onSocketClose.event;

  // 拥塞信号：高水位进入饱和 → onSaturated；回落低水位 → onDrained。
  private readonly _onSaturated = new Emitter<void>();
  readonly onSaturated = this._onSaturated.event;

  private readonly _onDrained = new Emitter<void>();
  readonly onDrained = this._onDrained.event;

  private socket: ISocket;
  private chunkStream = new ChunkStream();
  private disposables = new DisposableStore();

  // ACK 机制（队列有界化，条目携带入队时间用于宽限窗判定）
  // 发送端自增的消息序号：每条发出去的消息拿一个唯一编号。
  private outgoingMsgId = 0;
  private outgoingUnackMsg: UnackEntry[] = [];
  // 已收到对端第几号消息——下次发送时捎带回去，等于"到这号我全收了"。
  private incomingAckId = 0;
  // 未确认消息的总字节数（水位判定的依据）。
  private unackBytes = 0;
  private saturated = false;
  // "会话已放弃"标记：防止 abandonSession 重复触发。
  private overflowed = false;

  // 心跳
  // 心跳定时器。`ReturnType<typeof setInterval>`（第一次遇到）：
  // 读作"setInterval 的返回值类型"——浏览器里是 number、Node 里是对象，
  // 这样写两端都正确，不必关心具体是什么。
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly KEEP_ALIVE_INTERVAL = 5000; // 5 秒

  // ACK 超时
  // ACK 超时巡检定时器。
  private ackCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ACK_TIMEOUT = 20000; // 20 秒无 ACK 则断开
  // 最近一次收到对端任何帧的时间（心跳/ACK 都算"还活着"）。
  private lastAckTime = Date.now();

  // 水位/上限默认值：高水位 1MiB（≈ v4 单帧上限），低水位取高水位 1/4；
  // 重放缓冲 8MiB / 45s——对端锁屏或长期不 ACK 时放弃会话而不是无界堆内存。
  private readonly saturationHighWaterMarkBytes: number;
  private readonly saturationLowWaterMarkBytes: number;
  private readonly replayBufferMaxBytes: number;
  private readonly replayBufferGraceMs: number;

  // `options = {}` 参数默认值：不传 options 就用空对象，下面靠 ?? 逐个取默认值。
  constructor(socket: ISocket, options: PersistentProtocolOptions = {}) {
    // `??` 空值合并（buffer.ts 讲过）：配置没给就取默认——高水位 1MiB。
    this.saturationHighWaterMarkBytes = options.saturationHighWaterMarkBytes ?? 1024 * 1024;
    // 低水位默认取高水位的 1/4（Math.floor 向下取整），
    // 高/低两条水线形成"滞回区间"，避免水位在临界点附近来回抖动。
    this.saturationLowWaterMarkBytes =
      options.saturationLowWaterMarkBytes ?? Math.floor(this.saturationHighWaterMarkBytes / 4);
    this.replayBufferMaxBytes = options.replayBufferMaxBytes ?? 8 * 1024 * 1024;
    // 45_000 中间的下划线是数字分隔符（第一次遇到）：纯为可读性，等价 45000。
    this.replayBufferGraceMs = options.replayBufferGraceMs ?? 45_000;
    this.socket = socket;
    // 三件事：接好数据管道、启动心跳、启动 ACK 超时巡检。
    this.bindSocket();
    this.startKeepAlive();
    this.startAckCheck();
  }

  /** 当前未被对端 ACK 的 payload 字节数（只读拥塞观测点）。 */
  get unacknowledgedBytes(): number {
    return this.unackBytes;
  }

  // 把 socket 的两个事件接进来（订阅句柄全部登记到 store，便于整体释放）。
  private bindSocket(): void {
    this.disposables.add(
      this.socket.onData((data) => {
        this.chunkStream.acceptChunk(data);
        this.readMessages();
      }),
    );

    this.disposables.add(
      this.socket.onClose(() => {
        this._onSocketClose.fire();
      }),
    );
  }

  // 每次发送做四件事：编帧、记账（未确认队列 + 字节数）、写 socket、检查水位。
  send(buffer: VSBuffer): void {
    // `++this.outgoingMsgId` 前缀自增：先加一再使用——本条消息拿到唯一序号；
    // ack 字段顺路捎带"我已收到你第 incomingAckId 号"，省一条专门的 ACK 帧。
    const msg = new ProtocolMessage(
      ProtocolMessageType.Regular,
      ++this.outgoingMsgId,
      this.incomingAckId,
      buffer,
    );
    // 记入未确认队列并累计字节数：这条消息在对端 ACK 之前随时可能要重放。
    this.outgoingUnackMsg.push({ msg, queuedAt: Date.now() });
    this.unackBytes += buffer.byteLength;
    this.writeMessage(msg);
    // 重放缓冲字节越界 → 立即放弃会话（同步判定，不等定时器）。
    if (this.unackBytes > this.replayBufferMaxBytes) {
      this.abandonSession();
      return;
    }
    // 越过高水位进入饱和态（边沿触发，不重复通知）。
    if (!this.saturated && this.unackBytes > this.saturationHighWaterMarkBytes) {
      this.saturated = true;
      this._onSaturated.fire();
    }
  }

  /**
   * 重连时替换底层 socket，并重放所有未被确认的消息。
   * 这就是为什么 Remote 模式断线恢复后不丢消息的原因。
   */
  // 断线重连的入口：换一个新 socket，续用同一个协议会话。
  replaceSocket(newSocket: ISocket): void {
    // 旧 socket 的订阅全部作废，换新 store、新缓冲、新 socket 重新绑定。
    this.disposables.dispose();
    this.disposables = new DisposableStore();
    // 旧缓冲里可能残留断线前的半截数据，直接弃掉从零开始。
    this.chunkStream = new ChunkStream();
    this.socket = newSocket;
    this.bindSocket();

    // 重放未确认的消息
    // 这就是断线恢复不丢消息的关键：没被 ACK 的消息原样再发一遍。
    for (const entry of this.outgoingUnackMsg) {
      this.writeMessage(entry.msg);
    }
  }

  private writeMessage(msg: ProtocolMessage): void {
    this.socket.write(writeProtocolMessage(msg));
  }

  // 与 SocketProtocol.readMessages 同构的解帧循环，但多了 ACK/心跳/断开三类控制帧的处理。
  private readMessages(): void {
    while (true) {
      // 连帧头都凑不齐，退出等下一批。
      if (this.chunkStream.byteLength < HEADER_SIZE) {
        break;
      }

      const header = this.chunkStream.peek(HEADER_SIZE);
      if (!header) {
        break;
      }

      // 同 SocketProtocol：peek 解析（不消费）+ 枚举断言；这里 id/ack 都要用，不下划线。
      const type = header.readUInt8(0) as ProtocolMessageType;
      const id = header.readUInt32BE(1);
      const ack = header.readUInt32BE(5);
      const length = header.readUInt32BE(9);

      const totalFrameLength = HEADER_SIZE + length;
      if (this.chunkStream.byteLength < totalFrameLength) {
        // PersistentProtocol 和 SocketProtocol 都跑在流式传输上，
        // 这里同样要等整帧到齐后再消费 header，避免分片时把消息头吃掉。
        break;
      }

      this.chunkStream.skip(HEADER_SIZE);

      // body 可能为空（ACK/心跳帧 length=0），先准备空 buffer 兜底。
      let body = VSBuffer.alloc(0);
      if (length > 0) {
        const readBody = this.chunkStream.read(length);
        if (!readBody) {
          throw new Error("PersistentProtocol 读取到完整帧长度后 body 不应为空");
        }
        body = readBody;
      }

      // 处理对方的 ACK：清除已确认的发送队列
      this.processAck(ack);

      switch (type) {
        case ProtocolMessageType.Regular:
          // 记下对端的消息序号（下次发送时捎带回执），再把数据向上抛。
          this.incomingAckId = id;
          this._onMessage.fire(body);
          break;
        case ProtocolMessageType.Ack:
          // 纯 ACK 消息，只更新确认号
          break;
        case ProtocolMessageType.KeepAlive:
          // 心跳，只需更新最后活跃时间
          break;
        case ProtocolMessageType.Disconnect:
          // 对端明确要求结束会话。
          this._onClose.fire();
          break;
      }

      // 无论什么帧，收到即证明连接活着——刷新活跃时间，ACK 超时判定全靠它。
      this.lastAckTime = Date.now();
    }
  }

  /** 根据对方的 ACK 号清除已确认的消息 */
  // ACK 是"累积确认"语义：id <= ack 的全部视为已送达——未确认队列按序号有序，
  // 所以从队头连续出队即可。
  private processAck(ack: number): void {
    while (this.outgoingUnackMsg.length > 0 && this.outgoingUnackMsg[0].msg.id <= ack) {
      const entry = this.outgoingUnackMsg.shift()!;
      this.unackBytes -= entry.msg.data.byteLength;
    }
    // 饱和后回落到低水位 → onDrained（边沿触发）。
    // 高水位触发、低水位恢复的"滞回"设计：避免水位贴着临界线时反复横跳、通知风暴。
    if (this.saturated && this.unackBytes <= this.saturationLowWaterMarkBytes) {
      this.saturated = false;
      this._onDrained.fire();
    }
  }

  /**
   * 重放缓冲越界（字节/宽限窗）：这条协议会话已不可能无损续传，
   * 主动断开走 onClose，客户端用 subscribe(base) 语义层恢复。
   */
  // 放弃会话：断线后对端长时间不 ACK，重放缓冲已不可能无损续传。
  private abandonSession(): void {
    // 幂等保护：只执行一次。
    if (this.overflowed) {
      return;
    }
    this.overflowed = true;
    // 先礼貌告知对端断开（捎带最后的 ACK 号），再触发本端 onClose。
    this.writeMessage(
      new ProtocolMessage(ProtocolMessageType.Disconnect, 0, this.incomingAckId, VSBuffer.alloc(0)),
    );
    this._onClose.fire();
  }

  // 心跳：每 5 秒发一个空 KeepAlive 帧。空闲链路上没有数据流动，
  // 没有心跳就无法区分"没事发生"和"连接已死"。
  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      this.writeMessage(
        new ProtocolMessage(
          ProtocolMessageType.KeepAlive,
          0,
          this.incomingAckId,
          VSBuffer.alloc(0),
        ),
      );
    }, this.KEEP_ALIVE_INTERVAL);
  }

  // 定时巡检两类超时：连接死没死（ACK 超时）、重放缓冲还能不能续（宽限窗）。
  private startAckCheck(): void {
    this.ackCheckTimer = setInterval(() => {
      // 还有没确认的消息，但 20 秒没收到对端任何帧 → 判定底层连接已死。
      if (this.outgoingUnackMsg.length > 0 && Date.now() - this.lastAckTime > this.ACK_TIMEOUT) {
        this._onSocketClose.fire();
      }
      // 最老未 ACK 消息超过宽限窗（对端锁屏/长期后台）→ 放弃会话。
      const oldest = this.outgoingUnackMsg[0];
      if (oldest && Date.now() - oldest.queuedAt > this.replayBufferGraceMs) {
        this.abandonSession();
      }
    }, this.ACK_TIMEOUT);
  }

  async drain(): Promise<void> {
    return this.socket.drain();
  }

  dispose(): void {
    // 定时器必须显式清除（clearInterval），否则 dispose 后仍在空转——经典泄漏点。
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }
    if (this.ackCheckTimer) {
      clearInterval(this.ackCheckTimer);
    }
    // 再统一释放：订阅、五个事件源、底层 socket。
    this.disposables.dispose();
    this._onMessage.dispose();
    this._onClose.dispose();
    this._onSocketClose.dispose();
    this._onSaturated.dispose();
    this._onDrained.dispose();
    this.socket.dispose();
  }
}
