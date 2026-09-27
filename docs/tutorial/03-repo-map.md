# 03 · 仓库地图

> 本章你将学到：仓库**每个目录是干嘛的**。根目录逐文件说明；主 workspace 14 个包、CLI 嵌套 workspace 16 个子包逐个讲解（一句话职责 + 入口 + 内部结构）。
>
> 读法：先看开头两张图建立全局，之后**把它当字典用**——读代码遇到陌生目录就回来查。ZCode 是 AI 编程工作台，提供桌面应用、浏览器界面和终端 Agent（详见根目录 `README.md`）。

---

## 0. 全局分层图

三个用户入口共享同一套 UI 与服务层；所有跨进程/跨设备通信走自研 RPC；协议与类型全部集中在 shared：

```text
用户入口（3 个，同一套体验）
┌────────────────┐  ┌────────────────┐  ┌──────────────────────┐
│    desktop     │  │      web       │  │   apps/zcode-cli     │
│ Electron 桌面壳 │  │  浏览器工作台   │  │  zcode 命令行 + TUI  │
└───────┬────────┘  └───────┬────────┘  └──────────┬───────────┘
        │                   │                      │
        │            ┌──────▼───────┐              │
        └───────────►│      ui      │              │
                     │ 共享 React 组件│              │
                     └──┬────────┬──┘              │
                        │        │                 │
             ┌──────────▼─┐   ┌──▼─────────┐       │
             │   client   │   │  services  │       │
             │Agent 客户端 │   │ 业务服务集合│       │
             └─────┬──────┘   └──┬─────────┘       │
                   │             │                 │
                   │      ┌──────▼──────────────┐  │
                   │      │ provider / provider-│  │
                   │      │ node（模型接入配置）  │  │
                   │      └──────┬──────────────┘  │
                   │             │                 │
              ┌────▼─────────────▼─────────────────▼────┐
              │   rpc（自研 IPC 框架）    shared（协议+类型）│
              └──────────────────────────────────────────┘

Agent 侧（apps/zcode-cli/packages，嵌套 workspace，自底向上）：
  shared-types / contracts（schema）/ i18n / telemetry
        ↓
  core（Agent 核心循环） ← adapters（外部世界 I/O）
        ↓
  bootstrap（组装一切） → cli（zcode 二进制入口） + tui（终端界面）
```

依赖方向永远自上而下（由各包 `package.json` 的 `workspace:*` 依赖证实），与根目录 `architecture-policy.yaml` 的模块管控一致：跨包只能走公开入口（`contract.ts` / 包入口），禁止循环依赖。

---

## 1. 根目录逐文件

### 配置与工程化

| 文件 | 干嘛的 |
| --- | --- |
| `package.json` | 仓库总清单：40+ 个 `pnpm` 脚本（`dev:web`、`typecheck`、`architecture:check`…）、pnpm 依赖补丁登记、Node/pnpm 版本约定 |
| `pnpm-workspace.yaml` | 声明 workspace 范围 + 允许编译的原生模块（electron、node-pty、ssh2 等） |
| `mise.toml` | 版本锚：Node 24.14.0 + pnpm 10.33.2，还定义了 `mise` 任务快捷方式 |
| `tsconfig.base.json` | 全仓库 TS 编译基础配置（[01 章](./01-ts-primer.md) 逐项解读过） |
| `.oxlintrc.json` / `.oxfmtrc.json` | lint 与格式化规则 |
| `knip.json` | 未使用依赖/导出检查规则 |
| `.release-it.mjs` | 发版自动化配置 |
| `.npmrc` / `.nvmrc` | pnpm 与 Node 版本管理器的配套配置 |
| `.env.example` | 环境变量样例（`ZCODE_DATA_BASE_DIR`、`ZCODE_SERVER_WORKSPACE` 等，全部 `ZCODE_` 前缀）；`.env.development` / `.env.production` 是桌面开发的环境选择 |
| `.gitignore` / `.gitattributes` / `.dockerignore` / `.prettierignore` | 各类忽略规则 |
| `architecture-policy.yaml` | **模块管控策略**：每个模块的根目录、依赖白名单、公开入口、分层顺序；全局规则（单文件 ≤400 行、禁循环依赖、禁深层导入） |
| `.architecture-baseline.json` | 存量违规的基线快照（`pnpm architecture:check --changed` 对照它报「新增违规」） |

