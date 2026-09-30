# 05 · Agent 核心循环（Agent 是如何设计的）

> 本章你将学到：`apps/zcode-cli/packages/core` 里 `AgentRuntime` 的**完整设计**——入口的命令队列、回合状态机与主循环、流式聚合、工具系统的 15 步执行管线、权限审批链、记忆机制、多智能体管理、事件流出。本章按「数据怎么流」的顺序组织，每一节都给出真实文件路径与关键代码，目标是：**看完之后，你可以从零复现整个 Agent**。
>
> 前置知识：[03 章](./03-repo-map.md) 的 Agent 侧分层（cli → bootstrap → core/adapters）、[04 章](./04-rpc-framework.md) 的事件模型、[01 章](./01-ts-primer.md) 的 branded type 与 `as const`。

---

## 0. 全景：一个 Agent 由哪几块骨头搭成

先给整章定锚。ZCode 的 Agent 本质上是一个**带工具调用能力的对话循环**，外加五套让它在生产环境站得住的「纪律设施」：

```text
用户输入
  ↓
③ 命令队列（串行准入，一切输入先排队）
  ↓
④ 回合状态机 + 主循环（while(true)：问模型 → 跑工具 → 再问模型）
  ↓                    ↓
⑤ 流式聚合          ⑥ 工具系统（契约/调度/15步执行/权限门/文件一致性）
  ↓                    ↓
⑦ 记忆与上下文（ContextBuilder 组装 prompt；compact 三级压缩；memory 文件）
  ↓
⑧ 多智能体（子代理 = 同进程嵌套的另一个 AgentRuntime）
  ↓
⑨ 事件流出（一切变化都变成事件，UI 只是投影）
```

**复现路线图**：如果只搭最小可用版本，你需要 ③④⑥⑨ 四块（队列、循环、工具、事件）；⑤ 让体验流畅，⑦ 让它「越用越懂你」，⑧ 让它能委派任务。第 10 节给出按依赖顺序的搭建清单。

> 💡 **设计思想：UI 不是权威，Runtime 才是**
> 全章反复出现的一句话。UI 上看到的一切（转圈、审批卡片、工具进度）都是**事件投影**，真正的状态只存在于 core 的状态机与队列里。这保证了：断线重连、多端（桌面/手机）观感一致，以及——重复提交、插话、取消这些最难写的场景有唯一仲裁者。

## 1. core 的位置与自律：端口注入

回顾 [03 章](./03-repo-map.md) 的分层：`cli`（入口）→ `bootstrap`（组装）→ `core`（大脑）+ `adapters`（手脚）。core 的纪律是：**它不碰任何真实世界**——不读文件、不发网络请求、不开子进程。所有外部能力都通过「端口（Port）」接口表达，实现全在 `adapters`/`bootstrap`：

```ts
// core 只 import 这些类型，不 import 实现
FileSystemPort         // 文件读写
ExecutionPort          // 子进程执行
McpPort                // MCP 服务器连接
SkillPort              // 技能加载
SubagentPort           // 子代理（launch/run/waitForTask/stopTask/sendMessage）
SessionStorePort       // 会话持久化
ModelCatalogPort       // 模型目录
PermissionBrokerPort   // 权限审批（问 UI 要决定）
DynamicWorkflowRunPort // 工作流运行
```

> 💡 **TS 知识点：Port = 依赖倒置的接口约定**
> 每个 Port 只是一个 interface（如 `FileSystemPort` 声明「能读能写」），core 对 adapters 的全部认知是一组类型。依赖方向干净，测试时塞假实现即可。`SubagentPort` 定义在 `contracts/src/interfaces/subagent.port.ts`——连「多智能体」这种大功能，core 看到的也只是五个方法签名（见第 8 节）。

## 2. AgentRuntime：门面 + 原型方法安装

🔍 `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`、`runtime/methods/`

`AgentRuntime` 是 core 对外的唯一门面。它有一个非常值得学的组织技巧：

