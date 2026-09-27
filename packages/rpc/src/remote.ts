/**
 * Layer 6: Remote 远程连接抽象
 *
 * 这一层让 VS Code 能连接到 SSH、Docker、WSL 里的文件系统。
 *
 * 核心思路：
 * 1. RemoteAuthority: "ssh+myserver" 这样的字符串标识远程环境
 * 2. RemoteAuthorityResolver: 由扩展注册，把 authority 解析为实际连接地址
 * 3. RemoteSocketFactory: 根据连接类型创建不同的 socket
 * 4. URITransformer: 在客户端和服务端之间转换文件路径
 *
 * 连接建立流程：
 *   authority "ssh+myserver"
 *       ↓ (RemoteAuthorityResolver)
 *   { host: "1.2.3.4", port: 8080, token: "xxx" }
 *       ↓ (RemoteSocketFactory)
 *   ISocket (TCP/WebSocket)
 *       ↓ (PersistentProtocol)
 *   IMessagePassingProtocol (带 ACK + 重连)
 *       ↓ (IPCClient)
 *   可以调用远端的 channel 了！
 */

import { Emitter, IDisposable, toDisposable } from "./foundation.js";
import { ISocket } from "./protocol.js";
import { PersistentProtocol } from "./persistent-protocol.js";
import { IPCClient } from "./ipc.js";

// ============================================================================
// Remote Authority
// ============================================================================

/**
 * 远程连接类型
 */
export enum RemoteConnectionType {
  // 两种连接类别：直连的 WebSocket / 由外部托管的连接（如隧道）。
  WebSocket = 0,
  Managed = 1,
}

/**
 * WebSocket 连接：直接连到 host:port
 */
export class WebSocketRemoteConnection {
  // 类字段直接写死 type 字面量：实例一出生就自带"我是哪类连接"的标记——
  // 这正是下面 RemoteConnection 联合类型能"可辨识"的依据。
  readonly type = RemoteConnectionType.WebSocket;
  constructor(
    public readonly host: string,
    public readonly port: number,
  ) {}

  // 覆写 Object 自带的 toString：打印/拼字符串时显示友好名字。
  toString(): string {
    return `WebSocket(${this.host}:${this.port})`;
  }
}

/**
 * 托管连接：通过 ID 引用已建立的连接（如 tunnel）
 */
export class ManagedRemoteConnection {
  readonly type = RemoteConnectionType.Managed;
  constructor(public readonly id: number) {}

  toString(): string {
    return `Managed(${this.id})`;
  }
}

// 类联合（第一次遇到）：一条远程连接是这两种类之一。
// 每个类都有字面量 type 字段——这就是可辨识联合，用 connection.type === ... 收窄。
export type RemoteConnection = WebSocketRemoteConnection | ManagedRemoteConnection;

/** 解析后的远程地址 */
export interface ResolvedAuthority {
  readonly authority: string;
  // "往哪儿连"的具体方式（WebSocket 地址或托管 id）。
  readonly connectTo: RemoteConnection;
  // `string | undefined`：可能有令牌（鉴权用）也可能没有。
  readonly connectionToken: string | undefined;
}

// ============================================================================
// Remote Authority Resolver
// ============================================================================

/**
 * IRemoteAuthorityResolver 负责把 authority 字符串解析为实际连接地址。
 *
 * 在 VS Code 中，这个接口由远程扩展实现：
 * - Remote-SSH 扩展注册 "ssh" 类型的 resolver
 * - Remote-WSL 扩展注册 "wsl" 类型的 resolver
 * - Dev Containers 扩展注册 "dev-container" 类型的 resolver
 *
 * 每种远程类型都知道如何解析自己的 authority 并返回可连接的地址。
 */
export interface IRemoteAuthorityResolver {
  resolve(authority: string): Promise<ResolvedAuthority>;
}

/**
 * RemoteAuthorityResolverService 管理多个 resolver
 */
export class RemoteAuthorityResolverService {
  // authority 类型前缀（ssh/wsl/...）→ 对应的解析器。
  private resolvers = new Map<string, IRemoteAuthorityResolver>();

  /** 注册一个 authority 类型的 resolver */
  // 返回退订句柄（foundation 的 toDisposable 惯例）：扩展注销时能顺手把自己移除。
  registerResolver(type: string, resolver: IRemoteAuthorityResolver): IDisposable {
    this.resolvers.set(type, resolver);
    return toDisposable(() => this.resolvers.delete(type));
  }

  /**
   * 解析 authority
   * @param authority 如 "ssh+myserver", "wsl+Ubuntu"
   */
  async resolveAuthority(authority: string): Promise<ResolvedAuthority> {
    // 从 authority 中提取类型：ssh+myserver → ssh
    // indexOf 找第一个 + 的位置；没有 + 就把整个字符串当类型；substring 取子串。
    const plusIndex = authority.indexOf("+");
    const type = plusIndex >= 0 ? authority.substring(0, plusIndex) : authority;

    // 按类型找解析器——没注册就明确报错。
    const resolver = this.resolvers.get(type);
    if (!resolver) {
      throw new Error(`No resolver registered for remote type: ${type}`);
    }

    // 真正的解析交给该类型的 resolver（每种远程协议自己最懂自己）。
    return resolver.resolve(authority);
  }
}

