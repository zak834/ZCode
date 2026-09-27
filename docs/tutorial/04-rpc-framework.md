# 04 · 自研 RPC 框架精读

> 本章你将学到：ZCode 为什么自己写了一套 IPC 框架；`packages/rpc` 的 7 层架构每一层解决什么问题；以及「一次跨进程方法调用」是怎么从一行代码 `service.add(1, 2)` 变成二进制帧穿过进程边界的。
>
> 前置知识：[01 章](./01-ts-primer.md) 的泛型与 `import type`。本章所有代码都出自 `packages/rpc`，它**零第三方依赖**——每一行都是教科书。

---

## 0. 为什么需要自研 RPC

ZCode 的功能分散在多个进程/设备里：

- 桌面版：Electron main（主进程）↔ renderer（页面）↔ Agent 子进程
- Web 版：浏览器 ↔ Hono 后端
- 手机远控：手机浏览器 ↔ 桌面已开的会话

这些边界两端的代码如果各自手写「发消息→收消息→拼 JSON→处理超时」，重复且容易错。`packages/rpc` 的答案是 VS Code 的老配方：**把「调用一个远程方法」抽象得和「调用本地方法」一模一样**，传输层（内存/MessagePort/WebSocket/stdio）可以随意替换。

`package.json` 对它的自述就一句：*VS Code style IPC communication abstraction framework*。

---

## 1. 七层架构总览

`packages/rpc/src/index.ts` 的开头是一张作者手绘的分层图（全仓库最值得先读的 30 行）：

🔍 `packages/rpc/src/index.ts`

```text
Layer 6: Remote 远程连接          RemoteAuthorityResolver → SocketFactory → PersistentProtocol
Layer 5: ProxyChannel 服务自动代理  fromService(service) ↔ toService(channel)
Layer 4: IPCServer(1:N) / IPCClient(1:1 双向)
Layer 3: ChannelServer / ChannelClient   基于 Channel 的 RPC (call/listen)
Layer 2: IMessagePassingProtocol          send(buffer) / onMessage: Event<buffer>
Layer 1: 序列化                            serialize() / deserialize()
Layer 0: 基础设施                          Event / Emitter / Disposable / VSBuffer / CancellationToken
```

规律：**下层只知道下层的接口，上层不知道下层是谁**。第 2 节引用的注释原文说得最直白：

> 「Channel RPC 层完全不知道 PersistentProtocol 的存在，它只看到 IMessagePassingProtocol 接口。这就是分层抽象的威力。」——`persistent-protocol.ts` 头注释

---

## 2. 逐层拆解

### Layer 0 · 基础设施：Event / Emitter / Disposable

🔍 `packages/rpc/src/foundation.ts`

整个框架的地基只有三样东西：资源释放、事件、取消令牌。

**Disposable（释放模式）**：所有占资源的对象都实现 `dispose()`；`DisposableStore` 把 N 个可释放对象攒起来一键释放——VS Code 里几乎每个类都有一个。

**Event / Emitter（事件系统）**，本仓库最重要的类型约定：

```ts
// foundation.ts 原文
export type Event<T> = (listener: (e: T) => void) => IDisposable;
```

> 💡 **TS 知识点：一个「函数类型」就是接口**
> `Event<T>` 不是 class，只是一行函数签名：「给我一个监听函数，我还你一个用来取消订阅的 `IDisposable`」。订阅方写 `service.onDidCompute((e) => ...)`，得到的返回值可以直接 `.dispose()` 退订。发布方用配套的 `Emitter<T>`：`new Emitter<T>()` 持有监听者列表，`emitter.fire(value)` 逐个通知，并把 `emitter.event` 暴露为只读的 `Event<T>`。**「类型 = 函数签名」是 TS 里轻量定义契约的常用手法**，比定义 interface + class 更省字。
>
> 另注意 `export namespace Event { ... }`：TS 允许在类型名下挂工具函数（`Event.once(...)`、`Event.toPromise(...)`），读代码时看到 `Event.` 开头的调用都是这里的静态工具。

### Layer 1 · 序列化：自定义二进制格式

🔍 `packages/rpc/src/serialization.ts`、`buffer.ts`

消息要过进程边界，就得编码成字节。这里没有用 JSON，而是 VS Code 的自定义协议：

```text
[1 byte 类型标签] [VQL 编码的长度] [数据]
```

`VSBuffer` 是自研的二进制缓冲（对标 Node 的 Buffer，但浏览器里也能用）；`VQL`（变长整数）用 7 bit 存数据、最高位当「还有后续」的标志——小数字 1 字节搞定，比固定 4 字节省。

> 💡 **TS 知识点：为什么类型标签重要**
> 序列化不只是「变成字节」，还要记下「这字节原本是什么类型」（number？string？对象？），反序列化才能还原。TS 类型帮不上忙——运行时只有字节。这正是 [01 章](./01-ts-primer.md) 第 6 节「类型骗不了运行时」的又一例证。

