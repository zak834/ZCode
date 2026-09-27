/**
 * 示例 4: Remote 远程连接 —— 模拟 SSH/WSL/Docker 的完整流程
 *
 * 这个示例模拟了 VS Code Remote 的完整架构：
 *
 * [客户端 (本地 VS Code)]
 *     ↓ authority = "ssh+myserver"
 * [RemoteAuthorityResolver] → { host: "192.168.1.100", port: 8080 }
 *     ↓
 * [RemoteSocketFactory] → 创建 socket 连接
 *     ↓
 * [PersistentProtocol] → 加 ACK + 心跳 + 重连
 *     ↓
 * [IPCClient] → channel.call('readFile', ...)
 *     ↓ (通过 socket 传输)
 * [服务端 (远程机器)]
 *     ↓
 * [ChannelServer] → fileService.readFile(...)
 *     ↓ (读取远程文件系统)
 * 返回结果
 *
 * 同时演示 URI 转换：
 *   客户端: vscode-remote://ssh+myserver/home/user/file.txt
 *   服务端: file:///home/user/file.txt
 */

import {
  Emitter,
  Event,
  VSBuffer,
  ISocket,
  DisposableStore,
  ChannelServer,
  ChannelClient,
  IMessagePassingProtocol,
  ProxyChannel,
  RemoteConnectionType,
  WebSocketRemoteConnection,
  IRemoteAuthorityResolver,
  RemoteAuthorityResolverService,
  ISocketFactory,
  RemoteSocketFactoryService,
  ResolvedAuthority,
  RemoteConnection,
  createURITransformer,
} from "../src/index.js";

// ============================================================================
// 模拟的 Socket 实现（内存中的双向通道）
// ============================================================================

// 内存版的"网线"：实现 ISocket 接口，但对端不是真实网络而是另一个 MockSocket。
class MockSocket implements ISocket {
  private _onData = new Emitter<VSBuffer>();
  private _onClose = new Emitter<void>();
  private _onEnd = new Emitter<void>();

  readonly onData = this._onData.event;
  readonly onClose = this._onClose.event;
  readonly onEnd = this._onEnd.event;

  // 对端引用：我 write 的数据要 fire 到它那里。
  private peer: MockSocket | null = null;

  // 静态工厂（同 VSBuffer 的写法）：造一对互联的 socket，元组返回 + 解构使用。
  static createPair(): [MockSocket, MockSocket] {
    const a = new MockSocket();
    const b = new MockSocket();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  write(buffer: VSBuffer): void {
    // 模拟网络延迟
    // `this.peer?.`：对端可能已断开置空，可选链防炸。
    setTimeout(() => {
      this.peer?._onData.fire(buffer);
    }, 1);
  }

  end(): void {
    this._onEnd.fire();
  }

  async drain(): Promise<void> {}

  dispose(): void {
    this._onClose.fire();
    this._onData.dispose();
    this._onClose.dispose();
    this._onEnd.dispose();
  }
}

// ============================================================================
// 模拟 SSH Resolver
// ============================================================================

/**
 * SSH Authority Resolver —— 模拟 Remote-SSH 扩展
 *
 * 在真实场景中，这里会：
 * 1. 解析 SSH config 获取主机地址
 * 2. 建立 SSH 隧道
 * 3. 在远端启动 code-server
 * 4. 返回隧道的本地端口
 */
class SSHAuthorityResolver implements IRemoteAuthorityResolver {
  // 模拟的 SSH 主机配置
  // Record<string, {...}> 是 TS 内置工具类型：读作"键为字符串、值为该对象形状"的字典。
  private hosts: Record<string, { host: string; port: number }> = {
    "ssh+myserver": { host: "192.168.1.100", port: 8080 },
    "ssh+devbox": { host: "10.0.0.50", port: 8080 },
  };