### 文档

| 文件 | 干嘛的 |
| --- | --- |
| `README.md` / `README.en.md` | 项目介绍、初始化、开发/打包命令（中文/英文） |
| `AGENTS.md` | AI 协作者工作规范：spec 先行、实现验证、平台边界、日志约定。**改码前必读** |
| `CLAUDE.md` | Claude Code 的仓库指引（内容与 AGENTS.md 呼应 + 常用命令速查） |
| `DESIGN.md` | UI 设计规范：颜色 token、`text-ui-*` 字体强制、明暗主题。改 UI 前必读 |
| `CONTEXT.md` | 插件商店领域词汇表（Official Marketplace、Store Listing、插件生命周期……）。改商店相关 UI 前必读 |
| `NOTICE.md` / `LICENSE` / `THIRD-PARTY-NOTICES.md` | 项目声明、Apache-2.0 许可、第三方版权材料 |

### 目录

| 目录 | 干嘛的 |
| --- | --- |
| `packages/` | 主 workspace：14 个包，见第 2 节 |
| `apps/` | 目前只有 `zcode-cli`（嵌套 workspace，见第 3 节） |
| `scripts/` | 40+ 个构建维护脚本（纯 Node JS）：`bootstrap.mjs` 初始化、`build-zcode.mjs` 组装命令行发行包、`dev-desktop-env.mjs` 桌面开发环境选择、`architecture/` 架构检查引擎、`native-search-tools-*` 原生搜索工具构建、`licenses.mjs` 系列第三方声明生成、`check-workspace-freshness.mjs` 基线检查 |
| `patches/` | 3 个 pnpm 依赖补丁（`@ai-sdk/anthropic`、`@ai-sdk/openai-compatible`、`@arms/rum-electron`） |
| `config/` | 随客户端发布的内置 Provider 配置（`default.json` + `provider/`） |
| `public/` | 应用 logo 等静态资源 |
| `third-party/` | 开源合规材料：依赖清单 `inventory.json`、上游组件 `upstream/`、运行时与原生搜索工具的声明 |
| `harness/remote` | 远程链路支撑材料（远程连接调试相关；细节待深入） |
| `.agents/skills/` | 仓库自带的 AI 协作技能包：`architecture-governance`（改码工作流）、`react-best-practices`、`electron`、`dogfood`、`feature-boundary-planner` 等 |
| `.vscode/` | 编辑器配置 |

---

## 2. 主 workspace：`packages/` 14 个包

按「自底向上」顺序讲（下层被上层依赖）。每包格式：**一句话职责** → 入口 → 内部结构 → 值得先看的文件。

### 2.1 `packages/shared` — 协议与类型的「宪法」

全仓库的地基：**所有跨进程/跨端共享的类型、zod schema、协议定义**。200+ 个顶层文件，几乎每个文件对应一个业务概念（`platform.ts` 平台抽象、`oauth.ts`、`plugin-types.ts`、`remote-target.ts`…）。

- 入口：`src/index.ts`
- 内部目录：`zcode-protocol/`、`zcode-protocol-v4/`（客户端↔Agent 协议，v4 是现行版本）、`browser-use/`、`node/`（Node 侧专属类型）
- 依赖：仅 `zod` 和 `model-option-map`——**它不依赖任何人**，所以人人都能依赖它
- 🔍 先看：`src/index.ts`、`src/platform.ts`（`IPlatformService`，UI 访问平台能力的唯一通道）

### 2.2 `packages/model-option-map` — 零依赖小 DSL

解析/求值「模型选项映射」的小型语言：`tokenizer.ts → parser.ts → compiler.ts → evaluator.ts` 一条完整编译器流水线，是学习「TS 写编译器」的最佳小样本。

- 入口：`src/index.ts`；被 `shared`、`provider` 依赖

### 2.3 `packages/rpc` — 自研 IPC 框架

「VS Code 风格 IPC 通信抽象」，**零外部依赖**。7 层架构：基础设施(Event/Emitter) → 序列化(VSBuffer) → 消息协议 → Channel RPC → IPCServer/IPCClient → 服务自动代理(ProxyChannel) → 远程连接(Remote)。桌面 main↔renderer、Web↔server、手机远控全部跑在这套抽象上。

