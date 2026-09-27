/**
 * Layer 4: 连接管理 —— IPCServer 和 IPCClient
 *
 * ChannelServer/ChannelClient 是单连接的 RPC 实现。
 * IPCServer/IPCClient 在其上构建连接管理能力：
 *
 * - IPCServer (1:N): 一个服务端接受多个客户端连接，
 *   每个连接独立创建 ChannelServer + ChannelClient。
 *   支持通过 Router 选择目标客户端进行调用。
 *
 * - IPCClient (1:1 双向): 既是客户端又是服务端，
 *   可以调远端的 channel，也可以注册自己的 channel 供远端调用。
 *
 * 关键协议：客户端连接后发送的第一条消息是 ctx（上下文/客户端ID），
 * 服务端据此识别客户端身份。
 */

import {
  Event,
  Emitter,
  IDisposable,
  DisposableStore,
  CancellationToken,
  EventMultiplexer,
} from "./foundation.js";
import { BufferReader, BufferWriter, serialize, deserialize } from "./serialization.js";
import { IMessagePassingProtocol } from "./protocol.js";
import {
  IChannel,
  IServerChannel,
  IChannelServer,
  IChannelClient,
  ChannelServer,
  ChannelClient,
  getDelayedChannel,
} from "./channels.js";

// ============================================================================
// Connection 相关接口
// ============================================================================

/** 客户端连接事件 */
// 一条新连接 = 一条协议管道 + "对端断开了"的事件。
export interface ClientConnectionEvent {
  protocol: IMessagePassingProtocol;
  readonly onDidClientDisconnect: Event<void>;
}

/** 客户端标识 */
// 极简：就是一个 ctx（泛型：身份的具体类型由应用决定，常见是字符串）。
export interface Client<TContext> {
  readonly ctx: TContext;
}

/** 连接 = 客户端标识 + 双向 channel */
// `extends Client<TContext>`：接口继承（同 ISocket），于是 Connection 也有 ctx。
// 一条连接里既有 server（给对方调我）也有 client（我去调对方）——双向。
interface Connection<TContext> extends Client<TContext> {
  readonly channelServer: ChannelServer<TContext>;
  readonly channelClient: ChannelClient;
}

/** 连接中心——暴露所有活跃连接 */
// 只读快照 + 增/删两个事件：外部凭它感知"现在谁在线"。
export interface IConnectionHub<TContext> {
  readonly connections: Connection<TContext>[];
  readonly onDidAddConnection: Event<Connection<TContext>>;
  readonly onDidRemoveConnection: Event<Connection<TContext>>;
}

