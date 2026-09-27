# 05 · Agent 核心循环

> 本章你将学到：`apps/zcode-cli/packages/core` 里 `AgentRuntime` 的整体结构；一次对话（一个 **turn**）从「用户敲下回车」到「模型回复完成」经过的 10 个状态；工具调用与权限审批如何穿插其间。
>
> 前置知识：[03 章](./03-repo-map.md) 的 Agent 侧分层（cli → bootstrap → core/adapters）、[04 章](./04-rpc-framework.md) 的事件模型。core 是全仓库最复杂的包，本章教你抓主干——**状态机 + 命令队列 + 端口注入**三个关键词。

---

## 0. 一句话总览

> 用户输入被**串行准入**成命令 → 命令驱动一个**回合状态机** → 状态机在「问模型」和「跑工具」之间循环 → 每一步都以**事件**流出给 UI → 直到回合终结。

## 1. core 的位置与自我约束

回顾 [03 章](./03-repo-map.md) 的分层：`cli`（入口）→ `bootstrap`（组装）→ `core`（大脑）+ `adapters`（手脚）。core 的纪律是：**它不碰任何真实世界**——不读文件、不发网络请求、不开子进程。所有外部能力都通过「端口（Port）」接口表达，由 adapters 提供实现。看 `runtime/agent-runtime.ts` 的依赖清单（节选自 `deps.ts` 导入的类型）：

```ts
FileSystemPort      // 文件读写
ExecutionPort       // 子进程执行
McpPort             // MCP 服务器连接
SkillPort           // 技能加载
SubagentPort        // 子代理
SessionStorePort    // 会话持久化
ModelCatalogPort    // 模型目录
PermissionBrokerPort // 权限审批（问 UI 要决定）
DynamicWorkflowRunPort // 工作流运行
// ...
```

> 💡 **TS 知识点：Port = 依赖倒置的接口约定**
> 每个_Port_只是一个 interface（如 `FileSystemPort` 声明「能读能写」），core 只 import 类型、不 import 实现——实现全在 `adapters` 包。这正是 [01 章](./01-ts-primer.md) `import type` 一节的价值：**core 对 adapters 的全部认知是一组类型**，依赖方向干净，测试时也能塞假实现。数一数上面的清单你会发现：[02 章](./02-tech-stack.md) 里那些「为什么业务逻辑不直接调 fs/http」的仓库规范，落地成的就是这一排 Port。

## 2. AgentRuntime：门面 + 按文件挂方法

🔍 `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`

`AgentRuntime` 是 core 对外的唯一门面（[03 章](./03-repo-map.md) 提过 `index.ts` 只导出它和一个 `RuntimeFactory`）。它的组织方式很值得学：

- 构造时注入全部 Port 和基础件：`createToolRegistry()`、`ToolScheduler`、`PermissionService`、`MessageHistoryImpl`、`EventReducer`……
- 方法体不堆在一个文件里：`installAgentRuntimeMethods()` 把 `runtime/methods/` 下**一个能力一个文件**的实现挂到实例上（生成文本、rewind/fork、compact、工作流启停、后台任务……170+ 个文件因此各司其职，单文件 ≤400 行的仓库规则才能守住）

## 3. 心脏：回合状态机

🔍 `apps/zcode-cli/packages/core/src/agent/turn-state.ts`、`turn-machine.ts`

一个 turn（回合）= 「用户的一次完整输入 → 最终回复」。状态机只有 10 个相位：

```text
Idle → ProcessingInput → AwaitingModelResponse → Streaming
     → SchedulingTools → ExecutingTools ⇄ AwaitingPermission
     → AggregatingResults → Completing →（下一个回合，回到 AwaitingModelResponse）
                                      ↘ Error（任意相位可进）
```

真实定义是一个 `as const` 对象（`turn-state.ts` 原文）：

```ts
export const TurnPhase = {
  Idle: "idle",
  ProcessingInput: "processing_input",
  AwaitingModelResponse: "awaiting_model_response",
  Streaming: "streaming",
  SchedulingTools: "scheduling_tools",
  ExecutingTools: "executing_tools",
  AggregatingResults: "aggregating_results",
  AwaitingPermission: "awaiting_permission",
  Completing: "completing",
  Error: "error",
} as const;

export type TurnPhase = (typeof TurnPhase)[keyof typeof TurnPhase];
```

`TurnMachine` 的方法与相位一一对应（`turn-machine.ts`）：`startModelRequest()`、`addStreamingContent()`、`scheduleTools()`、`startToolExecution()`、`completeTool()`、`requestPermission()`/`resolvePermission()`、`queuePendingInput()`/`drainPendingInputs()`（执行中插话排队）、`aggregateResults()`、`complete()`/`fail()`。**合法迁移由 `canTransitionTo()` 把关**——想在 `Idle` 直接 `complete()`？状态机直接拒绝。

> 💡 **TS 知识点：`as const` 对象——比 enum 更流行的枚举写法**
> `as const` 把对象锁成「只读且字面量类型」；`(typeof TurnPhase)[keyof typeof TurnPhase]` 一行取出**所有值的联合类型**（`"idle" | "processing_input" | ...`）。效果等价于 `enum`，但没有运行时开销，且值的类型是纯字符串字面量——序列化成 JSON 后再 `switch` 收窄，每个分支自动获得精确类型。本仓库大量使用这个模式（协议、状态、模式定义几乎都是），读到了就认出来。

`TurnState` 接口是回合的全部记忆：`phase`、`modelRequest`（发出去的请求）、`streamingContent`（流式累积的回复）、`toolCalls`/`toolResults`、`scheduledTools`、`pendingInputs`（插话队列）、`pendingPermissions`/`resolvedPermissions`、`resultType`、`error`。UI 上看到的「正在执行工具」「等待确认」角标，读的都是这些字段经事件投影出的视图。

