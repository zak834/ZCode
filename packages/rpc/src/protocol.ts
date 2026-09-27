/**
 * Layer 2: 传输协议抽象
 *
 * IMessagePassingProtocol 是整个 IPC 框架的"腰部"——
 * 它上面是 Channel RPC 层（完全传输无关），
 * 它下面是各种具体传输实现（Electron/MessagePort/Socket/ChildProcess）。
 *
 * 只要实现 send() 和 onMessage，就能接入整个 RPC 框架。
 */

import { VSBuffer } from "./buffer.js";
import { Event, Emitter, IDisposable, DisposableStore } from "./foundation.js";

// ============================================================================
// 核心传输接口
// ============================================================================

/**
 * IMessagePassingProtocol —— 整个框架的核心抽象
 *
 * 这就是 VS Code 通信能力的秘密：上层代码只看到 send/onMessage，
 * 不管底层是 Electron IPC、MessagePort、WebSocket 还是 TCP Socket。
 */
// 整个框架的"通用插座"：上层 RPC 逻辑只认这个接口，永远不直接碰 socket/IPC API。
// send：发一条二进制消息；onMessage：收到消息的事件（Event 已在 foundation.ts 讲过）。
// `drain?(): Promise<void>`：接口可选方法（同 channels.shared 的 ready?）——
// 语义是"把缓冲区里攒的数据真正发干净"，不是每种传输都支持。
export interface IMessagePassingProtocol {
  send(buffer: VSBuffer): void;
  readonly onMessage: Event<VSBuffer>;
  drain?(): Promise<void>;
}

/**
 * 连接级只读流控观察面。
 *
 * transport 负责维护未确认字节与状态边沿；业务层只能订阅，不能伪造 ACK 或直接改水位。
 */
// 拥塞观测契约：让上层知道"发出去的字节有多少还没被对端确认"，
// 以及水位饱和/回落两个事件——上层据此暂停/恢复发送（实现方见 persistent-protocol.ts）。
export interface ConnectionFlowControl {
  readonly unacknowledgedBytes: number;
  readonly onSaturated: Event<void>;
  readonly onDrained: Event<void>;
}

// 字符串字面量联合类型（第一次遇到）：这个类型的值**只能是**这两个字符串之一，
// 相当于只有两个成员的枚举，但不需要 enum——字符串本身就是值。
export type MessagePortFlowState = "saturated" | "drained";

// 流控控制消息的形状：一个带"暗号"字段 + 状态的小对象（暗号思路同 serialization 的嵌套二进制标记）。
export interface MessagePortFlowControl {
  __zcodeRpcControl: "connection-flow-v1";
  state: MessagePortFlowState;
}

// MessagePort 上可能到来的两种负载：真正的二进制数据，或上面的流控控制消息。
export type MessagePortPayload = Uint8Array | MessagePortFlowControl;

// 类型守卫（写法同 serialization.ts 的 isRpcEncodedUint8Array）：
// 返回 true 时 TS 就把 value 当作 MessagePortFlowControl。
// 校验三件事：恰好两个字段、暗号对得上、state 是两个合法值之一——防伪造。
function isMessagePortFlowControl(value: unknown): value is MessagePortFlowControl {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.__zcodeRpcControl === "connection-flow-v1" &&
    (record.state === "saturated" || record.state === "drained")
  );
}

// ============================================================================
// Socket 接口（用于 TCP/WebSocket 等流式传输）
// ============================================================================

/**
 * ISocket 抽象了底层的网络 socket。
 * 在 Node.js 环境是 net.Socket，在浏览器环境是 WebSocket。
 */
// `extends IDisposable`：接口也能继承接口——ISocket 在 dispose 之外再加以下成员。
// 三个事件：收到数据 / 对端关闭 / 对端发完；三个动作：写、结束、排空。
export interface ISocket extends IDisposable {
  onData: Event<VSBuffer>;
  onClose: Event<void>;
  onEnd: Event<void>;
  write(buffer: VSBuffer): void;
  end(): void;
  drain(): Promise<void>;
}