- **构造时注入全部 Port 和基础件**：`createToolRegistry()`、`ToolScheduler`、`PermissionService`、`MessageHistoryImpl`、`EventReducer`……这些字段构成「运行时内部上下文」，类型叫 `AgentRuntimeInternal`。
- **方法体不堆在一个文件**：`installAgentRuntimeMethods()` 把 `runtime/methods/` 下**一个能力一个文件**的实现挂到实例的 prototype 上——turn 循环（`turn-loop.ts`）、模型请求（`turn-model-step.ts`）、子代理（`subagent.ts`）、压缩（`compact.ts`）、事件（`events.ts`）……约 190 个方法各归各文件，单文件 ≤400 行的仓库规则才守得住。

```ts
// 每个方法文件的标准形态：首参显式声明 this 类型
export async function runTurn(this: AgentRuntimeInternal, cmd: PromptRuntimeCommand) {
  // this 就是注入了全部依赖的运行时上下文
}
```

> 💡 **TS 知识点：`this` 参数类型**
> TS 允许把 `this` 写成函数的第一个参数（纯类型标注，不产生运行时代码）。方法文件因此不 import 类实例、只 import 类型，避免循环依赖；调用时 TS 自动校验 `this` 匹配。这是「拆文件不拆内聚性」的关键。

## 3. 入口纪律：命令队列与串行 admission

🔍 `apps/zcode-cli/packages/core/src/runtime/command-queue.ts`、`runtime/methods/prompt-admission.ts`、`runtime/methods/runtime-command-queue.ts`

用户在 Agent 忙时继续发消息怎么办？不是打断，而是**一切输入先变成命令排队**。两个核心类型（原文节选）：

```ts
export type RuntimeCommandPriority = "now" | "next" | "later";

export type RuntimeCommandMode =
  | "prompt"                    // 用户输入
  | "target-continuation"       // 目标续跑
  | "target-continuation-loop"
  | "task-notification"         // 后台任务完成通知
  | "subagent-message"          // 子代理发来的消息
  | "control-only-turn";
```

优先级决定出队顺序：`now`（打断性控制）> `next`（插话/通知，当前模型请求一结束就插队）> `later`（普通排队）。命令对象是字面量类型联合（`PromptRuntimeCommand`、`TaskNotificationRuntimeCommand`…），且带 `resolve`/`reject` 回调，构成经典的 **Deferred 模式**：入队方拿到 Promise，队列消费后用命令自带的 `resolve(turnResult)` 兑现。

**串行 admission 与 stale run 防护**（AGENTS.md 不变量的代码落点）有两个精巧设计：

1. **先建 reservation 再入队**：`PromptRuntimeCommand.startReservation` 的注释是「admission 已建立的 reservation；执行阶段不得再次创建/竞争 turn」。admission 阶段（`prompt-admission.ts`）先原子地登记「即将开始的 turn」，再入队——消除「检查是否空闲」与「真正开始」之间的异步窗口，那个窗口正是重复 turn 的根源。
2. **drain 防重入 + 前台租约**：出队消费用 drain 循环并防重入；`foregroundPromotionLease` 租约约束「谁有权把某个 turn 提升为前台」，防止并发场景下两个路径同时抢同一个 turn。

> 💡 **TS 知识点：Branded Type——给 string 发「身份证」**
> `command-queue.ts` 原文：
>
> ```ts
> export type RuntimeCommandId = string & {
>   readonly __runtimeCommandId: unique symbol;
> };
> ```
> 本质还是 string，但 TS 认为「普通 string」不能直接赋给 `RuntimeCommandId`——必须经过构造函数加工。「随便一个字符串」和「合法的命令 id」在类型层面是两种东西，传错参编译期就报错。`SessionId`、`TurnId`、`ToolCallId`（contracts 包）全是这个套路。

## 4. 心脏：回合状态机与主循环

### 4.1 十相位状态机

🔍 `apps/zcode-cli/packages/core/src/agent/turn-state.ts`

一个 turn（回合）=「用户的一次完整输入 → 最终回复」。状态机只有 10 个相位（原文）：

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

合法迁移由迁移表 `canTransitionTo()` 把关。最关键的一条回路是工具结果回来之后**不是直接结束，而是再问一次模型**：