## 4. 纪律：命令队列（CommandInbox 的 core 侧）

🔍 `apps/zcode-cli/packages/core/src/runtime/command-queue.ts`

用户在 Agent 忙时继续发消息怎么办？不是打断，而是**一切输入先变成命令排队**。每个命令携带：

```ts
type RuntimeCommandPriority = "now" | "next" | "later";
type RuntimeCommandMode =
  | "prompt"                      // 用户输入
  | "target-continuation"         // 目标续跑
  | "target-continuation-loop"
  | "task-notification"           // 后台任务完成通知
  | "subagent-message"
  | "control-only-turn";
```

命令对象的字面量类型联合（`PromptRuntimeCommand`、`TaskNotificationRuntimeCommand`…）+ `resolve`/`reject` 回调，构成经典的 **Deferred 模式**：入队方拿到 Promise，队列消费后用命令自带的 `resolve(turnResult)` 兑现。`PromptRuntimeCommand.startReservation` 的注释值得一读：「admission 已建立的 reservation；执行阶段不得再次创建/竞争 turn」——AGENTS.md 里反复强调的 **CommandInbox 串行 admission / stale run 防护**，代码落点就在这。

> 💡 **TS 知识点：Branded Type——给 string 发「身份证」**
> `command-queue.ts` 原文：
>
> ```ts
> export type RuntimeCommandId = string & {
>   readonly __runtimeCommandId: unique symbol;
> };
> ```
> 本质还是 string，但 TS 现在认为「普通 string」不能直接赋给 `RuntimeCommandId`——必须经过构造函数加工。这样「随便一个字符串」和「合法的命令 id」在类型层面就是两种东西，传错参编译期就报错。**用交叉类型 `&` 加一个幽灵字段做「品牌烙印」**，是 TS 防混用的标准手法；`SessionId`、`TurnId`、`ToolCallId`（来自 contracts 包）全是这个套路。

## 5. 手脚：工具系统

🔍 `apps/zcode-cli/packages/core/src/tool/`（28 个文件）

模型回「我要读文件」，真正的执行链是：

- `registry.ts`：工具注册表——每个工具声明 `inputSchema`（zod）、是否只读、副作用范围（对照 `AGENTS.md`「工具与副作用契约」）
- `model-contract.ts`：把工具契约转成模型认识的声明（发给模型的是 schema，不是代码）
- `scheduler.ts` + `executor.ts`：调度与执行；`input-normalization.ts`、`input-validation-*.ts` 在执行前清洗/校验模型给的参数（**模型会出错，参数不可信**）
- 安全护栏文件一目了然：`path-policy.ts`（路径越界防护）、`bash-timeout-policy.ts`、`webfetch-preapproved.ts`（域名白名单）、`tool-visibility.ts`
- `read-file-state.ts`：记住「这个文件此刻读到的版本」——之后 `edit` 工具靠它检测「文件是否被外部改过」（对照 [04 章](./04-rpc-framework.md) 的乐观并发思路）
- `diff.ts`：把 edit 前后变成 diff 供 UI 展示

## 6. 灵魂一问：权限审批如何穿过进程

🔍 `apps/zcode-cli/packages/core/src/permission/`（`service.ts`、`broker.ts`、`rule-matching.ts`、`plan-mode-policy.ts`）

模型要执行有副作用的工具时：

1. `PermissionService` 先按规则自动判定（`rule-matching.ts` 的允许/拒绝规则、`plan-mode-policy.ts` 的 Plan 模式限制）
2. 判不了的就通过 `PermissionBrokerPort` **发出请求事件**——注意 core 只发事件，不弹窗
3. 请求经 [04 章](./04-rpc-framework.md) 的 RPC 通道流到 UI，用户点「允许」
4. 决定事件流回来，`TurnMachine.resolvePermission()` 让回合从 `AwaitingPermission` 继续前进

对应 AGENTS.md 的不变量：「已接受输入由 CLI/runtime CommandInbox 串行 admission；Renderer 只保留草稿与 pending overlay」。状态机停在 `AwaitingPermission`，UI 上的审批卡片就是这一相位的事件投影——**UI 不是权威，状态机才是**。

## 7. 记忆与流出

- `agent/message-history.ts`：对话历史（模型上下文的原料）；`message-history-usage.ts` 统计 token 占用
- `runtime/helpers/compact*.ts` + `agent/compact-session.ts`：上下文快满时自动**压缩**（ summarize 旧对话、保留关键文件状态），对应 `methods/compact.ts` 的对外方法
- `runtime/execution-state.ts`、`helpers/steering.ts`：执行态与「转向」输入（执行中插话的语义）
- 事件出口：`EventReducer` + `SessionEventSink`（构造时注入）——core 把一切变化广播为**会话事件**，[04 章](./04-rpc-framework.md) 的通道负责送达，UI 侧 store 只做投影

---

## 8. 动手环节

1. 打开 `apps/zcode-cli/packages/core/src/agent/turn-state.ts`，把 10 个 `TurnPhase` 抄在纸上，凭理解画出迁移箭头，再对照 `turn-machine.ts` 的方法签名核对。
2. 全仓库搜索 `canTransitionTo` 的实现，看非法迁移会怎样（抛错？断言？）。
3. 进阶：搜索 `RuntimeCommandId` 的构造处，找到「普通 string 如何被烙印」的代码；再找一个其他 `XxxId` branded type，体会这套命名的一致性。

---

**下一章**：[06 · UI 与状态管理](./06-ui-state.md) —— 事件流到浏览器之后：`packages/ui` 的 store、hooks 与服务访问层。
