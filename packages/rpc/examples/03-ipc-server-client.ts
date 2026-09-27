/**
 * 示例 3: IPCServer + IPCClient —— 多客户端连接管理
 *
 * 演示 VS Code 的真实场景：
 * - 一个 IPCServer (Electron 主进程 / 远端 code-server)
 * - 多个 IPCClient 连接 (多个窗口 / 多个 WebSocket 客户端)
 * - 服务端注册 channel 供客户端调用
 * - 客户端也可以注册 channel 供服务端反向调用
 * - 用 Router 选择目标客户端
 */

import {
  Emitter,
  DisposableStore,
  IChannel,
  IPCServer,
  IPCClient,
  StaticRouter,
  ProxyChannel,
  createQueuePair,
  ClientConnectionEvent,
} from "../src/index.js";

// ============================================================================
// 定义服务
// ============================================================================

/** 服务端提供的全局配置服务 */
// 所有客户端共享同一份配置：谁 set 了，别的客户端 get 就能读到（见下面的演示）。
class ConfigService {
  private config = new Map<string, any>();
  private readonly _onDidChange = new Emitter<{ key: string; value: any }>();
  readonly onDidChangeConfig = this._onDidChange.event;

  async get(key: string): Promise<any> {
    return this.config.get(key);
  }

  async set(key: string, value: any): Promise<void> {
    this.config.set(key, value);
    // 对象字面量键名省略：{ key, value } 等价 { key: key, value: value }。
    this._onDidChange.fire({ key, value });
  }
}

/** 客户端提供的窗口信息服务 */
// 注意方向：这个服务注册在**客户端**上，等会儿服务端会反过来调它。
class WindowInfoService {
  constructor(private windowId: string) {}

  async getTitle(): Promise<string> {
    return `Window ${this.windowId}`;
  }

  async getSize(): Promise<{ width: number; height: number }> {
    return { width: 1920, height: 1080 };
  }
}

// ============================================================================
// 演示
// ============================================================================

async function main() {
  console.log("--- IPCServer + IPCClient Demo ---\n");

  const disposables = new DisposableStore();

  // ========== 创建 IPCServer ==========

  // IPCServer 通过 onDidClientConnect 事件接收新连接
  // 演示环境里我们自己造这个事件——真实场景由 Electron/Socket 的 accept 逻辑来 fire。
  const serverEmitter = new Emitter<ClientConnectionEvent>();
  const server = new IPCServer<string>(serverEmitter.event);

  // 注册全局配置服务
  const configService = new ConfigService();
  server.registerChannel("config", ProxyChannel.fromService<string>(configService, disposables));

  // ========== 客户端 1 连接 ==========
  console.log('[1] Client "window-1" connecting...');

  // 一对内存管道：a 端给客户端用，b 端交给服务端（下面 fire 出去）。
  const [proto1a, proto1b] = createQueuePair();
  const disconnectEmitter1 = new Emitter<void>();

  // 模拟客户端连接到服务端
  // "连接建立" = 把一条协议管道 + 断开事件递给 IPCServer。
  serverEmitter.fire({ protocol: proto1b, onDidClientDisconnect: disconnectEmitter1.event });
  // 第二个参数是身份标识：IPCClient 构造时会把它作为第一条消息发给服务端。
  const client1 = new IPCClient(proto1a, "window-1");

  // 客户端注册自己的服务（供服务端反向调用）
  client1.registerChannel(
    "windowInfo",
    ProxyChannel.fromService<string>(new WindowInfoService("window-1"), disposables),
  );

  // ========== 客户端 2 连接 ==========
  console.log('[2] Client "window-2" connecting...');

  const [proto2a, proto2b] = createQueuePair();
  const disconnectEmitter2 = new Emitter<void>();

  serverEmitter.fire({ protocol: proto2b, onDidClientDisconnect: disconnectEmitter2.event });
  const client2 = new IPCClient(proto2a, "window-2");
  client2.registerChannel(
    "windowInfo",
    ProxyChannel.fromService<string>(new WindowInfoService("window-2"), disposables),
  );

  // 等待连接建立
  // 定时"睡 50ms"：给两条连接的握手消息（ctx + Initialize）留出异步完成的时间。
  await new Promise((r) => setTimeout(r, 50));

  // ========== 客户端调用服务端 ==========
  console.log("\n[3] Clients calling server...");

  // 泛型直接写了实现类 ConfigService：只要形状匹配就能当接口用（结构化类型的便利）。
  const remoteConfig1 = ProxyChannel.toService<ConfigService>(client1.getChannel("config"));

  await remoteConfig1.set("theme", "dark");
  console.log(`  client1: set theme = "dark"`);

  const remoteConfig2 = ProxyChannel.toService<ConfigService>(client2.getChannel("config"));

  const theme = await remoteConfig2.get("theme");
  console.log(`  client2: get theme = "${theme}" (读到了 client1 设置的值！)`);

  // ========== 服务端反向调用客户端 ==========
  console.log("\n[4] Server calling clients (reverse IPC)...");

  // 用 StaticRouter 选择 window-1
  // 服务端反向调用：按路由策略挑出 ctx === "window-1" 的那条连接。
  const window1Channel = server.getChannel<IChannel>(
    "windowInfo",
    new StaticRouter((ctx) => ctx === "window-1"),
  );
  const window1Info = ProxyChannel.toService<WindowInfoService>(window1Channel);
  const title1 = await window1Info.getTitle();
  console.log(`  server → window-1: title = "${title1}"`);

  // 用 filter 选择 window-2
  // 更轻的写法：直接给过滤函数（ipc.ts 的 getChannel 讲过这两种形态）。
  const window2Channel = server.getChannel<IChannel>(
    "windowInfo",
    (client) => client.ctx === "window-2",
  );
  const window2Info = ProxyChannel.toService<WindowInfoService>(window2Channel);
  const title2 = await window2Info.getTitle();
  console.log(`  server → window-2: title = "${title2}"`);

  // ========== 显示连接状态 ==========
  console.log(`\n[5] Active connections: ${server.connections.length}`);
  for (const conn of server.connections) {
    console.log(`  - ${conn.ctx}`);
  }

  // ========== 模拟客户端断开 ==========
  console.log('\n[6] Client "window-1" disconnecting...');
  // 触发断开事件——IPCServer 里注册的清理逻辑会销毁该连接的双向通道并把它移出列表。
  disconnectEmitter1.fire();
  await new Promise((r) => setTimeout(r, 10));

  console.log(`Active connections after disconnect: ${server.connections.length}`);
  for (const conn of server.connections) {
    console.log(`  - ${conn.ctx}`);
  }

  // 清理
  client1.dispose();
  client2.dispose();
  server.dispose();
  disposables.dispose();

  console.log("\nDone!");
}

main().catch(console.error);