- 入口：`src/index.ts`（**开头就是作者画的架构图注释，全仓库最值得读的 30 行**）
- 内部：`foundation.ts`（事件系统）、`buffer.ts`（二进制缓冲）、`serialization.ts`、`channels.ts`、`persistent-protocol.ts`（断线重连语义）、`remote.ts`
- 🔍 先看：`src/index.ts` 的 7 层图，然后对照 [01 章](./01-ts-primer.md) 第 5 节看它的 `Event<T>` 泛型设计

### 2.4 `packages/provider` 与 `packages/provider-node` — 模型接入层

- **provider**（平台无关）：模型 Provider 的注册、解析、配置合并——「用户配置了哪些模型服务、每个会话用哪个模型」的决策层。依赖 `zod` + `shared`
- **provider-node**（Node 实现）：配置文件读写、内置 Provider 配置的下载/缓存/物化（`zcode-builtin-*` 系列）、运行时路径
- 🔍 先看：`provider/src/index.ts`、`provider/src/registry.ts`

### 2.5 `packages/services` — 业务服务集合（最大的包）

约 50 个业务域目录，每个目录一个自洽的服务：`session/`（会话）、`git/`、`file/`、`fs/`、`terminal/`、`plugins/`、`oauth/`、`storage/`（受管控的样板模块，domain/app/adapters 三层）、`settings-sync/`、`remote-sync/`、`telemetry/`、`zcode-agent/`、`zcode-session/`……

- 入口：`src/index.ts` + `src/accessor.ts`（服务访问器）；另有 `src/node.ts` 提供 Node 侧入口（server 就从 `@zcode/services/node` 拿 `createLocalServices`）
- 🔍 先看：`src/accessor.ts`（理解服务怎么被查找和组装）

### 2.6 `packages/client` — Agent 客户端 SDK

UI 侧连接 Agent 的客户端：把浏览器 `WebSocket`（`websocket.ts`）、窗口 `MessagePort`（`messageport.ts`）等传输包装成 rpc 的 `ISocket`，再连到服务/Host。远程服务访问在 `remoteServiceAccess.ts`。

- 入口：`src/index.ts`
- 🔍 先看：`src/websocket.ts` 开头——「把浏览器 WebSocket 适配成 RPC 传输」是绝佳的适配器模式教材

### 2.7 `packages/ui` — 共享 React 组件库（依赖最多：62 个）

桌面与 Web 共用的整个界面层：组件、hooks、Zustand store、i18n。

- 入口：`src/index.ts`；顶层 `App.tsx` / `Root.tsx` 是应用骨架
- 关键内部目录：`store/`（全局状态）、`hooks/`（**UI 访问服务的唯一通道**）、`components/`（基础组件）、`settings/`、`terminal/`、`ToolCallBlocks/`（AI 工具调用的展示块）、`prompt-editor/`（Lexical 输入框）、`i18n/`、`v4/`（对接 Protocol v4 的界面适配）、`workers/`、`GitPane/`、`WorkspaceSidebar/`
- 🔍 先看：`src/logger.ts`（UI 日志约定）、`src/store/` 任一 store（对照 Zustand 文档）
- 注意：视觉规则全部在 `DESIGN.md`（`text-ui-*` 字体 token 是硬约束）

### 2.8 `packages/server` — HTTP/WS 后端

托管 Web 页面 + 提供 API/WebSocket 的服务端，基于 Hono。

- 双入口：`src/entry-http.ts`（HTTP 服务，默认端口 3030，支持 `ZCODE_SERVER_AUTH_TOKEN` 鉴权）与 `src/entry-stdio.ts`（stdio 模式，供桌面/CLI 以子进程方式拉起）
- 内部：`http.ts`（Hono 应用与路由）、`stdio*.ts`（stdio 生命周期与服务）、`remote/`（远程连接）

### 2.9 `packages/zcode-server-cli` — 独立 Server 进程管理器

把 server 当作受管子进程来启动/监督的 CLI（`bin: zcode`），含 `supervisor/`、`runtime/`、`ipc/`、`packaging/`。命令行发行包（`pnpm build:zcode` 产物）里 `zcode --web` 背后就是它。

### 2.10 `packages/web` — Web 客户端（薄壳）

浏览器入口。它自己几乎没有业务——UI 全在 `@zcode/ui`，这里只做装配：`src/main.tsx`（Vite 入口）+ `auth/`（登录页）+ `share/`（会话分享页）。开发命令 `pnpm dev:web`。

