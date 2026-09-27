// ── ChannelServer：RPC 服务端核心 ───────────────────────────────
// ChannelClient 的镜像：收到请求帧 → 找到对应通道 → 调用真正的实现 → 把结果序列化回去。
// 与客户端最大的不同：服务端多管一件事——"请求先于通道注册到达"怎么办？
// 答案是把请求先"停车"（pendingRequests），通道注册到位后再放行（见 flushPendingRequests）。
import { VSBuffer } from "./buffer.js";
import { type IDisposable, CancellationTokenSource, toDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannelServer,
  type IRawResponse,
  type IServerChannel,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

// 泛型 TContext（同 IServerChannel）：调用方身份的类型，由创建方决定。
export class ChannelServer<TContext = string> implements IChannelServer<TContext>, IDisposable {
  // 已注册的通道：名字 → 实现。
  private channels = new Map<string, IServerChannel<TContext>>();
  // 进行中的请求：请求 id → 退订/取消句柄（客户端发 Cancel 时按 id 找到它）。
  private activeRequests = new Map<number, IDisposable>();
  // "停车场"：通道还没注册就到达的请求，按通道名分组暂存；
  // 每条还带一个超时定时器（等太久就报错）。数组套对象的类型写法细看一眼。
  private pendingRequests = new Map<
    string,
    { request: any; timer: ReturnType<typeof setTimeout> }[]
  >();
  private protocolListener: IDisposable | null;

  // 四个参数属性简写一次到位；timeoutDelay/deferInit 带默认值，调用方可省略。
  constructor(
    private protocol: IMessagePassingProtocol,
    private ctx: TContext,
    private timeoutDelay = 1000,
    private deferInit = false,
  ) {
    // 构造即监听请求帧。
    this.protocolListener = this.protocol.onMessage((msg) => this.onRawMessage(msg));
    // 握手应答：默认立即告诉客户端"我好了"；deferInit=true 则等 ready() 被显式调用
    // （给"通道还没注册完"的场景留时间——客户端在 Initialize 之前会把请求排队等待）。
    if (!this.deferInit) {
      this.sendResponse({ type: ResponseType.Initialize });
    }
  }

  // deferInit 模式下由外部在准备就绪后手动触发握手。
  ready(): void {
    this.sendResponse({ type: ResponseType.Initialize });
  }

  // 注册通道：登记后用 setTimeout(…, 0) 把"停车"的请求**下一个宏任务**再放行——
  // 保证同步注册流程先走完，也允许一口气注册多条通道后再统一 flush。
  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);
    setTimeout(() => this.flushPendingRequests(channelName), 0);
  }

  // 把"响应对象"翻译成线路格式：Initialize 只有头；其余 = 头[类型, id] + 体[数据]。
  private sendResponse(response: IRawResponse): void {
    switch (response.type) {
      case ResponseType.Initialize:
        this.send([response.type]);
        return;
      // 四种带 id 的响应共用一条发送路径。
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.PromiseErrorObj:
        this.send([response.type, response.id], response.data);
        return;
    }
  }

  // 与客户端的 sendRequest 完全对称：序列化头、体两段后发送，异常同样静默。
  // `body: any = undefined`：不传体时序列化 undefined（对方解出来就是 undefined）。
  private send(header: any, body: any = undefined): void {
    const writer = new BufferWriter();
    serialize(writer, header);
    serialize(writer, body);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  // 请求帧入口：拆出头/体，头 = [类型, id, 通道名, 方法名]。
  private onRawMessage(message: VSBuffer): void {
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const body = deserialize(reader);
    const type = header[0] as RequestType;

    switch (type) {
      // 两种"要做事"的请求：把数组头整理成具名字段对象再分发（对象字面量即装即用）。
      case RequestType.Promise:
        this.onPromise({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: body,
        });
        return;
      case RequestType.EventListen:
        this.onEventListen({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: body,
        });
        return;
      // 取消/退订：按 id 找到活跃请求直接销毁（两种类型共用一段代码）。
      case RequestType.PromiseCancel:
      case RequestType.EventDispose:
        this.disposeActiveRequest(header[1]);
        return;
    }
  }

  // 参数类型是内联对象类型（第一次遇到内联写法）：类型直接写在参数位置，不必先起名字。
  private onPromise(request: {
    type: RequestType.Promise;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    // 通道还没注册？把请求停进停车场，等 flush。
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    // 每个请求配一个取消令牌源：客户端发 Cancel 时我们能取消正在执行的方法。
    const cts = new CancellationTokenSource();
    let promise: Promise<any>;

    // channel.call 若同步抛异常（比如方法实现第一行就 throw），
    // 捕获后转成失败的 Promise——统一走下面的异步错误路径。
    try {
      promise = channel.call(this.ctx, request.name, request.arg, cts.token);
    } catch (error) {
      promise = Promise.reject(error);
    }

    // 登记"取消句柄"：toDisposable 把 cts.cancel 包装成标准资源句柄——
    // 客户端发 PromiseCancel 时 disposeActiveRequest 会调它，令牌触发、方法内部自行中断。
    const disposable = toDisposable(() => cts.cancel());
    this.activeRequests.set(request.id, disposable);

    // `.then(成功回调, 失败回调)` 双参形式（第一次遇到）：两个回调分别接住两种结局。
    promise
      .then(
        (data) => {
          // 成功：把结果按请求 id 发回去。
          this.sendResponse({
            id: request.id,
            data,
            type: ResponseType.PromiseSuccess,
          });
        },
        (error) => {
          // Error 是类实例 → 先拍扁成纯字段包再发（Error 上的方法/堆栈过不了序列化）。
          // 内联对象类型注解：给 payload 的形状上"临时户口"，逐字段约束。
          if (error instanceof Error) {
            const rpcErrorPayload: {
              message: string;
              name: string;
              stack: string[] | undefined;
              code?: unknown;
              kind?: unknown;
              status?: unknown;
              retryAfterMs?: unknown;
              data?: unknown;
              detail?: unknown;
              details?: unknown;
              taskId?: unknown;
              traceId?: unknown;
            } = {
              message: error.message,
              name: error.name,
              // 堆栈按行拆成数组（客户端会再拼回来）；三元表达式处理无堆栈的情况。
              stack: error.stack ? error.stack.split("\n") : undefined,
            };
            // 交叉类型断言（同 channelClient）：为了读取 Error 上的自定义业务字段。
            const errorRecord = error as Error & Record<string, unknown>;
            // 白名单透传（客户端侧是收，这里是发——两端字段一一对应）。
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
            for (const key of passthroughKeys) {
              const value = errorRecord[key];
              if (value !== undefined) {
                rpcErrorPayload[key] = value;
              }
            }
            // 结构化失败：PromiseError。
            this.sendResponse({
              id: request.id,
              data: rpcErrorPayload,
              type: ResponseType.PromiseError,
            });
            return;
          }

          // 不是 Error 实例的异常值（比如直接 throw 个字符串）→ 原样透传。
          this.sendResponse({
            id: request.id,
            data: error,
            type: ResponseType.PromiseErrorObj,
          });
        },
      )
      // 请求完结（无论成败）：释放取消句柄、从活跃表移除——不留悬挂条目。
      .finally(() => {
        disposable.dispose();
        this.activeRequests.delete(request.id);
      });
  }

  private onEventListen(request: {
    type: RequestType.EventListen;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    // 同样先查通道，没注册就停车。
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    // channel.listen(...) 返回订阅入口（Event），紧接着再调一次完成订阅——链式两段调用。
    // 每次事件触发 → 立刻以 EventFire 帧按 id 发给客户端。
    const disposable = channel.listen(
      this.ctx,
      request.name,
      request.arg,
    )((data) => {
      this.sendResponse({
        id: request.id,
        data,
        type: ResponseType.EventFire,
      });
    });
    // 订阅句柄登记：客户端发 EventDispose 时用它退订。
    this.activeRequests.set(request.id, disposable);
  }

  // 销毁一个进行中的请求（令牌取消 / 事件退订）：没有就直接返回。
  private disposeActiveRequest(id: number): void {
    const disposable = this.activeRequests.get(id);
    if (!disposable) {
      return;
    }
    disposable.dispose();
    this.activeRequests.delete(id);
  }

  // "停车"：通道未注册时先暂存请求，并挂一个超时定时器兜底。
  private collectPendingRequest(request: any): void {
    // `?? []`：这个通道还没有停车队列就建一个空数组。
    const pendingRequests = this.pendingRequests.get(request.channelName) ?? [];
    if (pendingRequests.length === 0) {
      this.pendingRequests.set(request.channelName, pendingRequests);
    }

    // 超时兜底：等 timeoutDelay 毫秒通道还没来就报错——Promise 请求还要回一条
    // 失败响应（否则客户端的 Promise 永远悬着）；事件订阅无法"失败"，只记错误日志。
    const timer = setTimeout(() => {
      console.error(`Unknown channel: ${request.channelName}`);
      if (request.type !== RequestType.Promise) {
        return;
      }

      this.sendResponse({
        id: request.id,
        data: {
          name: "Unknown channel",
          message: `Channel name '${request.channelName}' timed out after ${this.timeoutDelay}ms`,
          stack: undefined,
        },
        type: ResponseType.PromiseError,
      });
    }, this.timeoutDelay);

    pendingRequests.push({ request, timer });
  }

  // 通道注册好了，放行停车场的请求：撤掉超时定时器，按类型重新走正常分发。
  private flushPendingRequests(channelName: string): void {
    const requests = this.pendingRequests.get(channelName);
    if (!requests) {
      return;
    }

    // for...of + 解构：一次取出每个暂停条目的 request 和 timer 两个字段。
    for (const { request, timer } of requests) {
      // 赶在超时触发之前撤销定时器。
      clearTimeout(timer);
      switch (request.type) {
        case RequestType.Promise:
          this.onPromise(request);
          break;
        case RequestType.EventListen:
          this.onEventListen(request);
          break;
      }
    }
    // 放行完毕，清掉这个通道的队列。
    this.pendingRequests.delete(channelName);
  }

  dispose(): void {
    // 退订协议层 + 逐个取消进行中的请求 + 清空登记。
    // 注意：dispose 不清理停车场——各条目自己的超时定时器会稍后触发兜底逻辑。
    this.protocolListener?.dispose();
    this.protocolListener = null;
    // Map.values() 只取值的迭代器：这里句柄才是要释放的东西。
    for (const disposable of this.activeRequests.values()) {
      disposable.dispose();
    }
    this.activeRequests.clear();
  }
}