/** 路由器——在多客户端场景中选择目标客户端 */
// 服务端反向调用客户端时，得先回答"调哪一个？"——路由器就是这个策略的接口。
export interface IClientRouter<TContext = string> {
  routeCall(
    hub: IConnectionHub<TContext>,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<Client<TContext>>;
  routeEvent(hub: IConnectionHub<TContext>, event: string, arg?: any): Promise<Client<TContext>>;
}

// ============================================================================
// IPCServer —— 一对多服务端
// ============================================================================

/**
 * IPCServer 是整个通信架构中的"大脑"。
 *
 * 它同时是：
 * - IChannelServer: 注册 channel 供客户端调用
 * - IRoutingChannelClient: 可以反向调用客户端的 channel（通过 Router 选择目标）
 * - IConnectionHub: 暴露所有活跃连接，支持连接增删事件
 *
 * 工作流程：
 * 1. 监听 onDidClientConnect 事件
 * 2. 客户端连接后，等待第一条消息（ctx = 客户端ID）
 * 3. 为每个连接创建独立的 ChannelServer + ChannelClient
 * 4. 把已注册的 channel 推送到新连接的 ChannelServer
 */
export class IPCServer<TContext = string>
  implements IChannelServer<TContext>, IConnectionHub<TContext>, IDisposable
{
  // 全局通道表：所有连接共享同一份（新连接接入时推送）。
  private channels = new Map<string, IServerChannel<TContext>>();
  private _connections = new Set<Connection<TContext>>();

  private readonly _onDidAddConnection = new Emitter<Connection<TContext>>();
  readonly onDidAddConnection = this._onDidAddConnection.event;

  private readonly _onDidRemoveConnection = new Emitter<Connection<TContext>>();
  readonly onDidRemoveConnection = this._onDidRemoveConnection.event;

  private readonly disposables = new DisposableStore();

  // getter 返回快照数组（`[...set]` 展开拷贝），外部怎么改都影响不到内部集合。
  get connections(): Connection<TContext>[] {
    return [...this._connections];
  }

  // 构造函数接收的是"连接事件"而不是具体传输——谁负责 accept 连接，谁 fire 这个事件，
  // IPCServer 本身不关心传输是 Electron IPC 还是 Socket（依赖倒置）。
  constructor(onDidClientConnect: Event<ClientConnectionEvent>) {
    this.disposables.add(
      onDidClientConnect(({ protocol, onDidClientDisconnect }) => {
        // 等待客户端发来的第一条消息：ctx（客户端身份标识）
        // Event.once（foundation 讲过）：只要第一条，收到即自动退订。
        const onFirstMessage = Event.once(protocol.onMessage);

        this.disposables.add(
          onFirstMessage((msg) => {
            // 从第一条消息里解出客户端身份（约定：连上先报身份）。
            const reader = new BufferReader(msg);
            const ctx = deserialize(reader) as TContext;

            // 为这个连接创建独立的 ChannelServer 和 ChannelClient
            const channelServer = new ChannelServer(protocol, ctx);
            const channelClient = new ChannelClient(protocol);

            // 把已注册的 channel 推送给新连接
            // Map.forEach 的回调参数是 (值, 键)——注意与数组的 (元素, 下标) 相反。
            this.channels.forEach((channel, name) => channelServer.registerChannel(name, channel));

            // 连接上线：登记 + 广播。
            // 对象字面量"键名省略"技巧：{ channelServer } 等价 { channelServer: channelServer }。
            const connection: Connection<TContext> = { channelServer, channelClient, ctx };
            this._connections.add(connection);
            this._onDidAddConnection.fire(connection);

            // 客户端断开时清理
            // 闭包记住的 connection 在这里派上用场：按它精准清理。
            this.disposables.add(
              onDidClientDisconnect(() => {
                channelServer.dispose();
                channelClient.dispose();
                this._connections.delete(connection);
                this._onDidRemoveConnection.fire(connection);
              }),
            );
          }),
        );
      }),
    );
  }

  /**
   * 获取客户端的 channel（反向调用）。
   *
   * 当有多个客户端时，需要 router 或 filter 来选择目标：
   * - router: 实现 IClientRouter 接口，自定义路由逻辑
   * - filter: 简单的过滤函数，随机选一个匹配的客户端
   */
  // 反向调用客户端的通道。参数是联合类型（第一次细看"联合 + 运行时收窄"的完整配合）：
  // routerOrFilter 要么是完整路由器对象，要么只是一个过滤函数——二选一。
  getChannel<T extends IChannel>(
    channelName: string,
    routerOrFilter: IClientRouter<TContext> | ((client: Client<TContext>) => boolean),
  ): T {
    // `const that = this`：把 this 存进局部变量（lint 会警告 no-this-alias，见存量警告）。
    // 为什么这么写？下面的对象方法用普通函数语法（非箭头函数），
    // 方法内部的 this 会指向代理对象自己而不是 IPCServer——先存一份最省事。
    const that = this;
    // typeof x === "function" 是运行时收窄：TS 据此知道 isFilter 为 true 的分支里
    // routerOrFilter 一定是函数形态（联合类型被"收窄"成其中一个成员）。
    const isFilter = typeof routerOrFilter === "function";

    // 又是 `as T` 代理对象（同 ChannelClient.getChannel）。
    return {
      call(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<any> {
        let connectionPromise: Promise<Client<TContext>>;

        if (isFilter) {
          // 过滤函数模式：先在现有连接里找匹配的。
          // `as (...)` 断言：类型收窄只对 if/else 分支内的直接使用生效，
          // 存进回调再传就"丢失"了收窄信息，需要断言补回（TS 的已知局限）。
          // 找到了就包成立即成功的 Promise；没找到就把"新连接到达"事件过滤后转成
          // Promise——下一个匹配的连接一上线就接上（foundation 的 Event.filter +
          // toPromise 组合子实战）。
          const match = that.connections.find(routerOrFilter as (c: Client<TContext>) => boolean);
          connectionPromise = match
            ? Promise.resolve(match)
            : Event.toPromise(
                Event.filter(
                  that.onDidAddConnection,
                  routerOrFilter as (c: Client<TContext>) => boolean,
                ),
              );
        } else {
          // 路由器模式：把"选谁"完全交给路由器策略。
          connectionPromise = (routerOrFilter as IClientRouter<TContext>).routeCall(
            that,
            command,
            arg,
            cancellationToken,
          );
        }

        // 两步链：先等"确定目标连接"，再等"从该连接拿到通道"。
        // `(c as Connection)`：Client 接口上没有 channelClient，断言成完整连接类型。
        const channelPromise = connectionPromise.then((c) =>
          (c as Connection<TContext>).channelClient.getChannel(channelName),
        );

        // 目标可能要等一会儿才上线——用"延迟通道"包装（delayedChannel 讲过），
        // 调用方拿到手就能用，内部自动等就绪。
        return getDelayedChannel(channelPromise).call(command, arg, cancellationToken);
      },
      listen(event: string, arg?: any): Event<any> {
        if (isFilter) {
          // 过滤模式的事件：多个客户端的同名事件聚合成一条流（见下方 getMulticastEvent）。
          return that.getMulticastEvent(
            channelName,
            routerOrFilter as (c: Client<TContext>) => boolean,
            event,
            arg,
          );
        }

        const channelPromise = (routerOrFilter as IClientRouter<TContext>)
          .routeEvent(that, event, arg)
          .then((c) => (c as Connection<TContext>).channelClient.getChannel(channelName));

        return getDelayedChannel(channelPromise).listen(event, arg);
      },
    } as T;
  }

  /** 聚合所有匹配客户端的同名事件为一个事件 */
  // 场景：日志面板想听"所有窗口"的 onLog 事件——不用自己遍历，这里合并成一条流。
  private getMulticastEvent<T>(
    channelName: string,
    filter: (c: Client<TContext>) => boolean,
    eventName: string,
    arg: any,
  ): Event<T> {
    const that = this;
    // 懒初始化（foundation 的钩子思路）：没人听就不建任何订阅、零开销。
    let disposables: DisposableStore | undefined;

    const emitter = new Emitter<T>({
      onWillAddFirstListener: () => {
        // 第一个订阅者到来：现在才开始真正订阅各客户端的事件。
        disposables = new DisposableStore();
        const multiplexer = new EventMultiplexer<T>();

        // "把一条连接的同名事件接入 multiplexer"的动作——现有连接和未来连接都要用。
        const onAdd = (connection: Connection<TContext>) => {
          const channel = connection.channelClient.getChannel(channelName);
          const event = channel.listen<T>(eventName, arg);
          multiplexer.add(event);
        };

        // 三件事：接入现有匹配连接、接入"未来的新连接"、把聚合结果转发到对外发射器。
        that.connections.filter(filter).forEach(onAdd);
        disposables.add(Event.filter(that.onDidAddConnection, filter)(onAdd));
        disposables.add(multiplexer.event((e) => emitter.fire(e)));
        // multiplexer 本身也是资源，一并登记。
        disposables.add(multiplexer);
      },
      onDidRemoveLastListener: () => {
        // 最后一个订阅者离开：全部拆掉（`?.` 防"从未初始化过"的情况）。
        disposables?.dispose();
        disposables = undefined;
      },
    });

    return emitter.event;
  }

  // 注册是"活的"：新通道既要进全局表（给未来连接用），也要立刻推给已在线的连接。
  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);

    // 推送到所有已连接的客户端
    for (const connection of this._connections) {
      connection.channelServer.registerChannel(channelName, channel);
    }
  }