// ============================================================================
// ChunkStream —— 处理 TCP 的分片和粘包
// ============================================================================

/**
 * TCP 是流式协议，一次 write 不代表对面一次 read 就能完整收到。
 * ChunkStream 把收到的碎片攒起来，按需读取指定字节数。
 */
export class ChunkStream {
  // 攒下来的碎片队列（按到达顺序）；totalLength 缓存总字节数，免得每次都现算。
  private chunks: VSBuffer[] = [];
  private totalLength = 0;

  // getter（同 foundation 的用法）：当前缓冲区里有多少字节可读。
  get byteLength(): number {
    return this.totalLength;
  }

  // 传输层每收到一段数据就丢进来"攒着"，先不解析。
  acceptChunk(chunk: VSBuffer): void {
    this.chunks.push(chunk);
    this.totalLength += chunk.byteLength;
  }

  /**
   * 预览前 byteCount 字节，但不消费底层缓冲。
   *
   * Socket/stdio 传输天然可能分片。
   * 之前协议层在 body 还没收全时就先把 header read 掉，后续再来的 body
   * 会失去对应的帧头，导致消息永远卡住。这里提供 peek，让调用方先判断
   * “整帧是否已经到齐”，确认足够后再真正消费。
   */
  peek(byteCount: number): VSBuffer | null {
    // 字节不够 → 返回 null 表示"还没到齐"，但不消费任何数据（peek = 偷看）。
    if (this.totalLength < byteCount) {
      return null;
    }

    // 情形一：第一个碎片就够长——直接切出前 N 字节的副本。
    if (this.chunks[0].byteLength >= byteCount) {
      return this.chunks[0].slice(0, byteCount);
    }

    // 情形二：需要跨多个碎片拼出预览——分配目标大小，逐个碎片拷贝直到凑够。
    const result = VSBuffer.alloc(byteCount);
    let offset = 0;
    for (const chunk of this.chunks) {
      // 已凑够就提前退出循环。
      if (offset >= byteCount) {
        break;
      }

      // 这个碎片要么整个拷入，要么只拷需要的前半截（三元表达式二选一）。
      const remaining = byteCount - offset;
      const copyLength = Math.min(chunk.byteLength, remaining);
      result.set(copyLength === chunk.byteLength ? chunk : chunk.slice(0, copyLength), offset);
      offset += copyLength;
    }

    return result;
  }

  /** 丢弃前 byteCount 字节 */
  // 复用 read 的逻辑，只是把读到的数据扔掉。反引号模板字符串用于把变量拼进错误信息。
  skip(byteCount: number): void {
    const discarded = this.read(byteCount);
    if (!discarded) {
      throw new Error(`ChunkStream.skip(${byteCount}) 超出可读范围`);
    }
  }

  /** 读取 byteCount 字节，不够就返回 null */
  // 与 peek 的本质区别：read 会**消费**数据（读过的字节从缓冲区移除）。
  read(byteCount: number): VSBuffer | null {
    // 字节不够：返回 null，让调用方继续等下一批数据。
    if (this.totalLength < byteCount) {
      return null;
    }

    // 情形一：第一个碎片恰好等于要读的长度——整个移出队列即可。
    // `shift()!` 的 `!` 是非空断言（第一次遇到）：shift() 的返回类型是"元素 | undefined"，
    // 但上面已确认长度足够，这里向编译器担保"绝不是 undefined"，免去层层判空。
    if (this.chunks[0].byteLength === byteCount) {
      const result = this.chunks.shift()!;
      this.totalLength -= byteCount;
      return result;
    }

    // 情形二：第一个碎片比要读的长——切下前半截返回，剩余部分留回队列头部。
    if (this.chunks[0].byteLength > byteCount) {
      const result = this.chunks[0].slice(0, byteCount);
      this.chunks[0] = this.chunks[0].slice(byteCount);
      this.totalLength -= byteCount;
      return result;
    }

    // 需要跨多个 chunk 拼接
    // 情形三：循环搬运——碎片够长就整个用掉（shift 移出队列），不够长就用掉它的剩余部分。
    const result = VSBuffer.alloc(byteCount);
    let offset = 0;
    while (offset < byteCount) {
      const chunk = this.chunks[0];
      const needed = byteCount - offset;
      if (chunk.byteLength <= needed) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
        this.chunks.shift();
      } else {
        result.set(chunk.slice(0, needed), offset);
        this.chunks[0] = chunk.slice(needed);
        offset += needed;
      }
    }
    this.totalLength -= byteCount;
    return result;
  }
}

