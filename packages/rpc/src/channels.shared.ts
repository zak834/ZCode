// ── 通道（Channel）机制的共享契约 ────────────────────────────────────
// 本文件定义 RPC 双方共同遵守的接口与协议常量，客户端和服务端都要 import 它。
// "通道"是 RPC 之上的业务分组：一条连接里可以开多条命名通道
// （如"文件系统通道""终端通道"），每条通道暴露若干命令（call）和事件（listen）。
//
// `import type`（第一次遇到）：只导入类型、不导入运行时代码，
// 编译后这行会整个消失——纯类型导入不给打包产物增加任何体积。
import type { CancellationToken, Event } from "./foundation.js";

// 客户端视角的通道契约：我能"调用命令"和"订阅事件"。
export interface IChannel {
  // 泛型方法：调用方用 call<number>(...) 指定返回值类型，拿到 Promise<number>。
  // Promise 代表"未来才有结果"——远程调用天然是异步的。
  // cancellationToken：可选的取消令牌（见 foundation.ts），不打算取消就不传。
  call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T>;
  // 订阅服务端事件：返回 Event<T>（同步的订阅入口）而非 Promise——
  // 事件可能触发多次，没有"完成"的概念。
  listen<T>(event: string, arg?: any): Event<T>;
}

// 服务端视角的通道契约：比客户端多一个 ctx（上下文）参数。
// `<TContext = string>` 是泛型默认值（第一次遇到）：使用时不指定 TContext 就自动是 string。
// ctx 用来区分"是哪个客户端在调用"，具体类型由传输实现决定
// （本地 IPC 可能是字符串端口名，远程连接可能是连接标识对象）。
export interface IServerChannel<TContext = string> {
  // 与 IChannel.call 相比只多了 ctx——服务端需要知道"谁在叫我"。
  call<T>(
    ctx: TContext,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<T>;
  // 同理：事件订阅也带上调用方身份。
  listen<T>(ctx: TContext, event: string, arg?: any): Event<T>;
}

// const enum（常量枚举，第一次遇到）：与 serialization.ts 里普通 enum 的区别是
// 编译时**内联**——用到 RequestType.Promise 的地方直接替换成数字 100，
// 编译产物里根本不存在 RequestType 这个对象，运行时零开销。
// 这些数字会出现在网络字节流里，两端必须一致，值绝不能改。
export const enum RequestType {
  // 客户端 → 服务端：发起一次 Promise 风格的请求（对应 channel 的 call）。
  Promise = 100,
  // 客户端 → 服务端：取消之前某个请求（带着要取消的请求 id）。
  PromiseCancel = 101,
  // 客户端 → 服务端：订阅某个事件（对应 channel 的 listen）。
  EventListen = 102,
  // 客户端 → 服务端：退订某个事件。
  EventDispose = 103,
}

// 服务端 → 客户端的响应类型。100/200 分段编号：看数字就知道方向。
export const enum ResponseType {
  // 握手应答：服务端就绪。
  Initialize = 200,
  // 请求成功，data 是结果。
  PromiseSuccess = 201,
  // 请求失败，data 是被"拍扁"的结构化错误信息（Error 对象无法直接过网络）。
  PromiseError = 202,
  // 请求失败，data 是原始错误对象（选择信任对端时的透传形态）。
  PromiseErrorObj = 203,
  // 事件触发，data 是本次事件数据。
  EventFire = 204,
}

// 可辨识联合（第一次遇到，本框架最重要的类型技巧之一）：
// `|` 把多个对象类型"或"在一起——一条响应必是这五种形状之一。
// 每个形状都有字面量类型的 type 字段（判别字段）。于是代码里写：
//   if (response.type === ResponseType.PromiseSuccess) { ... }
// TS 就会自动"收窄"：该分支内 response 一定带 id 和 data 字段，直接用不用猜。
// 这就是"可辨识"的含义——靠 type 字段辨认成员。
export type IRawResponse =
  // 握手应答：只有 type，没有其他数据。
  | { type: ResponseType.Initialize }
  // 成功响应：id 标明这是对哪个请求的应答（客户端靠 id 对号入座），data 是结果。
  | { type: ResponseType.PromiseSuccess; id: number; data: any }
  | {
      type: ResponseType.PromiseError;
      id: number;
      // 失败详情：字段全是 `?: unknown`（可选 + 未知类型）——因为错误形态千奇百怪，
      // 这里把已知会出现的字段全部列出（code/kind/retryAfterMs...），字段名即文档。
      data: {
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
      };
    }
  // 失败响应的另一形态：data 是原始错误对象。
  | { type: ResponseType.PromiseErrorObj; id: number; data: any }
  // 事件触发：id 是"订阅时分配的事件编号"，data 是本次事件数据。
  | { type: ResponseType.EventFire; id: number; data: any };

// 类型别名给函数类型起名：收到一条原始响应后的处理函数。
// 谁注册了 IHandler，就由谁按 id 消费对应的响应（见 channelClient.ts）。
export type IHandler = (response: IRawResponse) => void;

// 传输层的服务端契约：管理命名通道的注册。
export interface IChannelServer<TContext = string> {
  // 登记：通道名 → 通道实现。客户端之后按名字来取。
  registerChannel(channelName: string, channel: IServerChannel<TContext>): void;
  // 接口里的可选方法（第一次遇到）：实现类可以不提供 ready——
  // 调用方必须用 `server.ready?.()` 的形式安全调用。
  ready?(): void;
}

// 传输层的客户端契约：按名字取通道。
// `<T extends IChannel>` 泛型约束：调用方指定期望的通道类型（必须实现 IChannel），
// 返回值就是那个 T——调用方拿到的是具体类型，无需再手动转型。
export interface IChannelClient {
  getChannel<T extends IChannel>(channelName: string): T;
}