### Layer 2 · 传输协议：从字节流到消息流

🔍 `packages/rpc/src/protocol.ts`、`persistent-protocol.ts`

两个关键接口定义了「可传输」的最小契约：

```ts
interface IMessagePassingProtocol {
  send(buffer: VSBuffer): void;
  onMessage: Event<VSBuffer>;
}
interface ISocket {           // 更底层：原始字节流
  onData: Event<VSBuffer>;
  onClose: Event<void>;
  onEnd: Event<void>;
  write(buffer: VSBuffer): void;
  end(): void;
  /* drain / dispose ... */
}
```

`SocketProtocol` 负责把字节流切成一帧帧消息（`ChunkStream` 处理半包/粘包）；`PersistentProtocol` 再往上叠可靠性：**ACK 确认、心跳保活、断线重连时重放未确认消息**（有界：字节上限 + 时间宽限窗），以及拥塞水位信号（`onSaturated`/`onDrained`，上层据此暂停/恢复发送）。

**同一套上层，三种真实传输**——这是理解本框架价值的钥匙，三个适配器都在业务包里：

| 传输 | 适配器代码 | 用在哪 |
| --- | --- | --- |
| 进程 stdio | `packages/server/src/stdio.ts` 的 `wrapStdio()`：把 `process.stdin/stdout` 包成 `ISocket`（stdout 只留给 RPC 数据，日志必须走 stderr——这也是 `cli/main.ts` 要把 console 重定向到 stderr 的原因） | 桌面/CLI 拉起 Agent 子进程 |
| 浏览器 WebSocket | `packages/client/src/websocket.ts` 的 `wrapBrowserWebSocket()` | Web 版连后端 |
| Electron MessagePort | `packages/client/src/messageport.ts` | main ↔ renderer |

> 💡 **TS 知识点：适配器模式 = 「长得像就能用」**
> TS 的 interface 是**结构化**的（鸭子类型）：不要求继承声明，只要你的对象恰好有 `onData/onClose/write/end...` 这些成员，它就是一个 `ISocket`。所以 `wrapStdio()` 不写 `implements ISocket` 也直接返回一个合法 `ISocket`。全仓库的跨环境差异都靠这种「把异构东西包成统一接口」的手法抹平。

### Layer 3 · Channel：call 与 listen 的二分法

🔍 `packages/rpc/src/channels.ts`、`channelServer.ts`、`channelClient.ts`

这是整个框架的心智模型，只有两个动词：

- **call（调用）**：请求→响应，走 Promise —— 表达「命令」
- **listen（监听）**：订阅事件流，走 `Event<T>` —— 表达「通知」

服务端实现 `IServerChannel`（两个 `switch`：一个分发命令、一个分发事件），客户端拿 `IChannel` 调用。`ChannelServer` 管注册与分发，`ChannelClient` 管发起与消息 id ↔ Promise 的配对；`getDelayedChannel` 提供排队版通道（连接未就绪时先缓存调用）。

`packages/rpc/examples/01-basic-ipc.ts` 用内存管道完整演示了这条链路，开头的数据流注释值得抄进笔记：

```text
client.call('add', [1, 2])
    ↓ serialize → send
[protocol A] ──buffer──→ [protocol B]
    ↓ deserialize → dispatch
channel.call(ctx, 'add', [1, 2]) → return 3 → 原路返回 → resolve promise
```

> 💡 **TS 知识点：泛型约束住「远程调用的返回类型」**
> `calculator.call<number>("add", [10, 20])` —— `call<T>` 的泛型参数告诉 TS「这次调用的 Promise 里装的是 number」。远程调用本质返回 `any`，**是调用方用泛型把类型「贴」回去的**。代价是：类型只是承诺，服务端真返回了字符串 TS 也不会报错——所以业务层才需要 zod 校验协议消息（第 07 章展开）。

### Layer 4 · IPCServer / IPCClient：1 对 N 的连接管理

🔍 `packages/rpc/src/ipc.ts`，示例 `examples/03-ipc-server-client.ts`

Layer 3 是一条点对点连接；真实场景是一个后端对多个窗口。`IPCServer` 通过 `onDidClientConnect` 事件接入任意多客户端；`IPCClient` 带 `ctx` 标识（如窗口 id）建立 1:1 连接。**双向**：客户端也能注册 channel 供服务端反向调用（服务端调窗口的 `windowInfo` 拿标题）。`Router`（如 `StaticRouter`）决定「调用哪个客户端」——按 ctx 精确选或用过滤函数选。

### Layer 5 · ProxyChannel：一行代码的魔法

🔍 `packages/rpc/src/proxy-channel.ts`，示例 `examples/02-proxy-channel.ts`

Layer 3 里的手写 `IServerChannel`（两个 switch）样板味太重。`ProxyChannel` 消灭了它：