// ============================================================================
// Protocol —— 在 ISocket 上实现 IMessagePassingProtocol
// ============================================================================

/**
 * 消息帧格式 (13 bytes header):
 *
 * ┌─────────┬──────────┬──────────┬──────────────┐
 * │ type(1) │  id(4)   │  ack(4)  │  length(4)   │
 * └─────────┴──────────┴──────────┴──────────────┘
 *
 * type:   消息类型（Regular, Ack, KeepAlive 等）
 * id:     消息序号
 * ack:    确认号（告诉对方"我已收到你的消息到第 ack 号"）
 * length: payload 长度
 */
export enum ProtocolMessageType {
  // 各帧类型：Regular 普通数据帧；Ack 纯确认帧；Disconnect 对端要求断开；
  // ReplayRequest 断线重连后请求重放；Pause/Resume 流控暂停/恢复；KeepAlive 心跳。
  // 这些数字写进网络字节流，两端必须一致。
  None = 0,
  Regular = 1,
  Control = 2,
  Ack = 3,
  Disconnect = 5,
  ReplayRequest = 6,
  Pause = 7,
  Resume = 8,
  KeepAlive = 9,
}

// 帧头的固定长度。给常量起名而不是到处写魔法数字 13。
export const HEADER_SIZE = 13; // 1 + 4 + 4 + 4

// 一条消息的内存表示：帧头四件套 + 负载。
// 构造函数参数属性（同 serialization 的 BufferReader，简写形式），
// 且叠加 readonly：四个字段只能在构造时赋值，之后任何人不可改——消息是不可变的。
export class ProtocolMessage {
  constructor(
    public readonly type: ProtocolMessageType,
    public readonly id: number,
    public readonly ack: number,
    public readonly data: VSBuffer,
  ) {}

  // 整帧在线路上的字节数 = 13 字节帧头 + 负载。
  get byteLength(): number {
    return HEADER_SIZE + this.data.byteLength;
  }
}

// 序列化一帧：按 13 字节帧头图逐字段写入（大端序读写已在 buffer.ts 讲过）。
// 偏移量 0/1/5/9 与帧头图一一对应：type 占 1 字节，id/ack/length 各占 4 字节。
export function writeProtocolMessage(msg: ProtocolMessage): VSBuffer {
  const result = VSBuffer.alloc(HEADER_SIZE + msg.data.byteLength);
  result.writeUInt8(msg.type, 0);
  result.writeUInt32BE(msg.id, 1);
  result.writeUInt32BE(msg.ack, 5);
  result.writeUInt32BE(msg.data.byteLength, 9);
  // 负载紧跟在 13 字节帧头之后。
  result.set(msg.data, HEADER_SIZE);
  return result;
}

/**
 * 基础 Protocol: 在 ISocket 上加消息帧，实现 IMessagePassingProtocol。
 * 只做消息分帧，不做 ACK/重连（那是 PersistentProtocol 的事）。
 */
// 在流式 socket 之上"加帧"：把字节流变成一条条消息（_onXxx 下划线前缀是私有事件源的命名惯例）。
export class SocketProtocol implements IMessagePassingProtocol {
  private readonly _onMessage = new Emitter<VSBuffer>();
  // 对外暴露的是订阅入口（emitter.event），内部发射器保持私有。
  readonly onMessage = this._onMessage.event;

