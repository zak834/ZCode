/**
 * RPC 调用网络遥测：记录 channel.command 级成功率与耗时，供桌面主进程聚合上报 ARMS。
 */
import type { IChannelServer, IChannelClient, IChannel, IServerChannel } from "./channels.js";
import type { CancellationToken } from "./foundation.js";
import { Event } from "./foundation.js";

// 字面量联合（protocol.ts 讲过）：三种传输形态。
export type NetworkTransportKind = "http" | "websocket" | "rpc";

// 一次网络观测的记录单。一次 RPC 调用只填前 5 个字段；
// 其余（dns/tcp/tls 耗时等）留给 HTTP 等更细的观测方——同一结构多场景复用。
export interface NetworkObservation {
  transport: NetworkTransportKind;
  interface: string;
  durationMs: number;
  ok: boolean;
  statusCode?: number;
  errorKind?: string;
  attempt?: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  downloadMs?: number;
}

// "观测数据往哪儿送"——一个回调。上层（桌面主进程）注入自己的收集器。
export type NetworkTelemetrySink = (observation: NetworkObservation) => void;

// 模块级单例（第一次遇到模块级可变状态）：整个包共享一个收集器。
// `| null` 表示"还没人注册"——遥测是可选能力，没有收集器就什么都不发生。
let networkTelemetrySink: NetworkTelemetrySink | null = null;

export function setNetworkTelemetrySink(sink: NetworkTelemetrySink | null): void {
  networkTelemetrySink = sink;
}

export function emitNetworkTelemetryObservation(observation: NetworkObservation): void {
  // `?.()` 可选调用（channelClient 讲过）：没注册收集器就安静跳过。
  networkTelemetrySink?.(observation);
}

// 给错误粗分类：把错误转成小写文本后按关键词匹配。
// `error instanceof Error ? ... : String(error)`：Error 取 message，其他值直接转字符串。
// toLowerCase 统一大小写，让匹配不受 "Timeout/timeout" 差异影响。
function classifyErrorKind(error: unknown): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  // getaddrinfo/enotfound 是 Node DNS 解析失败的典型错误码。
  if (message.includes("dns") || message.includes("getaddrinfo") || message.includes("enotfound")) {
    return "dns_failure";
  }
  // econnreset/econnrefused 是 Node 网络层典型错误码（连接被重置/拒绝）。
  if (
    message.includes("econnreset") ||
    message.includes("connection reset") ||
    message.includes("econnrefused")
  ) {
    return "connection_reset";
  }
  return "other";
}

// 把一次 RPC 调用整理成观测记录发出去。
// Math.max(0, Math.round(...))：耗时不为负、取整数；对象里 `ok` 是键名省略写法（前面见过）。
function emitRpcObservation(
  channelName: string,
  command: string,
  durationMs: number,
  ok: boolean,
  error?: unknown,
): void {
  emitNetworkTelemetryObservation({
    transport: "rpc",
    interface: `${channelName}.${command}`,
    durationMs: Math.max(0, Math.round(durationMs)),
    ok,
    // 成功时不带 errorKind（值为 undefined 的字段不会出现在上报数据里）。
    errorKind: ok ? undefined : classifyErrorKind(error),
    attempt: 1,
  });
}

// 又一个装饰器（logging-middleware 讲过模式）：只观测 call，listen 原样透传
// （事件订阅不算"网络请求成功率"，不纳入遥测）。
class NetworkTelemetryServerChannel<TContext> implements IServerChannel<TContext> {
  constructor(
    private inner: IServerChannel<TContext>,
    private channelName: string,
  ) {}

  async call<T>(
    ctx: TContext,
    command: string,
    arg?: unknown,
    cancellationToken?: CancellationToken,
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await this.inner.call<T>(ctx, command, arg, cancellationToken);
      // 成功：记一条 ok=true。
      emitRpcObservation(this.channelName, command, performance.now() - start, true);
      return result;
    } catch (error) {
      // 失败：记 ok=false 带错误分类，然后原样上抛——装饰器绝吞错。
      emitRpcObservation(this.channelName, command, performance.now() - start, false, error);
      throw error;
    }
  }

  listen<T>(ctx: TContext, event: string, arg?: unknown): Event<T> {
    return this.inner.listen<T>(ctx, event, arg);
  }
}

// 客户端侧版本，与服务端侧完全同构。
class NetworkTelemetryChannel implements IChannel {
  constructor(
    private inner: IChannel,
    private channelName: string,
  ) {}

  async call<T>(command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
    const start = performance.now();
    try {
      const result = await this.inner.call<T>(command, arg, cancellationToken);
      emitRpcObservation(this.channelName, command, performance.now() - start, true);
      return result;
    } catch (error) {
      emitRpcObservation(this.channelName, command, performance.now() - start, false, error);
      throw error;
    }
  }

  listen<T>(event: string, arg?: unknown): Event<T> {
    return this.inner.listen<T>(event, arg);
  }
}

/** 装饰 ChannelServer，为 RPC call 写入网络遥测 */
// 注册时"偷梁换柱"（同 LoggingChannelServer 的手法）。
export class NetworkTelemetryChannelServer<TContext = string> implements IChannelServer<TContext> {
  constructor(private inner: IChannelServer<TContext>) {}

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.inner.registerChannel(
      channelName,
      new NetworkTelemetryServerChannel(channel, channelName),
    );
  }

  ready(): void {
    this.inner.ready?.();
  }
}

/** 装饰 ChannelClient（renderer 侧可选，与 server 侧二选一即可避免双计） */
// 双重断言 `as unknown as T`（logging-middleware 讲过）：绕过泛型的严格检查。
export class NetworkTelemetryChannelClient implements IChannelClient {
  constructor(private inner: IChannelClient) {}

  getChannel<T extends IChannel>(channelName: string): T {
    const channel = this.inner.getChannel<T>(channelName);
    return new NetworkTelemetryChannel(channel as unknown as IChannel, channelName) as unknown as T;
  }
}