  dispose(): void {
    // 收尾顺序：自己的订阅 → 每条连接的双向通道 → 各类集合与事件源。
    this.disposables.dispose();
    for (const connection of this._connections) {
      connection.channelClient.dispose();
      connection.channelServer.dispose();
    }
    this._connections.clear();
    this.channels.clear();
    this._onDidAddConnection.dispose();
    this._onDidRemoveConnection.dispose();
  }
}

// ============================================================================
// IPCClient —— 一对一双向
// ============================================================================

/**
 * IPCClient 是双向的：
 * - 可以调远端的 channel (IChannelClient)
 * - 也可以注册自己的 channel 供远端调用 (IChannelServer)
 *
 * 第一条消息发送 ctx（自己的身份标识），这样服务端能识别你是谁。
 */
export class IPCClient<TContext = string>
  implements IChannelClient, IChannelServer<TContext>, IDisposable
{
  // 字段只声明不赋值：约定构造函数里一定会初始化（TS 会检查这条纪律）。
  private channelClient: ChannelClient;
  private channelServer: ChannelServer<TContext>;

  constructor(protocol: IMessagePassingProtocol, ctx: TContext) {
    // 第一条消息：发送自己的身份标识
    // 这是与 IPCServer 的"接头暗号"：必须赶在任何其他消息之前发出。
    const writer = new BufferWriter();
    serialize(writer, ctx);
    protocol.send(writer.buffer);

    // 同一条协议管道上同时挂双向通道：我去调别人（client）+ 别人调我（server）。
    this.channelClient = new ChannelClient(protocol);
    this.channelServer = new ChannelServer(protocol, ctx);
  }

  getChannel<T extends IChannel>(channelName: string): T {
    return this.channelClient.getChannel(channelName);
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channelServer.registerChannel(channelName, channel);
  }

  dispose(): void {
    this.channelClient.dispose();
    this.channelServer.dispose();
  }
}

// ============================================================================
// StaticRouter —— 简单路由器
// ============================================================================

/**
 * 根据静态条件选择客户端的路由器。
 * 例: new StaticRouter(ctx => ctx === 'main-window')
 */
// 最常用的路由器：给一个"挑谁"的判断函数（同步异步都行）。
export class StaticRouter<TContext = string> implements IClientRouter<TContext> {
  constructor(private fn: (ctx: TContext) => boolean | Promise<boolean>) {}

  // 两个路由方法的挑选逻辑相同，都委托给私有的 route。
  async routeCall(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    return this.route(hub);
  }

  async routeEvent(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    return this.route(hub);
  }

  private async route(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    for (const connection of hub.connections) {
      // await：等待 Promise 出结果再继续（异步函数语法）。
      // Promise.resolve(x)：无论 fn 返回布尔还是 Promise，统一成 Promise 再等。
      if (await Promise.resolve(this.fn(connection.ctx))) {
        return connection;
      }
    }
    // 等待新连接到来
    // 一个都没有？挂起等待下一条连接，然后**递归**再筛一遍
    // （新连接也可能不匹配，继续等——直到等到为止）。
    await Event.toPromise(hub.onDidAddConnection);
    return this.route(hub);
  }
}