```ts
// turn-state.ts 迁移表节选：工具结果聚合后可以再进模型，形成 agent loop
[TurnPhase.AggregatingResults]: [
  TurnPhase.AwaitingModelResponse,  // ← 关键回路：带着工具结果再问模型
  TurnPhase.SchedulingTools,
  TurnPhase.Completing,
  TurnPhase.Error,
],
```

「Agent 会自己连续干活」这个魔法的全部秘密就在这一行：模型说「我要读文件」→ 执行 → 结果聚合 → **回到 AwaitingModelResponse** → 模型看到结果继续说下一步 → 循环，直到模型不再要求工具、进入 `Completing`。任意相位可进 `Error`。

`TurnState` 接口是回合的全部记忆：`phase`、`modelRequest`、`streamingContent`、`toolCalls`/`toolResults`、`scheduledTools`、`pendingInputs`（插话队列）、`pendingPermissions`/`resolvedPermissions`、`resultType`、`error`。

> 💡 **TS 知识点：`as const` 对象——比 enum 更流行的枚举写法**
> `as const` 把对象锁成「只读且字面量类型」；`(typeof TurnPhase)[keyof typeof TurnPhase]` 一行取出所有值的联合类型。效果等价于 `enum`，但没有运行时开销，序列化成 JSON 后再 `switch` 收窄，每个分支自动获得精确类型。

### 4.2 turn 主循环骨架

🔍 `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`

状态机之上的驱动器是一个 `while(true)`，每轮做八件事：

```text
while (true) {
  1. abort 检查        —— 取消请求随时生效
  2. 队列合流          —— 吸收 now/next 命令：插话合并进本轮、通知纳入上下文
  3. microcompact      —— 先做轻量清理（见 7.4）
  4. autoCompact 熔断  —— 上下文接近窗口上限时强制压缩；rapid-refill 防压完立刻又满的死循环
  5. 装配工具集        —— 基础工具 + 本轮可用的 MCP 工具（见 6.7）
  6. 注入 reminder     —— system-reminder 元信息（见 7.5）
  7. 消息投影          —— MessageHistory → 模型消息数组
  8. startModelRequest —— 进入模型请求；返回 ModelStepResult 决定去向
}
```

`turn-model-step.ts` 返回 `ModelStepResult = "continue" | "output_continuation" | "break"`：`"break"` 表示模型给出最终回复、回合完结；`"continue"` 表示模型要求调工具、回 `AggregatingResults → AwaitingModelResponse` 再转一圈。**主循环 + 迁移表，就是「agent loop」这四个字的全部实现。**

## 5. 单次模型请求：流式聚合

🔍 `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`、`streaming-recovery.ts`

模型请求是异步流式的，core 侧要做四件事：

1. **事件分类聚合**：`text_delta` 拼进 `streamingContent`；`tool_call` 按 id 去重合并；`tool_input_delta` 是工具参数的增量 JSON——按「换行或累计 4096 字符」flush 一次进度事件，避免 UI 被刷爆。
2. **有序写队列 + 背压**：流式块先进一个有界队列（高水位 128），队列满时上游等待——防止模型产出速度远超消费速度时内存膨胀。
3. **流式只读工具预执行**：`streaming-tool-coordinator` 在工具参数**还没流完**时就判断「这是个只读工具且参数已完整」，提前开跑——等模型说完，工具结果已经在手，省一个串行等待。只有 readOnly 工具敢这么做，因为预执行错了也无法回滚副作用。
4. **断流恢复**：网络断了怎么办？`streaming-recovery.ts` 记录已消费字节数（`discardedBytes`），重开请求时用 anchor 对齐续传，最多重试 10 次。配套纪律在 adapter 侧：「首个可见事件即重试边界，之后不重放」——一旦向下游发出过任何事件，这次请求就不允许整体重试，否则 UI 会看到回复重说一遍。

## 6. 手脚：工具系统

工具系统是 Agent 与真实世界的唯一通道，分五层：**契约 → 注册表 → 模型投影 → 调度 → 执行管线**。

### 6.1 ToolEntry：工具的唯一契约

🔍 `apps/zcode-cli/packages/core/src/tool/types.ts`

每个工具注册时声明一个 `ToolEntry`，关键字段：

