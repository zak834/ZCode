# 07 · 协议与插件系统

> 本章你将学到：ZCode Protocol v4 如何组织（schema 纪律、快照/增量双语义、wire 编解码层）；MCP 适配层的真实结构；插件系统如何用「一个类型联合」表达全部能力。读完它，前六章就串成了完整闭环。
>
> 前置知识：[04 章](./04-rpc-framework.md)（传输）、[05 章](./05-agent-core.md)（状态机）、[06 章](./06-ui-state.md)（事件投影）。

---

## 0. 协议为什么值得单独一章

回顾全链路：用户输入经 [06 章](./06-ui-state.md) 的 hooks 发出 → [04 章](./04-rpc-framework.md) 的通道传输 → [05 章](./05-agent-core.md) 的 AgentRuntime 消费，事件原路流回。但**「流回去的东西长什么样、谁保证它没错、断线了怎么办」**——这些问题的答案就是协议。它是三方的契约：UI（消费事件）、Agent（生产事件）、持久化（恢复会话）。

## 1. ZCode Protocol v4：schema 与纯函数的领地

🔍 `packages/shared/src/zcode-protocol-v4/`（46 个文件，与旧的 `zcode-protocol/` 并存）

`index.ts` 的头注释给整个包立了规矩（原文）：

> 本包纪律：只放 **schema 类型 + 纯函数**（coalesce/conflation/apply），运行时（通道层缓冲、订阅注册表、调度）一律不进本包。

协议包 = 「数据长什么样（schema）」+「怎么从旧状态算出新状态（纯函数）」，**不含任何 IO 与可变全局**——这就是它能被 UI、Agent、测试三方共享而互不干扰的原因。46 个文件按职责分五组：

| 组 | 文件 | 职责 |
| --- | --- | --- |
| 数据模型 | `core.ts`、`rows.ts`（会话消息行）、`toolDisplay.ts`（工具卡片显示）、`session-config.ts` | 定义实体 schema |
| 状态全景 | `snapshot.ts`（ConversationSnapshot）、`sessions-index.ts`（会话列表索引） | 「某一刻的完整真相」 |
| 增量与归并 | `delta.ts`、`coalesce.ts`、`apply.ts` | 「变化量」与「把变化应用到快照」的纯函数 |
| 线上编解码 | `wire.ts`、`wire-codec.ts`、`wire-binary.ts`、`wire-assembler.ts`、`wire-reassembly.ts` | 消息上线下线：编码、二进制、分片组装、**缺口重 assembly**（手机弱网的关键） |
| 交互语义 | `command.ts`、`submission.ts`（提交）、`input-intent.ts`、`controller.ts`、`fork.ts`、`cuaPermission.ts`… | 命令与控制面 |

`snapshot.ts` 里随手可见两个高价值设计（都有注释原文背书）：

- **会话相位枚举**：`draft → prewarming → running → completedSuccess / completedInterrupted / error`（`zod` 的 `z.enum`）——和 [05 章](./05-agent-core.md) 的 TurnPhase 呼应，但这是**跨进程可见**的版本
- **A 区整体替换原则**：「字段级整体替换（state.updated），绝不深合并——深合并是错乱之母」。应用增量时，被更新的字段整体换新值，而不是递归合并旧值——一击消除「旧值残留」这类最难查的状态 bug

> 💡 **TS 知识点：`z.infer`——一份定义，两头使用**
> ```ts
> export const sessionPhaseSchema = z.enum(["draft", "prewarming", ...]);
> export type SessionPhase = z.infer<typeof sessionPhaseSchema>;
> ```
> zod schema 是**运行时校验器**，`z.infer` 从它反推出**编译期 TS 类型**——类型永远和校验逻辑一致，不存在「schema 加了字段、类型忘了同步」。这就是 [01 章](./01-ts-primer.md) 第 6 节 zod 登场的完全体：协议文件几乎每个导出都是 `xxxSchema` + `type Xxx = z.infer<...>` 成对出现。另外注意 `index.ts` 里那条有趣的警告：`workflow-artifact.ts`（单数）与 `workflow-artifacts.ts`（复数）只差一个字母且含义不同——协议作者特意在导入处留言防止后来者拿错。

## 2. 两种流式语义：协议层面的殊途同归

AGENTS.md 反复要求「同时验证」的两种链路，协议层各有专门支撑：

```text
desktop-continuous（桌面实时直连）      web-remote-replayable（手机/弱网可恢复）
  事件即时逐条推送                        服务端留存 snapshot
  靠 Socket 的实时性                      事件经 wire 分片编码（wire-assembler）
  [04 章] PersistentProtocol ACK 保序     断线 → 重连 → snapshot 打底
                                          + 缺口重放（wire-reassembly）补齐
              └────────── 同一份 snapshot/delta 数据模型 ──────────┘
```

记忆点：**continuous 靠「别丢」，replayable 靠「丢了也能补」**。relay/Main 进程不存业务状态（只鉴权、配对、转发），所以恢复所需的一切都在协议数据模型里，而不是某个中间人手里。

## 3. MCP：给 Agent 接外部工具的标准接口

**MCP（Model Context Protocol）** 是「AI 应用 ↔ 工具服务」的开放协议：工具方起一个 MCP server 声明「我能做什么」，Agent 作为客户端连接后发现并调用这些工具——Agent 本体不需要为每个工具写集成代码。

ZCode 两头都当：