  private readonly chunkStream = new ChunkStream();
  // 所有子资源（事件订阅）集中到 store，dispose 时一键清理——VS Code 的标准姿势。
  private readonly disposables = new DisposableStore();

  constructor(private socket: ISocket) {
    // 收到数据：先攒进 ChunkStream，再尝试解帧（构造时即订阅，退订句柄交给 store 管理）。
    this.disposables.add(
      socket.onData((data) => {
        this.chunkStream.acceptChunk(data);
        this.readMessages();
      }),
    );
  }

  // 对外只有一个动作：send。本层只发普通数据帧（id/ack 是 PersistentProtocol 的事，这里填 0）。
  send(buffer: VSBuffer): void {
    this.writeMessage(new ProtocolMessage(ProtocolMessageType.Regular, 0, 0, buffer));
  }

  // 把内存里的消息序列化成帧并写入 socket。
  private writeMessage(msg: ProtocolMessage): void {
    this.socket.write(writeProtocolMessage(msg));
  }

  // 解帧循环：缓冲区里可能攒了好几条完整消息，while 一次全解出来。
  private readMessages(): void {
    while (true) {
      // 偷看 13 字节帧头（不消费！）。不够 13 字节说明连帧头都没到齐，等下一批。
      const header = this.chunkStream.peek(HEADER_SIZE);
      if (!header) {
        break;
      }

      // 按帧头图解析四个字段。`as ProtocolMessageType` 是枚举断言（第一次遇到）：
      // 读出来的是 number，TS 不会自动把它当枚举——我们向编译器担保它是合法枚举值。
      // _id/_ack 的下划线前缀表示"解析出来但本层不用"（ACK 归 PersistentProtocol 管）。
      const type = header.readUInt8(0) as ProtocolMessageType;
      const _id = header.readUInt32BE(1);
      const _ack = header.readUInt32BE(5);
      const length = header.readUInt32BE(9);

      const totalFrameLength = HEADER_SIZE + length;
      if (this.chunkStream.byteLength < totalFrameLength) {
        // 不能在 body 未到齐时提前消费 header，否则下一段数据拼上来后
        // 已经找不到这帧的长度信息，调用方就会一直等待一个永远不会完成的 Promise。
        break;
      }

      // 整帧确认到齐：这才真正丢弃帧头（peek → skip 两步走的必要性所在）。
      this.chunkStream.skip(HEADER_SIZE);

      // 零长度帧：没有 body。只有 Regular 类型向上抛一条空消息，其余类型直接跳过。
      if (length === 0) {
        if (type === ProtocolMessageType.Regular) {
          this._onMessage.fire(VSBuffer.alloc(0));
        }
        continue;
      }

      const body = this.chunkStream.read(length);
      if (!body) {
        throw new Error("SocketProtocol 读取到完整帧长度后 body 不应为空");
      }

      // 只有 Regular 帧携带业务数据才对上层发射；其他类型本层不认识也不转发。
      if (type === ProtocolMessageType.Regular) {
        this._onMessage.fire(body);
      }
    }
  }

  // async 标记异步函数（第一次遇到）：函数内可用 await；这里只是透传 socket 的排空 Promise。
  async drain(): Promise<void> {
    return this.socket.drain();
  }

  dispose(): void {
    // 先释放子资源订阅，再释放自己的事件发射器。
    this.disposables.dispose();
    this._onMessage.dispose();
  }
}

// ============================================================================
// QueueProtocol —— 内存中的协议对，用于测试
// ============================================================================

/**
 * 创建一对通过内存队列连接的 protocol，
 * 一端 send 的消息会出现在另一端的 onMessage。
 * 非常适合单元测试，不需要真正的网络连接。
 */