```ts
interface ToolEntry {
  capability: { name: string; /* ... */ };
  metadata: {
    readonly: boolean;        // 只读？→ 影响能否并行、能否流式预执行
    destructive?: boolean;    // 有破坏性？→ 永不并行
    providerVisible?: boolean; // false = 内部工具，不发给模型
  };
  inputSchema: JsonSchema;         // 给模型看的（JSON Schema）
  runtimeInputSchema: ZodSchema;   // 给执行器用的（Zod，运行时强校验）
  permission?: { kind: "bash" | "edit" | "read" | "webfetch" | /* ... */ };
  resultBudget?: /* 输出截断预算 */;
  handler(ctx, input): Promise<ToolResult>;
}
```

**双 schema 是刻意的**：JSON Schema 给模型看（它只懂这个），Zod 给执行器用（运行时严格校验）。模型给的参数**永远不可信**——它会编造字段、写错类型、路径越界。

### 6.2 注册表与模型投影

🔍 `apps/zcode-cli/packages/core/src/tool/registry.ts`、`model-contract.ts`

- 注册表用**双 Map**：canonical 名 → 工具，别名 → canonical 名，查找时先查 canonical 再查别名。
- `toContracts()` 把 `ToolEntry` 投影成模型声明，**过滤掉 `providerVisible === false` 的内部工具**（如 `respond-to-coordinator`，只给子代理的通信机制用，不给模型主动调）。
- `tool-transform.ts`（adapters 侧）做 **strict schema 折叠**：Anthropic 等模型的 strict 模式不支持部分 JSON Schema 关键字，折叠器把它们降级写进 description——同一个工具，不同模型拿到的 schema 可能不同，但语义一致。

### 6.3 调度：拓扑排序 + 并行分组

🔍 `apps/zcode-cli/packages/core/src/tool/scheduler.ts`

模型一次可能要求调多个工具。调度器把工具调用组成**有向无环图**，拓扑排序后按依赖关系分组并行：

- `destructive` 工具**永不并行**（两个 edit 同时写一个文件是灾难）；
- `readOnly` 工具默认并行（三个 read 同时发）；
- 组内并发上限 `maxConcurrency = 10`。

有依赖（比如后一个工具需要前一个的结果）就串行；没有就并行。这一层决定了 Agent 的执行效率。

### 6.4 执行管线：15 步流水线

🔍 `apps/zcode-cli/packages/core/src/tool/executor/`（`call-runner.ts` 等 30 个文件）

单个工具调用的执行是严格的 15 步管线，每一步都可能短路：

```text
 1. 输入归一化           —— input-normalization.ts：模型输出的宽松修正
 2. 双 schema 校验       —— JSON Schema + Zod 各验一遍
 3. resolveInput         —— 引用解析（如子代理结果引用）
 4. PreToolUse hook      —— 钩子可改写输入或直接拦截
 5. 权限门               —— PermissionService 判定（见 6.5）
 6. 事件先行             —— 先发 tool_call 开始事件（UI 立刻看到）
 7. handler 执行         —— 超时 + abort 双保险包裹
 8. 输出双校验           —— handler 的返回也要过 schema（内部 bug 早暴露）
 9. resultBudget 截断    —— 输出太长按预算截断（保护上下文窗口）
10. PostToolUse hook     —— 后置钩子
11-15. 事件补全/持久化/后台任务接管/状态回写/完成事件
```

**关键设计：校验失败不炸整轮**。第 2/8 步校验失败时，生成一段「模型可见的纠错内容」当作工具结果返回——模型下一轮看到「你的参数错了，因为……」，自己修正重试。**自纠错**而不是整轮失败，这是 Agent 稳定性的核心来源之一。

### 6.5 权限审批：15 级判定链

🔍 `apps/zcode-cli/packages/core/src/permission/`（`service.ts`、`broker.ts`、`rule-matching.ts`、`plan-mode-policy.ts`）

模型要执行有副作用的工具时，`PermissionService` 按**固定顺序**判定，命中即停：

```text
plan 切换工具 → requiresUserInteraction → alwaysAsk → yolo 模式
→ 项目 deny 规则 → 项目 ask 规则 → plan 模式限制 → 项目 allow 规则
→ webfetch 预批准域名 → workflow draft → session 规则 → edit/build 模式策略
```