// ============================================================================
// Remote Socket Factory
// ============================================================================

/**
 * ISocketFactory 创建特定类型的 socket 连接
 */
// 泛型默认值（channels.shared 讲过）+ 交叉类型（channelClient 讲过）的组合应用：
// `RemoteConnection & { type: T }` 表示"任意连接，但 type 已收窄到 T"——
// 工厂实现方在类型层面就能拿到精确的连接形状。
export interface ISocketFactory<T extends RemoteConnectionType = RemoteConnectionType> {
  supports(connectTo: RemoteConnection & { type: T }): boolean;
  connect(connectTo: RemoteConnection & { type: T }, path: string, query: string): Promise<ISocket>;
}

/**
 * RemoteSocketFactoryService 管理不同连接类型的 socket 工厂。
 *
 * 设计模式：策略模式
 * - Node.js 环境注册 NodeSocketFactory（TCP socket）
 * - 浏览器环境注册 BrowserSocketFactory（WebSocket）
 * - 每种 RemoteConnectionType 可以有多个工厂，按 supports() 选择
 */
export class RemoteSocketFactoryService {
  private readonly factories: Map<RemoteConnectionType, ISocketFactory[]> = new Map();

  register<T extends RemoteConnectionType>(type: T, factory: ISocketFactory<T>): IDisposable {
    // 第一次注册该类型时先建空数组。
    if (!this.factories.has(type)) {
      this.factories.set(type, []);
    }
    // `!` 非空断言（protocol 讲过）：上一行刚保证过一定存在。
    // `as ISocketFactory`：把带泛型的工厂去掉类型参数后存入统一列表。
    this.factories.get(type)!.push(factory as ISocketFactory);
    // 注销句柄：按 indexOf 找到位置再 splice 移除（idx >= 0 防找不到）。
    return toDisposable(() => {
      const list = this.factories.get(type);
      if (list) {
        const idx = list.indexOf(factory as ISocketFactory);
        if (idx >= 0) {
          // splice(位置, 个数)：从数组中删除元素。
          list.splice(idx, 1);
        }
      }
    });
  }

  async connect(connectTo: RemoteConnection, path: string, query: string): Promise<ISocket> {
    // `|| []`：没注册过该类型就当空列表处理。
    const factories = this.factories.get(connectTo.type) || [];
    // `as any`：把联合类型塞回带泛型的 supports 参数——图省事，放弃了类型精度。
    const factory = factories.find((f) => f.supports(connectTo as any));
    if (!factory) {
      throw new Error(`No socket factory found for ${connectTo}`);
    }
    return factory.connect(connectTo as any, path, query);
  }
}

// ============================================================================
// URI Transformer
// ============================================================================

/**
 * URI 转换器——在客户端和服务端之间转换文件路径。
 *
 * 问题：
 * - 客户端用 vscode-remote://ssh+myserver/home/user/file.txt 标识远程文件
 * - 服务端（远端机器上）用 file:///home/user/file.txt 操作真实文件
 *
 * 转换规则：
 *   客户端 → 服务端:
 *     vscode-remote://authority/path → file:///path
 *     file:///local/path → vscode-local:///local/path
 *
 *   服务端 → 客户端:
 *     file:///path → vscode-remote://authority/path
 *     vscode-local:///local/path → file:///local/path
 */
export interface IURITransformer {
  /** 客户端 URI → 服务端 URI */
  transformIncoming(uri: SimpleURI): SimpleURI;
  /** 服务端 URI → 客户端 URI */
  transformOutgoing(uri: SimpleURI): SimpleURI;
}

/** 简化的 URI 表示 */
// URI 三要素：协议(scheme)//主机(authority)/路径(path)。比完整的 URL 类轻量得多。
export interface SimpleURI {
  scheme: string;
  authority: string;
  path: string;
}

/**
 * 创建一个 URI 转换器
 * @param remoteAuthority 远程 authority 字符串，如 "ssh+myserver"
 */
// 工厂函数模式：不 new 类，而是返回一个"实现了接口的对象字面量"
// ——结构化类型让这完全合法（protocol 的 createQueuePair 同款）。
export function createURITransformer(remoteAuthority: string): IURITransformer {
  return {
    transformIncoming(uri: SimpleURI): SimpleURI {
      // vscode-remote://authority/path → file:///path
      // scheme 和 authority 都匹配才算"发给我们自己的远程文件"（别的 authority 不动）。
      if (uri.scheme === "vscode-remote" && uri.authority === remoteAuthority) {
        return { scheme: "file", authority: "", path: uri.path };
      }
      // file:///local → vscode-local:///local
      // 客户端的本地文件换上特殊前缀，防止远端把它当成自己的本地文件误操作。
      if (uri.scheme === "file") {
        return { scheme: "vscode-local", authority: "", path: uri.path };
      }
      // 其他 scheme 原样通过。
      return uri;
    },

    transformOutgoing(uri: SimpleURI): SimpleURI {
      // file:///path → vscode-remote://authority/path
      if (uri.scheme === "file") {
        return { scheme: "vscode-remote", authority: remoteAuthority, path: uri.path };
      }
      // vscode-local:///local → file:///local
      if (uri.scheme === "vscode-local") {
        return { scheme: "file", authority: "", path: uri.path };
      }
      return uri;
    },
  };
}