// 返回类型 `[A, B]` 是元组类型（第一次遇到）：定长数组，第 0 个是 A、第 1 个是 B，
// 比普通数组类型多携带"位置"信息（解构时两个变量的类型各自正确）。
export function createQueuePair(): [IMessagePassingProtocol, IMessagePassingProtocol] {
  const emitterA = new Emitter<VSBuffer>();
  const emitterB = new Emitter<VSBuffer>();

  // 注意：这里没有 class——直接用对象字面量"实现"接口。
  // 这叫结构化类型（structural typing）：只要对象具备接口要求的成员，就算实现，
  // 不需要任何"继承声明"——这是 TS 与 Java/C# 等名义类型语言最大的区别之一。
  const protocolA: IMessagePassingProtocol = {
    send: (buffer: VSBuffer) => {
      // A 发送的消息 → B 收到
      // setTimeout(fn, 0)（第一次遇到）：0 毫秒后执行 = "下一个宏任务"再投递，
      // 模拟真实网络"发送不会同步到达"的异步性。
      setTimeout(() => emitterB.fire(buffer), 0);
    },
    onMessage: emitterA.event,
  };

  const protocolB: IMessagePassingProtocol = {
    send: (buffer: VSBuffer) => {
      // B 发送的消息 → A 收到
      setTimeout(() => emitterA.fire(buffer), 0);
    },
    onMessage: emitterB.event,
  };

  return [protocolA, protocolB];
}

// ============================================================================
// MessagePort Protocol —— 用于 Web Worker / Electron sandbox
// ============================================================================

/**
 * MessagePort 接口的最小声明，
 * 使得这个 Protocol 可以同时在浏览器和 Electron 中使用。
 */
export interface MessagePortLike {
  // 注意参数 type 的类型是字面量 "message"：只允许传这一个字符串——
  // 接口把"本对象只处理 message 事件"写进了类型里，传错事件名编译期就报错。
  addEventListener(type: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  removeEventListener(type: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  postMessage(message: MessagePortPayload): void;
  start(): void;
  close(): void;
}

/**
 * 在 MessagePort 上实现 IMessagePassingProtocol。
 * 这是最简单的传输实现——不需要分帧，因为 MessagePort 本身就是消息边界的。
 */
// MessagePort 版协议实现。与 SocketProtocol 的本质区别：
// MessagePort 本身按"条"投递（消息边界天然存在），所以**不需要分帧**。
export class MessagePortProtocol implements IMessagePassingProtocol {
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage = this._onMessage.event;
  // 第二个事件通道：专发流控状态变化（上层订阅后决定暂停/恢复发送）。
  private readonly _onFlowState = new Emitter<MessagePortFlowState>();
  readonly onFlowState = this._onFlowState.event;

  // 先声明 handler 字段的类型：disconnect 时还要用它退订，必须保存函数引用。
  private readonly handler: (e: { data: MessagePortPayload }) => void;

  constructor(private port: MessagePortLike) {
    this.handler = (e: { data: MessagePortPayload }) => {
      // 先看是不是流控控制消息：是就转给流控事件，不进 RPC 数据通道。
      if (isMessagePortFlowControl(e.data)) {
        this._onFlowState.fire(e.data.state);
        return;
      }
      // MessagePort control object 不能进入 Channel deserialize；未知对象和伪造
      // connection-flow-v1 一律丢弃，只有真实 Uint8Array 才是 RPC binary。
      if (e.data instanceof Uint8Array) this._onMessage.fire(VSBuffer.wrap(e.data));
    };
    this.port.addEventListener("message", this.handler);
    // MessagePort 规范要求显式 start 之后才开始收消息。
    this.port.start();
  }

  send(buffer: VSBuffer): void {
    // postMessage 整条直接投递（注意传的是底层 Uint8Array，不是 VSBuffer 包装）。
    this.port.postMessage(buffer.buffer);
  }

  // 主动发一条流控控制消息给对端（告诉它"我这边饱和了/恢复了"）。
  sendFlowState(state: MessagePortFlowState): void {
    this.port.postMessage({ __zcodeRpcControl: "connection-flow-v1", state });
  }

  disconnect(): void {
    // MessagePort 版的收尾：退订 → 关端口 → 释放两个发射器。
    this.port.removeEventListener("message", this.handler);
    this.port.close();
    this._onMessage.dispose();
    this._onFlowState.dispose();
  }
}