  async resolve(authority: string): Promise<ResolvedAuthority> {
    // 按名字查"hosts 表"——真实实现里这里是解析 SSH config / 建隧道。
    const config = this.hosts[authority];
    if (!config) {
      throw new Error(`Unknown SSH host: ${authority}`);
    }

    console.log(`  [SSH Resolver] Resolving "${authority}" → ${config.host}:${config.port}`);

    return {
      authority,
      connectTo: new WebSocketRemoteConnection(config.host, config.port),
      connectionToken: "mock-token-" + authority,
    };
  }
}

// ============================================================================
// 模拟 Socket Factory
// ============================================================================

/** 保存"服务端"的 socket 引用，模拟网络连接 */
const pendingServerSockets: MockSocket[] = [];

// 泛型实参 <WebSocket> 收窄了工厂类型：connectTo 在类型层面就是 WebSocket 连接。
class MockWebSocketFactory implements ISocketFactory<RemoteConnectionType.WebSocket> {
  supports(connectTo: RemoteConnection & { type: RemoteConnectionType.WebSocket }): boolean {
    // 演示工厂：来者不拒。
    return true;
  }

  async connect(
    connectTo: WebSocketRemoteConnection,
    path: string,
    query: string,
  ): Promise<ISocket> {
    console.log(
      `  [Socket Factory] Connecting to ${connectTo.host}:${connectTo.port}${path}?${query}`,
    );

    // 造一对互联的 socket：客户端拿走一个，另一个当"远端"存起来。
    const [clientSocket, serverSocket] = MockSocket.createPair();
    pendingServerSockets.push(serverSocket);
    return clientSocket;
  }
}

// ============================================================================
// 模拟远端服务
// ============================================================================

// 远端文件服务的接口与实现（与示例 2 的文件服务同款思路，多了 stat 方法）。
interface IRemoteFileService {
  onDidChangeFile: Event<{ path: string; type: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  stat(path: string): Promise<{ size: number; isDirectory: boolean }>;
}

class RemoteFileServiceImpl implements IRemoteFileService {
  // Map 支持构造时批量初始化：传入"键值对数组"（每个元素本身是 [键, 值] 的小数组）。
  private files = new Map<string, string>([
    ["/home/user/project/main.ts", 'console.log("Hello from remote!")'],
    ["/home/user/project/package.json", '{"name": "my-project", "version": "1.0.0"}'],
    ["/home/user/project/README.md", "# My Project\nRunning on remote server."],
  ]);

  private readonly _onDidChangeFile = new Emitter<{ path: string; type: string }>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this._onDidChangeFile.fire({ path, type: "changed" });
  }

  async stat(path: string): Promise<{ size: number; isDirectory: boolean }> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return { size: content.length, isDirectory: false };
  }
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  console.log("=== Remote connection Demo ===\n");
  const disposables = new DisposableStore();

  // ──────── 1. 设置 Remote 基础设施 ────────

  console.log("[1] Setting up Remote infrastructure...");

  // 两张"注册表"：ssh 类型的 authority 由谁解析、WebSocket 类型的连接由谁建立——
  // 这就是 VS Code 远程扩展机制的最小模型。
  const resolverService = new RemoteAuthorityResolverService();
  resolverService.registerResolver("ssh", new SSHAuthorityResolver());

  const socketFactory = new RemoteSocketFactoryService();
  socketFactory.register(RemoteConnectionType.WebSocket, new MockWebSocketFactory());

  // ──────── 2. 解析 Remote Authority ────────

  console.log('\n[2] Resolving remote authority "ssh+myserver"...');
  const resolved = await resolverService.resolveAuthority("ssh+myserver");
  console.log(`  Result: ${resolved.connectTo}, token: ${resolved.connectionToken}`);

  // ──────── 3. 建立 Socket 连接 ────────

  console.log("\n[3] Establishing socket connection...");
  const clientSocket = await socketFactory.connect(
    resolved.connectTo,
    "/",
    `token=${resolved.connectionToken}`,
  );