// ============================================================================
// Remote Agent Connection —— 把所有 Remote 抽象串起来
// ============================================================================

/**
 * 重连策略
 */
// 重连退避表：第 n 次重试前等多久（秒）。前密后疏——先快速重试几次，再拉开间隔。
const RECONNECT_DELAYS = [0, 5, 5, 10, 10, 10, 10, 10, 30]; // 秒

// 连接状态：字面量联合（protocol 讲过）——只有这三种。
export interface RemoteConnectionState {
  type: "connected" | "reconnecting" | "disconnected";
}

/**
 * RemoteAgentConnection 是远程连接的完整生命周期管理器。
 *
 * 它串联了所有 Remote 层的抽象：
 * 1. 用 RemoteAuthorityResolver 解析地址
 * 2. 用 RemoteSocketFactory 建立 socket
 * 3. 用 PersistentProtocol 添加可靠性
 * 4. 包装为 IPCClient 供上层使用
 * 5. 断线后自动重连
 */
export class RemoteAgentConnection implements IDisposable {
  // `= null` 初始化 + `| null` 类型：连接建立前/失败后都是"空"，connect 成功才填上。
  private protocol: PersistentProtocol | null = null;
  private client: IPCClient<string> | null = null;

  private readonly _onDidStateChange = new Emitter<RemoteConnectionState>();
  readonly onDidStateChange = this._onDidStateChange.event;

  // 依赖注入：三个协作对象都从构造函数传入（而不是自己 new）——
  // 测试时可以塞假实现，这是可测试性的关键设计。
  constructor(
    private readonly authority: string,
    private readonly resolverService: RemoteAuthorityResolverService,
    private readonly socketFactory: RemoteSocketFactoryService,
  ) {}

  /**
   * 建立连接并返回 IPCClient
   */
  async connect(): Promise<IPCClient<string>> {
    // Step 1: 解析 authority
    // 每一步 await 都是异步的：解析可能要问远端，连接可能要过网络。
    const resolved = await this.resolverService.resolveAuthority(this.authority);

    // Step 2: 建立 socket
    // 有令牌就拼进查询串（模板字符串）；URL 查询串形如 ?token=xxx。
    const query = resolved.connectionToken ? `token=${resolved.connectionToken}` : "";
    const socket = await this.socketFactory.connect(resolved.connectTo, "/", query);

    // Step 3: 用 PersistentProtocol 包装（加 ACK + 重连能力）
    this.protocol = new PersistentProtocol(socket);

    // Step 4: 包装为 IPCClient
    // 身份就用 authority 字符串——服务端靠它认出这条连接。
    this.client = new IPCClient(this.protocol, this.authority);

    // Step 5: 监听断线，触发重连
    this.protocol.onSocketClose(() => {
      this._onDidStateChange.fire({ type: "reconnecting" });
      this.reconnect(resolved, 0);
    });

    // 全部就绪：广播"已连接"，把客户端交出去。
    this._onDidStateChange.fire({ type: "connected" });
    return this.client;
  }

  // async 递归（第一次遇到异步递归）：一轮失败就再排一轮，靠 attempt 计数封顶。
  private async reconnect(resolved: ResolvedAuthority, attempt: number): Promise<void> {
    // 重试次数用尽：彻底放弃，广播"已断开"。
    if (attempt >= RECONNECT_DELAYS.length) {
      this._onDidStateChange.fire({ type: "disconnected" });
      return;
    }

    // 按退避表等待。`new Promise((r) => setTimeout(r, delay))` 是"睡一会儿"的惯用写法：
    // 定时器到点就调用 resolve（这里的参数 r），Promise 完成，await 放行。
    const delay = RECONNECT_DELAYS[attempt] * 1000;
    await new Promise((r) => setTimeout(r, delay));

    try {
      const query = resolved.connectionToken ? `token=${resolved.connectionToken}` : "";
      const newSocket = await this.socketFactory.connect(resolved.connectTo, "/", query);

      // 用新 socket 替换，PersistentProtocol 会自动重放未确认的消息
      // `this.protocol!`：能走到这里说明 connect 成功过（协议已建），断言非空。
      this.protocol!.replaceSocket(newSocket);
      this._onDidStateChange.fire({ type: "connected" });
    } catch {
      // 这次没连上：不把错误抛给上层，静默进入下一次重试。
      this.reconnect(resolved, attempt + 1);
    }
  }

  dispose(): void {
    this.client?.dispose();
    this.protocol?.dispose();
    this._onDidStateChange.dispose();
  }
}