规则匹配在 `rule-matching.ts`：支持 wildcard（`Bash(npm *)`），实现是**锚定正则**（`*` 转成 `.*` 并整体锚定），避免 `npm` 意外匹配 `npm-evil`。

自动判不了的，走 `PermissionBrokerPort` 发请求事件——**core 只发事件，不弹窗**。请求经 [04 章](./04-rpc-framework.md) 的 RPC 通道流到 UI，用户点「允许」，决定流回来，回合从 `AwaitingPermission` 继续。`broker.ts` 的 `ManualPermissionBroker` 用 Deferred 实现，**abort 与 timeout 双出口，默认 Deny（fail-closed）**——用户不响应、会话取消，结果都是拒绝，绝不放行。另外两个细节：

- broker 与 `PermissionRequest` hook **竞速**：hook 先返回决定就用 hook 的；
- hook 若改写了工具输入，权限判定要**用改写后的输入重查一遍**——防止「批准了 A，执行了 B」。

### 6.6 文件一致性：read-file-state 与 Edit

🔍 `apps/zcode-cli/packages/core/src/tool/read-file-state.ts`、`edit-matchers.ts`、`handlers/`

Agent 改文件最大的风险是「基于过时认知覆盖别人的修改」。ZCode 的解法是一个**共享的已读状态 Map**：

- **谁参与**：`Read`、`Edit`、`Write`、`Bash` 四个 handler 共用同一个 Map（Bash 也会改文件！）。
- **记什么**：mtime（整毫秒）+ size + revisionId。重新读取时三项比对，全匹配才算「新鲜」。
- **Edit 强制 read-before-edit**：没读过、或读后文件被外部改过 → 拒绝编辑，返回「请先重新读取」——把 staleness 变成模型可见的纠错信息。
- **省 token 的妙招**：模型重复读同一个未变的文件，返回 `file_unchanged` stub 而不是全文。
- **Bash 双向参与**：写命令（`echo >` 等）执行后，相关文件的已读状态标记为过期；读命令（`cat`、`sed -n`）的输出**回填**已读状态——模型用 shell 读文件也算数。
- **乐观并发写**：写入用 `atomic: true, expectedRevision`——期望的 revision 不匹配就失败，等价于 [04 章](./04-rpc-framework.md) 的 CAS。
- 编辑匹配用 **8 级 matcher 链**（`edit-matchers.ts`）：从精确匹配逐级放宽到空白容错，最大化「模型给的 old_string 能命中」。

### 6.7 MCP 工具：统一投影

🔍 `apps/zcode-cli/packages/core/src/tool/registry.ts`（`createMcpToolEntry`）

外部 MCP 服务器的工具如何接入？答案是**投影成同构 ToolEntry**：

- 命名规则 `mcp__{server}__{tool}`，注册进同一个 registry——主循环、调度器、执行管线**完全无感**，把它们当普通工具；
- `needsApproval: true`：外部工具默认要审批；
- 生命周期：`McpPort` 是「借来的端口」，core 只用不拥有——MCP 进程的启停全在 adapters/bootstrap（对应第 1 节的自律）。

每轮开始时（4.2 主循环第 5 步）动态装配「基础工具 + 当前已连接的 MCP 工具」，服务器断连则工具集里自然消失。

## 7. 记忆与上下文

Agent 的「记性」分三层：**单轮上下文怎么组装**（ContextBuilder）、**跨会话记忆怎么存取**（memory/）、**上下文满了怎么办**（compact 三级）。

### 7.1 ContextBuilder：prompt 是「sections」拼出来的

🔍 `apps/zcode-cli/packages/core/src/context/builder.ts`

发给模型的消息不是一个大字符串，而是由 ContextBuilder 按 **section** 机制组装：

```ts
interface Section {
  id: string;
  injectionTarget: "system" | "meta_user";  // 注入系统消息，还是用户消息的 attachment
  cacheHint: "stable" | "dynamic";           // 内容稳定吗？→ 影响缓存效率
  render(): string;
}
```

- 系统提示、工具说明、记忆索引等是 `stable` sections——内容不变，可被 provider 的 **ephemeral cache control** 缓存，省钱省延迟（最多 3 条 system message 允许打缓存标记）；
- 会话当前状态、reminder 等是 `dynamic` 或 `meta_user`——以 `system-reminder` 形式附在用户消息里（见 7.5）。