### 2.11 `packages/desktop` — Electron 桌面应用

三层结构 + 两个支撑目录：

| 目录 | 干嘛的 |
| --- | --- |
| `src/main/` | 主进程（150+ 文件）：窗口生命周期（`desktopWindow*.ts`）、自动更新（`autoUpdater.ts`）、托盘、深链、Agent Host 进程管理（`desktopHostProcess.ts`）、遥测、原生菜单 |
| `src/preload/` | 安全桥：把主进程能力以 `IPlatformService` 形状暴露给页面（UI 不直接碰 `window.zcode`） |
| `src/renderer/` | Chromium 里的 React 页面（复用 `@zcode/ui`） |
| `src/host/` | 窗口级 Local Host：会话运行时的宿主（AGENTS.md 里「每个窗口一个 window-scoped Host」指的就是它） |
| `src/scheduler/` | 进程调度 |
| `src/shared/` | main/preload/renderer 共用的类型与工具 |

- 构建产物入口：`out/main/index.js`（源码入口 `src/main/index.ts`）；打包用 `pnpm bundle:desktop`

### 2.12 其余三包（小包/特殊）

| 包 | 干嘛的 |
| --- | --- |
| `packages/formal-proof` | 独立的小型 Vite + d3 可视化应用（形式化证明展示页，有自己的 dev/build） |
| `packages/zcode-cua` | Computer Use（电脑操作）能力的**API 占位包**：当前构建不含真实能力，所有运行时接口报告不可用并「fails closed」（来自其 `package.json` 描述） |

---

## 3. 嵌套 workspace：`apps/zcode-cli`

Agent CLI、TUI 与运行时的完整源码（README：「作为普通目录随本仓库克隆」）。它有**自己的** `package.json`、`pnpm-workspace.yaml`、`turbo.json`、`AGENTS.md`（CLI 专属规范）和 `.release-it.json`（独立发版）。

顶层目录：`packages/`（16 个子包）、`tools/`、`scripts/`、`dependencies/`（预构建依赖）、`.husky/`。

### 3.1 子包地图（自底向上）

| 子包 | 一句话职责 | 关键结构 |
| --- | --- | --- |
| `shared-types` | 纯类型包（只有 `src/index.ts`） | —— |
| `contracts` | Agent 侧的 zod schema 契约层（zod 3 + zod-to-json-schema，供工具声明转 JSON Schema）：`capabilities/`、`tools/`、`events/`、`commands/`、`hooks/`、`tracing/` 等 21 个领域目录 | `src/index.ts` |
| `i18n` | Agent/TUI 的多语言文案：`locales/` 目录 + 类型化的 key | `src/index.ts` |
| `telemetry` | OpenTelemetry 封装：Agent 链路追踪（`agent-trace-*.ts`）、OTLP 导出、错误脱敏（`error-sanitizer.ts`） | `src/index.ts` |
| `dynamic-workflow` | 动态工作流**编译器**：`schema/ → analysis/ → compiler/ → lowering/ → engine/`，把工作流定义编译成可执行物 | `src/index.ts` |
| `dynamic-workflow-runtime` | 工作流的运行时外壳：子进程入口、harness、协议 | `src/index.ts` |
| `core` | **Agent 核心**：会话、工具、权限、子代理 | 见下方专段 |
| `adapters` | **外部世界 I/O 适配层**（22 个域目录） | 见下方专段 |
| `node-repl-host` | 内置 MCP server：托管 JS REPL 执行面，带 Browser Use / Computer Use 桥 | `server.ts`、`browser-bridge.ts`、`cua-bridge.ts` |
| `browser-use-plugin` | 以官方内置插件发布的 Browser Use 技能与客户端运行时 | `browser-client.ts`、`dist/mcp/server.js` 入口 |
| `bootstrap` | **组装层**：把 core/adapters/provider/插件/技能/协议装配成可运行的 Agent。`zcode-protocol-entrypoint.ts` 是协议入口；`sessions.ts`、`plugins.ts`、`skills.ts`、`model-factory.ts` 各管一块装配 | `src/index.ts` |
| `tui` | **终端界面**：用 opentui-react（React 渲染到终端！）写的完整 TUI，110+ 个 `app-*.tsx`：输入面板、审批面板、侧栏、markdown/代码高亮（shiki + tree-sitter）、子代理视图 | `src/tui.tsx`、`src/app.tsx`、`src/state.ts` |
| `cli` | **`zcode` 二进制入口**（`bin: dist/zcode.cjs`）：参数解析、TUI/协议双模式分流、无头浏览器/工作流等子命令 | 见下方专段 |
| `debug` | 开发期调试 UI（Vite + React + vis-timeline 时间线 + mitm 代理） | `main.tsx`、`App.tsx` |
| `swift-bridge` | Swift 互操作占位包（`package.json` 自述 placeholder） | —— |