- **客户端**：`apps/zcode-cli/packages/adapters/src/mcp/`（19 个文件）——连接生命周期一眼可辨：`descriptor.ts`（服务器描述）、`pool.ts`（连接池）、`stdio-transport.ts`（子进程型 server）与 `network.ts`（网络型）、`timeout.ts`、`process-tree.ts` + `windows-job-object.ts`（Windows 进程树清理——跨平台细节的活教材）、`telemetry.ts`，以及占了一半的 `oauth-*.ts`（9 个文件：给需要鉴权的远程 MCP server 走 OAuth，含租约 `oauth-lease.ts` 与静默刷新）
- **服务端**：内置两个 MCP server——`node-repl-host`（JS 执行面 + Browser Use/Computer Use 桥）和 `browser-use-plugin`（[03 章](./03-repo-map.md) 的卡片）

core 侧对应的抽象是 [05 章](./05-agent-core.md) 见过的 `McpPort`：工具发现结果进入 `tool/registry.ts`，模型用 MCP 工具和用内置工具毫无区别。

## 4. 插件系统：类型联合即产品说明书

插件是能力的分发单元。先补词汇（完整版见根目录 `CONTEXT.md`）：**Official Marketplace**（官方唯一分发渠道，id `zcode-plugins-official` = 内置插件 + CDN 插件）与 **Personal Source**（用户自加的 git/URL/本地目录来源）；目录条目携带的展示信息叫 **Store Listing**，插件包内 `plugin.json` 的功能定义叫 **Plugin Manifest**。

功能侧的类型定义在 `packages/shared/src/plugin-types.ts`，开场第一行就是全局：

```ts
export type PluginComponentType = "agent" | "command" | "skill" | "hook" | "mcp" | "lsp";
```

> 💡 **TS 知识点：字符串字面量联合当「枚举清单」用**
> 一个插件 = 这六种组件的任意组合：可以带一个 agent 定义、几个 slash command、技能、钩子、MCP server、语言服务。类型上它是字面量联合，界面上 `[componentTypes]` 直接渲染成徽标；协议传输后用 `includes()` 或 `switch` 收窄（[02 章](./02-tech-stack.md) AI SDK 卡片的同款手法）。**一个 union，三处受益**：schema 校验、类型提示、UI 分支。

其余关键类型同样自解释：

- `PluginMarketplaceSummary`（`isOfficial` 区分官方/个人来源）、`AvailablePluginSummary`（`installed` 未装）与 `InstalledPluginSummary`（`enabled`/`scope: "workspace" | "user"`）——「可安装」和「已安装」是两个形状
- `PluginsCapability { supported: boolean; reason?: "desktop_only" | "missing_cli" }`——**能力探测**模式：功能不一定可用（比如 Web 版没有插件目录管理），与其让用户撞报错，不如先问一句「支持吗？不支持的原因是什么」；界面据此隐藏入口或提示原因

生命周期状态机（`CONTEXT.md` 的「Plugin Lifecycle」）：发现 → 安装 → 配置/启停 → 使用 → 更新 → 卸载。两个反直觉状态要记住：**Restorable Builtin**（被卸载的内置插件进入持久化抑制，重启不会自动回种）与 **Orphaned Installed Plugin**（来源被删但插件仍可用）。UI 侧的商店逻辑在 `packages/ui/src/store/pluginStore.ts` 与 `pluginManagementStore*.ts`，运行时逻辑在 `apps/zcode-cli/packages/adapters/src/plugins/`——一个界面一个运行时，又是「UI 不是权威」。

---

## 5. 收官：把七章串成一张图

```text
你在输入框打字（06 · Lexical/hooks）
  → 提交为协议命令（07 · submission/command schema）
  → 通道传输（04 · RPC：stdio / WebSocket / MessagePort + PersistentProtocol）
  → 串行准入（05 · CommandInbox 命令队列）
  → 回合状态机（05 · TurnPhase 循环：模型 ⇄ 工具 ⇄ 权限）
  → 模型调用（05/07 · adapters/model 的 AI SDK；MCP 工具在注册表待命）
  → 工具执行（05 · registry/scheduler/executor + adapters 的真实 IO）
  → 事件回流出线（07 · delta → wire 编解码；弱网走 snapshot 补齐）
  → 状态投影（06 · store/hooks）→ 界面更新（06 · 组件 + text-ui-* token）
  → 插件扩展其中每一层（07 · agent/command/skill/hook/mcp/lsp）
```

学到这里，你已经有了完整的地图。接下来推荐三条路：**跑起来改一行**（`pnpm dev:web` 热更新最直观）；**挑一条链路精读**（推荐从 `packages/rpc/examples/` 到 `stdio.ts` 的真实接线）；**用仓库自带的规范自查**（`AGENTS.md` 的架构工作流 + `pnpm architecture:check -- --changed`）。

## 6. 动手环节

1. 打开 `packages/shared/src/zcode-protocol-v4/snapshot.ts`，找到 `sessionPhaseSchema`，对照 [05 章](./05-agent-core.md) 的 TurnPhase 说出两者关系（提示：一个是引擎内部、一个是跨进程投影）。
2. 全仓库搜索 `z.infer<typeof`，浏览前 10 个结果，感受「schema + type 成对导出」的密度。
3. 进阶：在 `packages/ui/src/store/pluginStore.ts` 里找 `PluginComponentType` 的消费处，看六种组件如何驱动商店 UI 的分组展示。

---

**全系列完** · 返回 [README · 学习路线图](./README.md) 复盘整个路径。