> 💡 **复现要点**：只要你的模型供应商支持 prompt caching，「稳定内容在前且不变」就是最便宜的优化。ContextBuilder 的 cacheHint 就是给这条规则服务的。

### 7.2 记忆 = 文件，不是数据库

🔍 `apps/zcode-cli/packages/core/src/memory/`

ZCode 的长期记忆设计极其克制：**记忆就是 Markdown 文件**。

```text
<cliStorageRoot>/memories/projects/<slug>-<hash16>/memory/
├── MEMORY.md              ← 记忆索引（每条一行摘要 + 文件引用）
└── 2026-09-30-user-prefers-pnpm.md   ← 单条记忆（frontmatter 元数据）
```

每条记忆文件的 frontmatter 声明类型：`type: user | feedback | project | reference`（用户偏好 / 行为反馈 / 项目事实 / 外部资料引用）。**没有向量库、没有 embedding、没有检索服务**——召回就是「把 MEMORY.md 索引静态注入上下文」，模型需要细节时自己用 read 工具去读对应文件。这个选择换来：记忆可 grep、可 git 管、可手改、零基础设施。

索引本身有保护：MEMORY.md 超过 200 行或 25000 字符就截断——防止记忆无限膨胀吃掉上下文。

### 7.3 记忆的写入：后台提取子代理

记忆**不是**对话里实时写的，而是 turn **成功结束后**，由一个后台子代理异步提取：

- **触发与去重**：带 cursor 记录「提取到哪条消息了」，只处理新增内容；快照合并避免并发重复提取。
- **跳过条件**：本轮 Agent 自己已经写过记忆文件，或用户这条话少于 3 个词——没什么可提取的。
- **提取者的笼子**：`runMemoryAgentLoop` 的 `maxTurns = 5`，且**只能读写记忆目录内的 `.md` 文件**——提取器本身是个权限受限的小 Agent，跑飞了也伤不到工作区。

### 7.4 上下文压缩三级

🔍 `apps/zcode-cli/packages/core/src/compact/`、`runtime/helpers/compact*.ts`

上下文逼近模型窗口上限时的三级预案：

1. **microcompact**（每轮主循环都查，最便宜）：清掉旧的 tool result——工具输出往往巨大且已完成使命，保留最近 5 组即可。
2. **compact**（auto / reactive / manual 三种触发）：把旧对话交给模型生成一份**9 节结构化摘要**（目标、已完成、进行中、关键文件、决策……），历史替换为「前缀 + 摘要 + 最近 1 组完整对话 + reminders」。`prompt-too-long` 错误触发的 reactive compact 最多重试 3 次。阈值公式：**窗口 − reserve 32K − buffer 13K**——给回复和工具输出留足余量才触发。
3. **压缩后善后**：`readFileState.clear()`——历史被摘要后，「已读文件」的上下文依据没了，必须强制模型重新读取才能编辑。

### 7.5 system-reminder：元信息的统一载体

「你的文件被外部修改了」「计划模式已开启」「有后台任务完成」……这些**不是模型说的、但模型需要知道**的信息，统一用 `<system-reminder>` 标签注入。三个维度分类（`source × channel × lifecycle`）：lifecycle 决定它是「前缀注入一次」（prefix）、「持久化在历史里」（persisted）还是「仅本次请求」（per-request）。规则：**禁止嵌套转义**——reminder 内部不允许再出现 reminder 标签，解析器因此可以贪心匹配。

## 8. 分身：多智能体管理

这是最容易被神话、实际最朴素的一块：**子代理不是独立进程，而是同进程里嵌套的另一个 `AgentRuntime`**。父子共享 eventStore、sessionStore 等基础件，只是 session 不同（`childSessionId = "subagent_<agentId>"`）。子代理**禁止再嵌套**（`subagents.enabled: false`）——一层委派够用，两层复杂度爆炸。

### 8.1 core 看到的全部：SubagentPort

🔍 `contracts/src/interfaces/subagent.port.ts`

依循第 1 节的自律，多智能体在 core 眼里只是五个方法：