  // 获取模拟的服务端 socket
  // pop() 取出刚存进去的那个；`!` 非空断言：演示流程保证一定有。
  const serverSocket = pendingServerSockets.pop()!;

  // ──────── 4. 服务端设置 ────────

  console.log("\n[4] Setting up remote server...");

  // 简化：直接用 ChannelServer + ChannelClient（不用 IPCServer/IPCClient 的 ctx 握手）
  // 在真实场景中，这里会有完整的握手、认证流程

  // 创建简单的 protocol（不用 PersistentProtocol 以简化演示）
  // 这对对象字面量协议与 createQueuePair 同构：A 发 → B 收，B 发 → A 收。
  const serverOnMsg = new Emitter<VSBuffer>();
  const clientOnMsg = new Emitter<VSBuffer>();

  const serverProtocol: IMessagePassingProtocol = {
    send: (buf: VSBuffer) => setTimeout(() => clientOnMsg.fire(buf), 1),
    onMessage: serverOnMsg.event,
  };
  const clientProtocol: IMessagePassingProtocol = {
    send: (buf: VSBuffer) => setTimeout(() => serverOnMsg.fire(buf), 1),
    onMessage: clientOnMsg.event,
  };

  // 服务端注册远程文件系统 channel
  const remoteFileService = new RemoteFileServiceImpl();
  const server = new ChannelServer(serverProtocol, "server");
  server.registerChannel(
    "remoteFilesystem",
    ProxyChannel.fromService<string>(remoteFileService, disposables),
  );

  // ──────── 5. 客户端使用远程服务 ────────

  console.log("\n[5] Client using remote file service...");

  const client = new ChannelClient(clientProtocol);
  await Event.toPromise(client.onDidInitialize);

  const remoteFS = ProxyChannel.toService<IRemoteFileService>(
    client.getChannel("remoteFilesystem"),
  );

  // 订阅远程文件变更事件
  const sub = remoteFS.onDidChangeFile((e) => {
    console.log(`  [remote event] ${e.type}: ${e.path}`);
  });

  // 读取远程文件
  const mainTs = await remoteFS.readFile("/home/user/project/main.ts");
  console.log(`  readFile → "${mainTs}"`);

  const stat = await remoteFS.stat("/home/user/project/package.json");
  console.log(`  stat → size: ${stat.size}, isDirectory: ${stat.isDirectory}`);

  // 写入远程文件
  await remoteFS.writeFile(
    "/home/user/project/main.ts",
    'console.log("Updated from local VS Code!")',
  );

  const updated = await remoteFS.readFile("/home/user/project/main.ts");
  console.log(`  readFile after write → "${updated}"`);

  // ──────── 6. URI 转换演示 ────────

  console.log("\n[6] URI Transformation...");

  // URI 转换器与上面的 RPC 链路相互独立，是远程方案的另一半：路径的"翻译官"。
  const transformer = createURITransformer("ssh+myserver");

  const remoteURI = {
    scheme: "vscode-remote",
    authority: "ssh+myserver",
    path: "/home/user/file.txt",
  };
  const localURI = transformer.transformIncoming(remoteURI);
  console.log(`  Client → Server:`);
  console.log(`    ${remoteURI.scheme}://${remoteURI.authority}${remoteURI.path}`);
  console.log(`    → ${localURI.scheme}://${localURI.path}`);

  const fileURI = { scheme: "file", authority: "", path: "/home/user/file.txt" };
  const clientURI = transformer.transformOutgoing(fileURI);
  console.log(`  Server → Client:`);
  console.log(`    ${fileURI.scheme}://${fileURI.path}`);
  console.log(`    → ${clientURI.scheme}://${clientURI.authority}${clientURI.path}`);

  // 清理
  sub.dispose();
  client.dispose();
  server.dispose();
  clientSocket.dispose();
  serverSocket.dispose();
  disposables.dispose();

  console.log("\nDone!");
}

main().catch(console.error);
