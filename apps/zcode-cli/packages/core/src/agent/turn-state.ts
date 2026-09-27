// ============================================================
// Turn State - Turn state machine types
// ============================================================
// 本文件是"回合状态机"的记忆与规则定义：一个 turn（回合）= 用户的一次完整输入
// 到模型最终回复之间的全部状态。这里只有类型、常量和纯函数——没有任何副作用，
// 状态机如何被驱动在 turn-machine.ts。

import type {
  ModelMessageContent,
  PendingTurnInput,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import type { ModelToolCall as ToolCall } from "@zcode/contracts";

// Re-export ToolCall for consumers of this module
export type { ModelToolCall as ToolCall } from "@zcode/contracts";

// Note: ModelMessage is defined locally to avoid conflicts with contracts' ModelMessage
// which uses ToolCallPayload[] instead of ModelToolCall[]
// （补充上面这条英文注释：本文件故意自定义 ModelMessage——contracts 版的
//   toolCalls 字段形状不同，这里需要的是 ModelToolCall[]。）

// -----------------------------------------------
// Turn Phase
// -----------------------------------------------

// 回合的 10 个相位。`as const`（第一次遇到这个惯用法，本仓库最常用的"枚举"写法）：
// 把对象锁成"只读 + 每个值都是字面量类型"——于是 TurnPhase.Idle 的类型不是 string，
// 而是精确的字面量 "idle"。比 enum 少了运行时对象，序列化成 JSON 后仍是纯字符串。
export const TurnPhase = {
  // 一个回合的生命线：空闲 → 处理输入 → 等模型 → 流式回复 →
  // 调度工具 → 执行工具 ⇄ 等权限 → 汇总结果 →（工具结果回灌模型，回到等模型）→ 完成。
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

// 这行"类型体操"值得逐段拆开：
//   `typeof TurnPhase` —— 取"这个常量对象的类型"（TS 能从值反推类型）；
//   `keyof ...` —— 取对象所有键的联合（"Idle" | "ProcessingInput" | ...）；
//   `TurnPhase[...]` —— 用这些键做索引，取出所有**值**的联合。
// 合起来 = "idle" | "processing_input" | ... 十个字符串字面量的联合。
// 效果等价于 enum 的类型面，且值与类型的定义只写一份（改一处两边同步）。
export type TurnPhase = (typeof TurnPhase)[keyof typeof TurnPhase];

// -----------------------------------------------
// Turn State
// -----------------------------------------------

// TurnState = 回合的"全部记忆"。UI 上看到的「正在执行工具」「等待确认」角标，
// 读的都是这些字段经事件投影出的视图——状态机是权威，UI 只是投影。
export interface TurnState {
  // 标识三件套：TurnId/SessionId/TraceId 都是"品牌类型"（branded type）——
  // 本质是 string，但被类型系统烙了印，普通字符串不能直接冒充
  // （怎么烙印在 runtime/command-queue.ts 会看到）。
  id: TurnId;
  sessionId: SessionId;
  // 本会话的第几个回合（从 1 计数）。
  turnNumber: number;
  // 当前相位——整个状态机的"指针"。
  phase: TurnPhase;
  // 全链路追踪 id：跨子代理/后台任务的关联键（AGENTS.md 的可观测性要求）。
  traceId: TraceId;
  // 用户这次的原始输入与附件。
  input: string;
  attachments?: TurnAttachment[];
  // 发给模型的请求快照（用了哪个模型、发了什么、token 用量）。
  modelRequest?: ModelRequestState;
  // 流式回复的累积文本（模型一边生成一边追加）。
  streamingContent: string;
  finalResponse?: string;
  // 模型要求的工具调用及其结果（两列对照）。
  toolCalls: ToolCallState[];
  toolResults: ToolResultState[];
  // 调度计划：哪些工具、什么顺序、哪些能并行。
  scheduledTools: ToolScheduleState;
  // 插话队列：回合执行中用户又发的话，先排队不打断。
  pendingInputs: PendingTurnInput[];
  acceptsPendingInput: boolean;
  // 等待审批 / 已裁决的权限请求。
  pendingPermissions: PermissionRequestState[];
  resolvedPermissions: PermissionResultState[];
  resultType: TurnResultType;
  error?: TurnErrorState;
  // 起止时间（completedAt 的 ? 表示"还没结束"）。
  startedAt: Date;
  completedAt?: Date;
}

// -----------------------------------------------
// Sub-states
// -----------------------------------------------

// 发给模型的请求快照。temperature/maxTokens 是采样参数；
// stopReason 记录模型为何停笔（自然说完/被截断/要求调工具）。
export interface ModelRequestState {
  model: string;
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
  stopReason?: string;
  usage?: TokenUsageState;
}

// ModelMessage for turn state - uses ToolCall from contracts
// 一条对话消息。role 是字面量联合（protocol.ts 讲过）：四种角色；
// assistant 消息可能带 toolCalls（模型说"我要调工具"），
// tool 角色的消息用 toolCallId 指明"这是哪次调用的结果"。
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

// token 用量：计费与"上下文快满 → 该压缩了"判断的依据。
export interface TokenUsageState {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// 一次工具调用的生命周期记录。input 是 unknown——模型给的参数不可信，
// 执行前要经过校验清洗（tool/input-normalization 等）。
export interface ToolCallState {
  id: ToolCallId;
  name: string;
  input: unknown;
  status: ToolCallStateStatus;
  // 三个时间点都是可选的：没走到那个阶段就不存在。
  scheduledAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: ToolResultState;
}

// 工具调用的六种状态——"等权限/被拒绝"占了两席，可见权限审批是常态路径而非异常。
export type ToolCallStateStatus =
  | "scheduled"
  | "waiting_permission"
  | "permission_denied"
  | "running"
  | "completed"
  | "failed";

export interface ToolResultState {
  success: boolean;
  content: ModelMessageContent;
  error?: TurnErrorState;
}

// 调度计划三视图：原始条目 / 并行分组（`ToolCallId[][]` 是数组的数组——每组一批并行）/
// 拍平后的执行顺序。
export interface ToolScheduleState {
  items: ToolScheduleItem[];
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

// 一条调度项：dependencies 声明"要等我列出的这些先跑完"——工具间的依赖图。
export interface ToolScheduleItem {
  toolCallId: ToolCallId;
  dependencies: ToolCallId[];
  canRunParallel: boolean;
}

// 一次权限审批请求：哪个工具、风险多高、何时提出。
// （core 只发事件不弹窗——审批如何流到 UI 见 permission/ 目录。）
export interface PermissionRequestState {
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: string;
  requestedAt: Date;
}

// 审批结果。modifiedInput 值得注意：用户可以选择"改了参数再放行"（modify）。
export interface PermissionResultState {
  toolCallId: ToolCallId;
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
  resolvedAt: Date;
}

// 四种裁决：放行 / 拒绝 / 上报更高级别 / 修改参数后放行。
export type PermissionDecision = "allow" | "deny" | "escalate" | "modify";

// 回合的六种结局：成功、用户取消（视为正常结束）、以及四种失败上限。
// 各 error_* 对应 AGENTS.md 的长程任务原则——不用工具调用次数硬停，
// 而由轮数/预算/执行异常等明确条件承担终止。
export type TurnResultType =
  | "success"
  // "cancelled": 用户主动中断（TurnCancelled）属于正常结束，复用 TurnComplete 上报而非 TurnError。
  | "cancelled"
  | "error_max_turns"
  | "error_max_budget"
  | "error_during_execution"
  | "error_max_tool_calls";

// 错误也是一等对象（AGENTS.md：错误处理优先）：recoverable 告诉上层能否重试恢复。
export interface TurnErrorState {
  type: string;
  message: string;
  recoverable: boolean;
}

// 用户消息携带的附件。type 是字面量联合：五种附件形态。
export interface TurnAttachment {
  type: "file" | "image" | "video" | "pdf" | "url";
  path?: string;
  content?: string;
  /** clipboard-text 是 UI 长粘贴落盘生成的临时附件，模型请求中只保留路径引用。 */
  sourceKind?: "clipboard-text";
  // 展示元信息（协议边界保真透传，TurnStarted 事件/v4 投影展示用；
  // 缺省时由 basename/扩展名推断兜底）。不参与内容解析。
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

// -----------------------------------------------
// Turn State Factory
// -----------------------------------------------

// 工厂函数：一个新回合的"初始记忆"集中在这里定义——
// 所有数组/计数字段的初始值只有这一处，改初始规则不用全仓搜索。
export function createTurnState(
  id: TurnId,
  sessionId: SessionId,
  turnNumber: number,
  traceId: TraceId,
  input: string,
  attachments?: TurnAttachment[],
): TurnState {
  return {
    id,
    sessionId,
    turnNumber,
    phase: TurnPhase.Idle,
    traceId,
    input,
    attachments,
    streamingContent: "",
    toolCalls: [],
    toolResults: [],
    scheduledTools: {
      items: [],
      parallelGroups: [],
      executionOrder: [],
    },
    pendingInputs: [],
    acceptsPendingInput: true,
    pendingPermissions: [],
    resolvedPermissions: [],
    resultType: "success",
    startedAt: new Date(),
  };
}

// -----------------------------------------------
// Phase Predicates
// -----------------------------------------------

// 相位谓词：把"这个相位算什么性质"收敛成两个函数，
// 调用方不必到处硬编码相位清单。
export function isTerminalPhase(phase: TurnPhase): boolean {
  // 终态：完成或出错（回合到此结束，下一回合从 Idle 重新出发）。
  return phase === TurnPhase.Completing || phase === TurnPhase.Error;
}

export function isWaitingPhase(phase: TurnPhase): boolean {
  // 等待态：都在"等外部世界"——等模型回复 / 等用户审批 / 等工具跑完。
  return (
    phase === TurnPhase.AwaitingModelResponse ||
    phase === TurnPhase.AwaitingPermission ||
    phase === TurnPhase.ExecutingTools
  );
}

// 合法迁移表：状态机的"交通规则"。想在 Idle 直接 complete()？这里直接拒绝。
// Record<TurnPhase, TurnPhase[]> 是 TS 内置工具类型：读作"键必须是合法相位、
// 值是该相位能去的相位数组"的字典——键的完备性由编译器保证（漏写一个相位会报错）。
// `[TurnPhase.Idle]:` 是计算属性键（serialization 讲过）：用常量的值当字段名。
export function canTransitionTo(current: TurnPhase, next: TurnPhase): boolean {
  const validTransitions: Record<TurnPhase, TurnPhase[]> = {
    [TurnPhase.Idle]: [TurnPhase.ProcessingInput],
    [TurnPhase.ProcessingInput]: [TurnPhase.AwaitingModelResponse, TurnPhase.Completing],
    [TurnPhase.AwaitingModelResponse]: [TurnPhase.Streaming, TurnPhase.Completing, TurnPhase.Error],
    [TurnPhase.Streaming]: [
      TurnPhase.SchedulingTools,
      TurnPhase.AggregatingResults,
      TurnPhase.Completing,
      TurnPhase.Error,
    ],
    [TurnPhase.SchedulingTools]: [
      TurnPhase.ExecutingTools,
      TurnPhase.AwaitingPermission,
      TurnPhase.Error,
    ],
    [TurnPhase.ExecutingTools]: [
      TurnPhase.AggregatingResults,
      TurnPhase.AwaitingPermission,
      TurnPhase.Error,
    ],
    // 关键回路：汇总完工具结果后可以回到"等模型"——把结果喂给模型再要下一轮，
    // 这正是 Agent 循环"思考 → 行动 → 观察 → 再思考"的落点。
    [TurnPhase.AggregatingResults]: [
      TurnPhase.AwaitingModelResponse,
      TurnPhase.SchedulingTools,
      TurnPhase.Completing,
      TurnPhase.Error,
    ],
    [TurnPhase.AwaitingPermission]: [TurnPhase.ExecutingTools, TurnPhase.Error],
    [TurnPhase.Completing]: [TurnPhase.Idle],
    [TurnPhase.Error]: [TurnPhase.Idle],
  };

  // 查表：`?.` 防御性兜底（理论上 current 必在表中）；`?? false`——
  // 万一查不到就视为"不允许迁移"。宁可拒绝也不放行非法迁移。
  return validTransitions[current]?.includes(next) ?? false;
}