```ts
interface SubagentPort {
  launch(profile): SubagentHandle;   // 建子代理
  run(handle, prompt): SubagentRun;  // 前台跑一个任务
  start(handle, prompt): void;       // 后台启动
  waitForTask(taskId): Promise<Result>;
  stopTask(taskId): Promise<void>;
  sendMessage(handle, msg): Promise<SendResult>;
}
```

实现在 `bootstrap/src/subagents.ts`：里面 new 一个新的 `AgentRuntime`（禁用子代理、注入父的共享基础件）。**多智能体的「管理」因此被拆成两半：委派协议在 core（Task 工具 + 消息命令），实例管理在 bootstrap。**

### 8.2 Profile：子代理的人格从哪来

🔍 `core/src/subagent/`（profile 解析）

子代理的「人设」（可用工具、系统提示、模型）来自**三来源同名覆盖**：

1. 内置 profile：`Explore`（只读白名单 + 独立的只读 PermissionService + yolo——专门用来快速翻代码）与 `general-purpose`（`tools: "*"` 全量工具）；
2. 用户级：`~/.zcode/agents/*.md`；
3. 项目级：`.zcode/agents/*.md`——**优先级最高**。

同名时项目覆盖用户覆盖内置。防提权细节：项目 profile 不允许携带 `permissionMode`——项目里的一个 markdown 文件不能给自己开 yolo。

### 8.3 Task 工具：前台三竞速

🔍 `core/src/tool/handlers/agent.ts`、`runtime/methods/subagent.ts`、`runtime-task/registry.ts`

模型调用 `task` 工具委派任务时，前台运行是**三个 Promise 竞速**：

```text
① 子代理正常完成          → 返回结果给模型
② 主代理要求转后台        → detachParent，返回「任务已转后台 + taskId」
③ autoBackground 定时器   → 超时自动转后台（长任务不阻塞主对话）
```

「转后台」意味着子代理继续跑，主 Agent 拿到一个 taskId 可以继续和用户对话；完成时 `task-notification` 命令（`priority: "next"`）插队进主循环。

### 8.4 工具策略：给分身戴镣铐

子代理的工具集 = **allowlist 交集**（profile 声明的 ∩ 系统允许的），并有三条强制规则：

- **plan 工具强制剔除**——计划是主会话的财产；
- **强制追加 `RespondToCoordinator`**——子代理必须有能力向协调者汇报，这是通信协议的保底；
- **CUA（计算机操作类）工具全禁**——子代理不碰 GUI。

### 8.5 双向通信：steered / queued / resumed

模型可以用 `send-message` 给运行中的子代理发消息（比如「方向变了，改用方案 B」）。三态投递（`runtime/methods/subagent-messages.ts`、`steering.ts`）：

- **steered**：子代理正在等模型响应 → 消息作为 steering 立刻影响它；
- **queued**：子代理正忙着执行工具 → 排队，下一轮主循环被吸收；
- **resumed_background**：子代理已挂起 → 唤醒它继续。

反向通信用两种 XML 信封：`<subagent-message>`（子代理主动说话，插队为 `priority: "next"`）与 `<task-notification>`（完成通知，带 `notified` 标志保证**幂等**——同一任务的通知绝不投递两次）。超长内容 120K 截断。两种信封都会变成命令队列里的命令——**多智能体通信复用了第 3 节的整套入口纪律，没有第二条旁路**。

### 8.6 事件镜像：UI 如何看到一个嵌套的 Agent

子代理的事件也要流到 UI，但它的 `toolCallId` 和父会话的可能冲突。解法是**镜像时重写 id**：`tool_subagent_<agentId>_<childToolCallId>`。权限请求同理：interaction broker 在**外层改写 sessionId、内层保留 origin**——UI 弹的审批卡片看起来属于主会话，实际批准结果能路由回子代理。父会话结束/取消时，所有活着的子代理随之终止（生命周期单向依赖）。

### 8.7 子代理的持久记忆

子代理（如 Explore）也能沉淀记忆：user / project / local 三作用域的目录约定，且 profile 可注入受限的 Write/Edit 工具（只能写记忆目录）——和 7.3 的提取子代理同一个思路：**干活的可以记笔记，但笔只能落在笔记本上**。

