/**
 * RPC 日志拦截中间件
 *
 * 装饰 ChannelServer / ChannelClient，在不侵入核心逻辑的前提下
 * 统一记录所有 RPC 调用和事件订阅。
 *
 * 用法：
 *   const server = new ChannelServer(protocol, ctx);
 *   const logged = new LoggingChannelServer(server, logger.info);
 *   services.exposeOnChannelServer(logged);
 */

import type { IChannelServer, IChannelClient, IChannel, IServerChannel } from "./channels.js";
import type { CancellationToken } from "./foundation.js";
import { Event } from "./foundation.js";

// ============================================================================
// 日志函数类型
// ============================================================================

// 日志函数的类型：接受一条消息 + 任意多个附加参数（...args 剩余参数）。
// 用类型别名而不是直接用 console——调用方可以换成自己的日志通道。
export type RPCLogger = (message: string, ...args: unknown[]) => void;

// ============================================================================
// LoggingServerChannel —— 装饰单个 IServerChannel，记录 call/listen
// ============================================================================

// 装饰器模式实战（第一个实例）：不修改原通道一行代码，只是"包一层"——
// 每个 call/listen 先干自己的事（记日志），再原样转调内部的 inner。
// `inner` 这个命名是装饰器的惯例：指被包在里面的那个真身。
class LoggingServerChannel<TContext> implements IServerChannel<TContext> {
  constructor(
    private inner: IServerChannel<TContext>,
    private channelName: string,
    private logger: RPCLogger,
  ) {}

  async call<T>(
    ctx: TContext,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<T> {
    // performance.now()：高精度计时起点（毫秒，含小数）。
    const start = performance.now();
    try {
      // await：等真正的方法执行完再计时——装饰器只观察，不改变结果。
      const result = await this.inner.call<T>(ctx, command, arg, cancellationToken);
      // toFixed(1)：保留 1 位小数，日志更好读。
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} OK (${elapsed}ms)`);
      return result;
    } catch (err) {
      // 失败也要记（含耗时），然后 `throw err` 原样上抛——装饰器绝不能吞错。
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} FAIL (${elapsed}ms)`, err);
      throw err;
    }
  }

  listen<T>(ctx: TContext, event: string, arg?: any): Event<T> {
    try {
      const result = this.inner.listen<T>(ctx, event, arg);
      this.logger(`[rpc:listen] ${this.channelName}.${event} subscribed`);
      return result;
    } catch (err) {
      this.logger(`[rpc:listen] ${this.channelName}.${event} FAIL`, err);
      throw err;
    }
  }
}

// ============================================================================
// LoggingChannelServer —— 装饰 IChannelServer，拦截 registerChannel
// ============================================================================

/**
 * 包装 ChannelServer，为每个注册的频道自动加上日志。
 *
 * 在 host process 或 server 中使用：
 * ```ts
 * const server = new ChannelServer(protocol, ctx);
 * const logged = new LoggingChannelServer(server, console.error);
 * services.exposeOnChannelServer(logged);
 * ```
 */
export class LoggingChannelServer<TContext = string> implements IChannelServer<TContext> {
  constructor(
    private inner: IChannelServer<TContext>,
    private logger: RPCLogger,
  ) {}

  // 关键一招：注册时不是原样转发通道，而是**把通道也包一层**再交出去——
  // 于是之后每个 call/listen 都自动带日志，调用方毫无感知。
  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.logger(`[rpc:register] channel "${channelName}"`);
    this.inner.registerChannel(
      channelName,
      new LoggingServerChannel(channel, channelName, this.logger),
    );
  }

  // 可选方法的透传也要用 `?.`（inner 可能没实现 ready）。
  ready(): void {
    this.inner.ready?.();
  }
}

// ============================================================================
// LoggingChannel —— 装饰单个 IChannel（客户端侧），记录 call/listen
// ============================================================================

// 与 LoggingServerChannel 同构，只是面向客户端侧的 IChannel（没有 ctx 参数）。
// 四个装饰类结构重复是刻意的：它们各自对应一个不同接口，接口不同就无法合并。
class LoggingChannel implements IChannel {
  constructor(
    private inner: IChannel,
    private channelName: string,
    private logger: RPCLogger,
  ) {}

  async call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T> {
    const start = performance.now();
    try {
      const result = await this.inner.call<T>(command, arg, cancellationToken);
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} → OK (${elapsed}ms)`);
      return result;
    } catch (err) {
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger(`[rpc:call] ${this.channelName}.${command} → FAIL (${elapsed}ms)`, err);
      throw err;
    }
  }

  listen<T>(event: string, arg?: any): Event<T> {
    this.logger(`[rpc:listen] ${this.channelName}.${event} → subscribed`);
    return this.inner.listen<T>(event, arg);
  }
}

// ============================================================================
// LoggingChannelClient —— 装饰 IChannelClient，拦截 getChannel
// ============================================================================

/**
 * 包装 ChannelClient，为每个获取的频道自动加上日志。
 *
 * 在 renderer 或 client 中使用：
 * ```ts
 * const client = new ChannelClient(protocol);
 * const logged = new LoggingChannelClient(client, console.info);
 * const services = new RemoteServiceAccess(logged);
 * ```
 */
export class LoggingChannelClient implements IChannelClient {
  constructor(
    private inner: IChannelClient,
    private logger: RPCLogger,
  ) {}

  getChannel<T extends IChannel>(channelName: string): T {
    const channel = this.inner.getChannel<T>(channelName);
    // `as unknown as T` 双重断言（第一次遇到）：TS 不允许把 LoggingChannel 直接断言成
    // 泛型 T（编译器认为两者类型差异太大，会拒绝单次 as）——先转 unknown 这个
    // "万能中转站"再转 T 就能通过。这是绕过严格检查的逃生门，用时需确认运行时真的兼容。
    return new LoggingChannel(
      channel as unknown as IChannel,
      channelName,
      this.logger,
    ) as unknown as T;
  }
}