### 3.2 三个最核心的子包

**`core` — Agent 的大脑**（入口 `src/index.ts` 导出 `AgentRuntime`）：

- `agent/`、`runtime/`：AgentRuntime 及其方法（`runtime/methods/` 下每个文件一个能力：生成文本、工作流启停、rewind/fork 等，`runtime.ts` 导出可见）
- `tool/`：工具系统；`permission/`：权限审批；`subagent/`：子代理；`mcp/`：MCP 客户端；`memory/`、`compact/`（上下文压缩）、`repl/`、`hooks/`、`session-context/`、`system-reminder/`

**`adapters` — Agent 的手脚**（唯一被允许碰外部世界的地方）：

- `model/`：对接 Vercel AI SDK（anthropic / openai / openai-compatible）
- `fs/`、`exec/`、`http/`、`network/`、`storage/`：文件、子进程、网络（Agent 的读写执行都收敛在这）
- `browser/`：playwright-core 驱动浏览器；`mcp/`：MCP 客户端；`skills/`、`plugins/`、`workflow/`、`image/`、`pdf/`、`logging/`、`config/`、`auth/`……

**`cli` — 进程入口的教科书**（`src/main.ts`）：

开头 60 行示范了真实 CLI 的复杂度：区分「TUI 调用」还是「协议服务调用」、把 console 重定向到 stderr 以免污染 stdout 协议帧、清洗 shell 注入的环境变量、SEA（单文件可执行）运行时准备。读它配合 `AGENTS.md` 的「进程、协议」章节效果最好。

### 3.3 `tools/`

| 工具 | 干嘛的 |
| --- | --- |
| `prompt-trajectory` | 记录/导出提示词轨迹的开发工具（`record` / `derive` / `model-io` 脚本） |
| `typescript` | 钉制的 TypeScript 构建辅助 |

---

## 4. 把地图串起来：一次对话的旅程

以「在桌面版里对 Agent 说『帮我改个 bug』」为例（简化叙事，帮助建立直觉）：

1. 你在输入框敲字 —— 那是 `packages/ui` 的 Lexical 编辑器（`prompt-editor/`），状态进 Zustand store
2. 发送 —— 消息经 `packages/client` 的连接（桌面走窗口 Host，Web 走 WebSocket）打包成 **ZCode Protocol v4** 帧
3. 帧抵达 Agent 侧 —— `apps/zcode-cli` 的 `cli` 进程（协议模式）交给 `bootstrap` 组装出的运行时
4. `core` 的 AgentRuntime 做准入（`CommandInbox` 串行化）→ 组织上下文 → 通过 `adapters/model` 调用 AI SDK → 模型开始流式回复
5. 模型说「我要改文件」 —— `core/permission` 发起权限审批，`tui`/`ui` 弹出审批卡片；批准后 `adapters/fs`、`adapters/exec` 真正落盘执行
6. 每一步事件沿原路流式回来 —— UI 用 streamdown 渲染 Markdown、ToolCallBlocks 渲染工具卡片，全程 `rpc` 负责transport，`shared` 的 schema 负责「谁也不许发错格式」

读到任何看不懂的环节，回本章查那个包的卡片即可。

---

## 延伸阅读

- 仓库自带的规范：`AGENTS.md`（工作流）、`DESIGN.md`（UI）、`CONTEXT.md`（插件商店词汇）、`architecture-policy.yaml`（模块管控）
- 本教程其他章：[01 · TS 预备章](./01-ts-primer.md) · [02 · 技术栈清单](./02-tech-stack.md) · [04 · RPC 框架](./04-rpc-framework.md) · [05 · Agent 核心循环](./05-agent-core.md) · [06 · UI 与状态管理](./06-ui-state.md) · [07 · 协议与插件系统](./07-protocol-plugins.md)