## 9. 出口：一切皆事件

🔍 `core/src/runtime/methods/events.ts`、`contracts/src/events/session.events.ts`、`EventReducer`

Runtime 内部的任何变化，最终都从**一个入口**流出：

```text
appendEvent(event)
  → eventStore 落库（持久化，重连可回放）
  → 账本记账（usage、turn 计数等）
  → sink 分发给所有订阅者（单个 sink 抛错不影响主流程）
```

contracts 包定义了约 **80 种事件类型**（工具开始/结束、流式增量、权限请求、相位迁移、compact 进度……）与 **6 种 `TurnResultType`**。下游 [04 章](./04-rpc-framework.md) 的通道负责送达；UI 侧 `EventReducer` 把事件流**折叠投影**成状态——比如连续 100 个 `text_delta` 折叠成「当前文本 + 光标位置」。`querySource` 隔离保证 sidecar 查询（如标题生成）的事件不污染主对话流。

**这个设计把「最难写的并发 UI」变成了「纯函数」**：Runtime 是唯一写方，UI 是只读投影，事件序列是唯一的真相载体。

## 10. 复现清单：从零搭一个最小 Agent

按依赖顺序，每步都有本章对应小节背书：

1. **定义 Port 接口集**（§1）：至少 FileSystem / Execution / Model / EventSink 四个。core 不 import 实现。
2. **实现工具契约与注册表**（§6.1–6.2）：ToolEntry 双 schema（JSON 给模型 + Zod 给执行器），registry 双 Map。
3. **实现执行管线**（§6.4）：先做 15 步的精简版——归一化 → 校验 → 权限 → handler → 截断；**校验失败返回纠错文本，不抛异常**。
4. **实现命令队列**（§3）：三优先级 + Deferred + reservation（先登记再入队）。这一个文件决定了你 Agent 的「抗并发下限」。
5. **实现回合状态机**（§4.1）：10 相位 `as const` + 迁移表。别省 `AggregatingResults → AwaitingModelResponse` 这条回路，它是 agent loop 的本体。
6. **实现 turn 主循环**（§4.2）：while(true) 八步，`ModelStepResult` 三值决定 break/continue。
7. **接模型流式**（§5）：有界写队列 + tool_call 按 id 合并；断流恢复可以后补。
8. **实现事件出口**（§9）：单入口 appendEvent → 落库 → 分发；UI 只做投影。
9. **加权限链**（§6.5）：先做「规则自动判定 + 失败转人工 broker（fail-closed）」，15 级可以逐步长。
10. **加记忆与 compact**（§7）：文件记忆（索引 + frontmatter）+ microcompact 起步，9 节摘要 compact 与子代理提取最后做。

每一步都可独立测试：Port 是假的、模型是假的、队列是真的——这正是第 1 节自律的回报。

---

## 11. 动手环节

1. 打开 `apps/zcode-cli/packages/core/src/agent/turn-state.ts`，把 10 个 `TurnPhase` 抄在纸上，凭理解画出迁移箭头，再对照迁移表核对——特别确认 `AggregatingResults` 能去哪 4 个相位，想明白为什么能去 `SchedulingTools`（提示：工具串行分组后继续执行）。
2. 全仓库搜索 `canTransitionTo` 的实现，看非法迁移会怎样（抛错？断言？）。
3. 进 `runtime/methods/turn-loop.ts`，找出主循环八步各自对应的代码行；再找 `rapid-refill` 熔断的判断条件，思考它防的是什么死循环。
4. 在 `core/src/tool/executor/` 里找出 15 步管线中「校验失败生成纠错内容」的代码，观察它返回的 `ToolResult` 长什么样——这就是「自纠错」的实体。
5. 进阶：对比 `core/src/memory/` 的记忆文件格式与本节 7.2 的目录树，手动给自己写一条 `type: feedback` 的记忆文件，下次会话验证它是否被注入（提示：找 MEMORY.md 索引注入的代码路径）。

---

**下一章**：[06 · UI 与状态管理](./06-ui-state.md) —— 事件流到浏览器之后：`packages/ui` 的 store、hooks 与服务访问层。
