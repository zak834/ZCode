import { VSBuffer } from "./buffer.js";
import { CancellationToken, Event, Emitter, type IDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannel,
  type IChannelClient,
  type IHandler,
  type IRawResponse,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

// 客户端状态机：枚举不写值时自动从 0 开始编号（Uninitialized=0, Idle=1）。
// Uninitialized：还没收到服务端的 Initialize 应答；Idle：握手完成，可正常发请求。
enum State {
  Uninitialized,
  Idle,
}

// RPC 客户端核心：把 call/listen 翻译成二进制请求，并把响应按 id 分发回去。
export class ChannelClient implements IChannelClient, IDisposable {
  private state = State.Uninitialized;
  private isDisposed = false;
  // 当前活跃的请求/订阅（存各自的退订句柄），dispose 时统一清理。
  private activeRequests = new Set<IDisposable>();
  // 请求 id → 响应处理函数。响应回来后按 id 对号入座（Map = 键值对集合）。
  private handlers = new Map<number, IHandler>();
  // Promise 请求和事件监听共用 handlers，但只有前者需要在连接终结时 reject。
  // 单独维护 reject map，避免 dispose 把事件订阅误当成挂起的 RPC 请求。
  private pendingRejections = new Map<number, (error: Error) => void>();
  // 请求 id 发号器：每发一个请求自增，保证唯一。
  private lastRequestId = 0;
  // 挂在协议上的响应监听句柄（dispose 时要退订）；`| null` 表示"可能还没有"。
  private protocolListener: IDisposable | null;

  private readonly _onDidInitialize = new Emitter<void>();
  readonly onDidInitialize = this._onDidInitialize.event;

  constructor(private protocol: IMessagePassingProtocol) {
    // 构造即开始监听协议层：收到的每条二进制消息都交给 onBuffer 解析分发。
    // 退订句柄必须存起来——析构后若还被调用就是释放后使用（use-after-dispose）。
    this.protocolListener = this.protocol.onMessage((msg) => this.onBuffer(msg));
  }

  // 实现 IChannelClient 契约：按名字领一个通道。
  // 返回的同样是 `as T` 代理对象（同 delayedChannel 的写法）——
  // call/listen 是箭头函数，闭包把 channelName 记住，之后调用无须再传。
  getChannel<T extends IChannel>(channelName: string): T {
    return {
      call: (command: string, arg?: any, cancellationToken?: CancellationToken) => {
        // 已释放的客户端不能再发请求：立即返回"已失败"的 Promise。
        // Promise.reject(x)：造一个以 x 为失败原因、立刻失败的 Promise。
        if (this.isDisposed) {
          return Promise.reject(new Error("ChannelClient is disposed"));
        }
        return this.requestPromise(channelName, command, arg, cancellationToken);
      },
      listen: (event: string, arg?: any) => {
        // 已释放时返回"永远不触发"的事件（Event.None），订阅它无害。
        if (this.isDisposed) {
          return Event.None;
        }
        return this.requestEvent(channelName, event, arg);
      },
    } as T;
  }

  // 发起一次"调用远程方法"请求。本方法最能体现 Promise 与闭包的配合，值得慢读。
  private requestPromise(
    channelName: string,
    name: string,
    arg?: any,
    // 参数默认值：没传取消令牌就用"永不取消"的 None。
    cancellationToken = CancellationToken.None,
  ): Promise<any> {
    // 领请求号：之后所有响应都靠这个 id 找回对应的 Promise。
    const id = this.lastRequestId++;

    // 发起前就已取消？直接失败，连发都不发。
    if (cancellationToken.isCancellationRequested) {
      return Promise.reject(new Error("Cancelled"));
    }

    let disposable: IDisposable | undefined;
    // Promise 执行器（第一次系统讲）：new Promise((resolve, reject) => {...})
    // 传入的两个回调由 Promise 机制提供——调用 resolve(值) 这个 Promise 就成功，
    // 调用 reject(原因) 就失败。执行器本身同步执行，但结果可以之后再交。
    // 下面的代码靠闭包把 id、resolve、reject 全"记住"，供异步到达的响应使用。
    const result = new Promise<any>((resolve, reject) => {
      // 把 reject 登记进 map：dispose 这类"外部力量"日后能直接让本请求失败。
      this.pendingRejections.set(id, reject);
      // doRequest：真正发请求的动作。抽成函数是因为可能要"等握手完成后再执行"。
      const doRequest = () => {
        // dispose/cancel 可能发生在 Initialize 之前；此时不能再把已经 rejected
        // 的请求发送到新连接或已终结的传输上。
        if (this.isDisposed || !this.pendingRejections.has(id)) {
          return;
        }

        // 响应处理器：按可辨识联合的 type 分派（channels.shared 讲过的收窄技巧）。
        const handler: IHandler = (response) => {
          switch (response.type) {
            case ResponseType.PromiseSuccess:
              // 成功：先清理两处登记（本请求已完结），再把数据交给 resolve。
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              resolve(response.data);
              return;
            case ResponseType.PromiseError: {
              // 失败：对端传来的是"拍扁的字段包"，这里要重建成一个真 Error 对象。
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              // `as Error & Record<string, unknown>` 交叉类型断言（第一次遇到交叉类型）：
              // `A & B` 表示"既是 A 又是 B"。Error 天生没有 code/retryAfterMs 这类自定义
              // 字段，交叉一个"任意字符串键"的字典类型后，才能往 error 上挂这些字段。
              const error = new Error(response.data.message) as Error & Record<string, unknown>;
              error.name = response.data.name;
              // 对端把堆栈按行拆成了数组（序列化友好），这里拼回多行文本。
              if (response.data.stack) {
                error.stack = response.data.stack.join("\n");
              }
              // `as const`（第一次遇到）：把数组冻结成"只读字面量元组"——
              // 每个元素的类型都是具体的字符串字面量，后面 for...of 时 key 类型精确可用。
              const passthroughKeys = [
                "code",
                "kind",
                "status",
                "retryAfterMs",
                "data",
                "detail",
                "details",
                "taskId",
                "traceId",
              ] as const;
              // 白名单透传：这些业务字段（错误码/重试间隔/链路 id...）原样挂回 Error，
              // 上层代码就能 error.retryAfterMs 这样直接读取。
              for (const key of passthroughKeys) {
                const value = response.data[key];
                if (value !== undefined) {
                  error[key] = value;
                }
              }
              reject(error);
              return;
            }
            case ResponseType.PromiseErrorObj:
              // 透传形态的失败：对端的原始错误对象直接作为失败原因。
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              reject(response.data);
              return;
          }
        };

        // 登记"这个 id 由我处理"，然后正式发出请求帧。
        this.handlers.set(id, handler);
        this.sendRequest(RequestType.Promise, id, channelName, name, arg);
      };

      // 关键分支：握手已完成就立刻发；没完成就等 Initialize 事件再发。
      // doRequest 是闭包——真正执行时仍记得自己的 id/handler，延迟执行也不会乱。
      if (this.state === State.Idle) {
        doRequest();
      } else {
        this.whenInitialized().then(doRequest);
      }

      // 挂上取消监听：令牌一触发就通知对端取消，并让本端 Promise 立即失败。
      disposable = cancellationToken.onCancellationRequested(() => {
        // 已完结（成功/失败/取消过）的请求不重复处理。
        if (!this.pendingRejections.has(id)) {
          return;
        }
        this.sendCancelOrDispose(RequestType.PromiseCancel, id);
        this.handlers.delete(id);
        this.pendingRejections.delete(id);
        reject(new Error("Cancelled"));
      });
      // 取消监听本身也是资源，登记进活跃集合，dispose 时统一释放。
      this.activeRequests.add(disposable);
    });

    // finally（第一次遇到）：无论成功失败都会执行的收尾——退订取消监听、移出活跃集合。
    // `?.` 在这里防 disposable 尚未赋值的边缘情况。
    return result.finally(() => {
      disposable?.dispose();
      if (disposable) {
        this.activeRequests.delete(disposable);
      }
    });
  }

  // 订阅远程事件。妙处在于利用 foundation 的"懒订阅"钩子：
  // 第一个监听者出现才发 EventListen、最后一个离开就发 EventDispose——
  // 没人听的时候，网络上不会有这个事件的任何流量。
  private requestEvent(channelName: string, name: string, arg?: any): Event<any> {
    const id = this.lastRequestId++;
    const emitter = new Emitter<any>({
      // 第一个订阅者到来：真正向服务端发起订阅（同样处理"等握手"分支）。
      onWillAddFirstListener: () => {
        const doRequest = () => {
          // emitter 自己就是这份订阅的"句柄"（dispose 它 = 退订），存入活跃集合。
          this.activeRequests.add(emitter);
          this.sendRequest(RequestType.EventListen, id, channelName, name, arg);
        };

        if (this.state === State.Idle) {
          doRequest();
        } else {
          this.whenInitialized().then(doRequest);
        }
      },
      // 最后一个订阅者离开：通知服务端退订并清理本端登记。
      onDidRemoveLastListener: () => {
        this.activeRequests.delete(emitter);
        this.sendCancelOrDispose(RequestType.EventDispose, id);
        this.handlers.delete(id);
      },
    });

    // 事件响应的处理：EventFire 帧到达时把数据灌进发射器，各监听者即被调用。
    // `(response as { data: any })`：IRawResponse 联合里只有部分成员带 data 字段，
    // 这里断言"本分支拿到的就是带 data 的那种"——运行时由服务端协议保证。
    this.handlers.set(id, (response) => {
      emitter.fire((response as { data: any }).data);
    });

    // 返回同步的订阅入口。
    return emitter.event;
  }

  // 把请求序列化成"头 + 体"两段并发送。
  // 头是数组 [类型, id, 通道名, 方法名]（serialize 会逐元素加类型标签），
  // 体是参数本身（可以是任意可序列化的值）。
  private sendRequest(
    type: RequestType,
    id: number,
    channelName: string,
    name: string,
    arg?: any,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id, channelName, name]);
    serialize(writer, arg);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      // 吞掉发送异常（noop = 无操作）：传输刚断时 send 可能抛错，
      // 与其在这里炸掉调用方，不如让 dispose/onSocketClose 的既有流程去收尾。
      /* noop */
    }
  }

  // 取消请求 / 退订事件共用一个格式：[类型, id] + 空参数体。
  // 参数类型用 `|` 联合限定：本方法只接受这两种请求类型，传别的编译期就报错。
  private sendCancelOrDispose(
    type: RequestType.PromiseCancel | RequestType.EventDispose,
    id: number,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id]);
    serialize(writer, undefined);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  // 协议层的每条消息从这里进来：按发送方的镜像格式拆出头和体。
  private onBuffer(message: VSBuffer): void {
    const reader = new BufferReader(message);
    // 头是数组 [类型, id]（Initialize 只有 [类型]），体是数据。
    const header = deserialize(reader);
    const body = deserialize(reader);
    // 枚举断言（同 protocol.ts）：数组第 0 项就是响应类型。
    const type = header[0] as ResponseType;

    switch (type) {
      case ResponseType.Initialize:
        // 握手应答没有 id。
        this.onResponse({ type: ResponseType.Initialize });
        return;
      // TS 语法：多个 case 落在一起 = 这四种类型走同一段代码（类似 `||`）。
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.PromiseErrorObj:
        // 按可辨识联合的形状组装，交给 onResponse 按 id 分发。
        this.onResponse({
          type,
          id: header[1],
          data: body,
        } as IRawResponse);
        return;
    }
  }

  // 响应分发中心。
  private onResponse(response: IRawResponse): void {
    // 握手应答：状态机进入 Idle，并广播"已初始化"——所有排队的请求因此放行。
    if (response.type === ResponseType.Initialize) {
      this.state = State.Idle;
      this._onDidInitialize.fire();
      return;
    }

    // 其余响应：按 id 领出处理函数并调用。
    // `?.()` 可选调用（第一次遇到这种形态）：Map.get 可能返回 undefined，
    // 直接写 fn() 会崩；写成 fn?.() 则"有就调用、没有就安静跳过"。
    this.handlers.get(response.id)?.(response);
  }

  // "等握手完成"的统一入口：已完成立即返回成功 Promise；否则等下一次 Initialize 事件。
  private whenInitialized(): Promise<void> {
    if (this.state === State.Idle) {
      // Promise.resolve()：一个立即成功的 Promise。
      return Promise.resolve();
    }
    return Event.toPromise(this.onDidInitialize);
  }

  // 释放客户端：连接没了，所有挂起的请求必须"体面地失败"，而不是永远悬着。
  dispose(reason?: Error): void {
    // 幂等：重复 dispose 无害。
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    // 先退订协议层，之后到达的消息不再处理。
    this.protocolListener?.dispose();
    this.protocolListener = null;

    // `??`：调用方没给原因就用默认的；并把无原因场景命名为 ConnectionClosed，
    // 上层可按名字区分"正常关闭"与"带错误断开"。
    const rejection = reason ?? new Error("ChannelClient disposed");
    if (!reason) {
      rejection.name = "ConnectionClosed";
    }
    // 传输已终结时，所有已发出以及排队等待 Initialize 的 Promise 请求都必须
    // fail-closed。否则上层的 in-flight 去重 Promise 会永久占用 workspace key。
    // for...of 解构遍历 Map：[id, reject] 一次取出键和值。
    for (const [id, reject] of this.pendingRejections) {
      this.pendingRejections.delete(id);
      this.handlers.delete(id);
      reject(rejection);
    }
    // 逐个释放活跃请求（触发各自的取消逻辑）。
    for (const disposable of this.activeRequests) {
      disposable.dispose();
    }
    this.activeRequests.clear();
    this.pendingRejections.clear();
    this._onDidInitialize.dispose();
  }
}