```ts
// 服务端：service → channel（自动把方法映射为 call、onXxx 事件映射为 listen）
const channel = ProxyChannel.fromService(fileService, disposables);
// 客户端：channel → 类型安全的 service（调 remoteFS.readFile(...) 自动变成 channel.call）
const remoteFS = ProxyChannel.toService<IFileService>(client.getChannel("fileService"));
```

之后 `await remoteFS.writeFile("/src/main.ts", ...)` 就像调本地方法——实际经历了 序列化→传输→反序列化→执行→回传。示例 2 的头注释点题：「这就是 VS Code 里几百个 service 能轻松跨进程通信的秘密」。

> 💡 **TS 知识点：ES6 Proxy + 泛型 = 分布式对象**
> `toService<IFileService>()` 内部用 JS 的 `Proxy` 对象拦截属性访问：读到方法名就返回一个「内部转发 `channel.call`」的函数，读到 `onXxx` 就转发 `channel.listen`。而泛型参数 `IFileService` 让 TS 认为这个 Proxy **就是**那个接口——补全、类型检查全部生效。这是「运行时动态、编译期严格」两者兼得的经典组合，React 生态的很多库（如 MSW）同款手法。

### Layer 6 · Remote：远程连接全家桶

🔍 `packages/rpc/src/remote.ts`，示例 `examples/04-remote-connection.ts`

模拟 SSH/WSL/远程工作区的完整流程：

```text
客户端 → authority("ssh+myserver")
       → RemoteAuthorityResolver 解析成 { host, port, token }
       → RemoteSocketFactoryService 按类型创建 socket
       → (PersistentProtocol 加 ACK/心跳/重连)
       → ChannelClient.call(...) → 远端 ChannelServer 执行
```

还附带 **URI 转换器**：客户端眼里的 `vscode-remote://ssh+myserver/home/user/file.txt`，发到服务端自动变 `file:///home/user/file.txt`，回来再变回去——远程工作区路径显示不串位的底层保障。

### 中间件：Logging 与 NetworkTelemetry

🔍 `packages/rpc/src/logging-middleware.ts`、`network-telemetry-middleware.ts`

`LoggingChannelServer/Client` 装饰 Layer 3，统一记录每次 RPC 调用；网络遥测中间件导出 `setNetworkTelemetrySink()` 供上层接 OpenTelemetry（见 02 章「可观测」）。装饰的是 Channel 而不是每层都插桩——又是「分层」红利的体现。

---

## 3. 在 ZCode 里的真实接线

以桌面版拉起 Agent 为例（真实文件，可对照阅读）：

1. `packages/server/src/stdio.ts`：`wrapStdio()` → `SocketProtocol` → `ChannelServer`，然后 `services.exposeOnChannelServer(...)` 把服务集合一次性注册上去（内部就是逐个 `ProxyChannel.fromService`）
2. 桌面 main 进程把 renderer 的连接接到同一 Agent（MessagePort 适配）；
3. Web 场景里 `packages/server/src/http.ts` 的 Hono 应用升级 WebSocket，浏览器侧由 `packages/client/src/websocket.ts` 接入
4. 三条路径的上层完全相同：同一批 channel 名、同一批服务接口——这就是 AGENTS.md 说「Desktop 与 Web 共享同一套服务层」的技术底座

顺带一提：`server/src/stdio.ts` 里 `clientMode: "desktop-continuous"` 就是 AGENTS.md 强调的两种流式语义之一（另一种 `web-remote-replayable` 由 `PersistentProtocol` 的快照/重放能力支撑，第 07 章讲协议时再碰它）。

---

## 4. 动手环节

示例是现成可跑的（`packages/rpc/package.json` 里有 demo 脚本）：

```bash
pnpm --filter @zcode/rpc demo:basic      # 示例 1：手写 Channel 的最小 RPC
pnpm --filter @zcode/rpc demo:proxy      # 示例 2：ProxyChannel 零样板
pnpm --filter @zcode/rpc demo:messageport
pnpm --filter @zcode/rpc demo:remote     # 示例 4：远程连接全流程
```

1. 跑 `demo:basic`，对着输出和 `examples/01-basic-ipc.ts` 逐行核对数据流。
2. **改坏它**：在 `CalculatorChannel.call` 的 `add` 分支返回字符串 `"fake"`，观察客户端 `call<number>` 拿到的值——体会「泛型是承诺不是校验」。
3. 进阶：给 `CalculatorService` 加一个 `history: string[]` 和 `onHistoryChanged` 事件，用 ProxyChannel 版本（改 examples/02）重新暴露，验证事件能穿过来。

---

**下一章**：[05 · Agent 核心循环](./05-agent-core.md) —— RPC 之上的真正主角：`AgentRuntime` 如何把一句话变成模型调用与工具执行。
