// ============================================================
// Turn Machine - State machine for turn lifecycle
// ============================================================
// 状态机的"驱动器"：turn-state.ts 定义了记忆与规则，本文件提供一组
// "事件 → 新状态"的方法。每收到一个事件（模型回了、工具完成了、权限批了），
// 就调用对应方法，拿到一个全新的 TurnState。
// 铁律：方法只做状态迁移，不执行任何副作用（不发请求、不跑工具）——
// 真正驱动它的是外层的 internal-turn-methods（后面批次会看到）。

import type {
  TurnState,
  TurnPhase,
  ToolCall,
  ToolScheduleState,
  PermissionRequestState,
  PermissionDecision,
  TurnResultType,
  TurnErrorState,
  ModelRequestState,
} from "./turn-state.js";
import {
  TurnPhase as Phase,
  createTurnState,
  canTransitionTo,
  isTerminalPhase,
} from "./turn-state.js";
import type {
  ModelMessageContent,
  SessionId,
  TraceId,
  ToolCallId,
  TurnId,
} from "@zcode/contracts";
import type { PendingTurnInput } from "@zcode/contracts";
import {
  createTurnId,
  createCoreError,
  CoreErrorType,
  modelMessageContentToText,
} from "@zcode/contracts";

// -----------------------------------------------
// Turn Machine
// -----------------------------------------------

// 先定义契约（接口），再写实现——本仓库的标准做法：调用方依赖接口，测试可换假实现。
// 每个方法对应一个相位事件，返回值都是新的 TurnState。
export interface TurnMachine {
  state: TurnState;
  start(): TurnState;
  // `ModelRequestState["messages"]` 是索引访问类型（后面会反复出现，这里先讲）：
  // 读作"ModelRequestState 里 messages 字段的类型"——复用已有类型，不重复声明。
  startModelRequest(model: string, messages: ModelRequestState["messages"]): TurnState;
  receiveModelResponse(content: string): TurnState;
  addStreamingContent(content: string): TurnState;
  scheduleTools(toolCalls: ToolCall[], schedule: ToolScheduleState): TurnState;
  startToolExecution(): TurnState;
  completeTool(
    toolCallId: ToolCallId,
    result: { success: boolean; content: ModelMessageContent },
  ): TurnState;
  queuePendingInput(input: PendingTurnInput): TurnState;
  drainPendingInputs(): { inputs: PendingTurnInput[]; state: TurnState };
  requestPermission(request: PermissionRequestState): TurnState;
  resolvePermission(
    toolCallId: ToolCallId,
    decision: PermissionDecision,
    modifiedInput?: unknown,
  ): TurnState;
  aggregateResults(): TurnState;
  complete(response: string, resultType?: TurnResultType): TurnState;
  fail(error: TurnErrorState): TurnState;
  getNextPhase(): TurnPhase;
  isComplete(): boolean;
}

export class TurnMachineImpl implements TurnMachine {
  state: TurnState;

  constructor(state: TurnState) {
    this.state = state;
  }

  // 静态工厂（buffer.ts 的 VSBuffer 讲过该模式）：造一台新机器。
  // `??`：调用方没给 turnId/traceId 就现场生成。
  static create(
    sessionId: SessionId,
    turnNumber: number,
    input: string,
    traceId?: TraceId,
    turnId?: TurnId,
  ): TurnMachineImpl {
    const state = createTurnState(
      turnId ?? createTurnId(),
      sessionId,
      turnNumber,
      // crypto.randomUUID() 生成标准 UUID 字符串；`as TraceId` 给普通字符串"烙印"
      // 成品牌类型——运行时还是同一个字符串，类型层面完成身份转换。
      traceId ?? (crypto.randomUUID() as TraceId),
      input,
    );
    return new TurnMachineImpl(state);
  }

  // 私有的"迁移闸门"：所有合法迁移都经过这里。
  // 非法迁移直接抛结构化错误（createCoreError：带错误类型/上下文/可恢复标记，
  // 是 AGENTS.md"不依赖错误文本做流程判断"的落地——调用方按 CoreErrorType 分支）。
  private transition(phase: TurnPhase): TurnState {
    if (!canTransitionTo(this.state.phase, phase)) {
      throw createCoreError(
        CoreErrorType.InvalidTurnPhase,
        `Cannot transition from ${this.state.phase} to ${phase}`,
        {
          context: { current: this.state.phase, target: phase },
          recoverable: true,
        },
      );
    }
    // 展开运算符（foundation 讲过）的另一种用法：**不可变更新**——
    // 不修改旧对象，而是浅拷贝一份再覆盖 phase 字段。为什么？
    // 旧状态可能正被事件流/日志引用，就地改写会让"历史"跟着变；
    // 每次迁移产出新对象，状态变化才可追溯、可比较（React 式思维）。
    return { ...this.state, phase };
  }

  // 以下每个方法 = "一个事件"。套路统一：先迁移相位，再返回覆盖了新字段的**新**状态。
  start(): TurnState {
    return this.transition(Phase.ProcessingInput);
  }

  // 发起模型请求。为什么先手动检查再 transition？
  // 合法来源有两个相位（首轮 ProcessingInput / 工具结果回灌 AggregatingResults），
  // 先给出更友好的错误信息，再走闸门。
  startModelRequest(model: string, messages: ModelRequestState["messages"]): TurnState {
    if (
      this.state.phase !== Phase.ProcessingInput &&
      this.state.phase !== Phase.AggregatingResults
    ) {
      throw createCoreError(
        CoreErrorType.InvalidTurnPhase,
        "Must be in ProcessingInput or AggregatingResults phase",
        {
          context: { current: this.state.phase },
          recoverable: true,
        },
      );
    }

    const state = this.transition(Phase.AwaitingModelResponse);
    // 记录请求快照：模型名 + 消息列表（`{ model, messages }` 是键名省略写法）。
    return {
      ...state,
      modelRequest: {
        model,
        messages,
      },
    };
  }

  // 模型开始回复：进入 Streaming 相位并记下第一段内容。
  receiveModelResponse(content: string): TurnState {
    const state = this.transition(Phase.Streaming);
    return {
      ...state,
      streamingContent: state.streamingContent + content,
    };
  }

  // 后续每个流式片段：相位不变（已在 Streaming），只追加文本。
  addStreamingContent(content: string): TurnState {
    const state = this.transition(Phase.Streaming);
    return {
      ...state,
      streamingContent: state.streamingContent + content,
    };
  }

  // 模型说"我要调这些工具"：登记调用清单 + 调度计划。
  scheduleTools(toolCalls: ToolCall[], schedule: ToolScheduleState): TurnState {
    const state = this.transition(Phase.SchedulingTools);
    return {
      ...state,
      // `.map()` 把 contracts 的工具调用转成状态机的记录形态（每个都盖"已调度"戳）。
      // `as TurnState["toolCalls"][number]["status"]` 是三层索引访问（上面讲过一层）：
      // 先取字段类型（数组）→ `[number]` 取元素类型 → `["status"]` 再取字段类型。
      // 需要这层断言是因为对象字面量里的字符串默认被放宽成 string，这里收回来。
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id as ToolCallId,
        name: tc.name,
        input: tc.input,
        status: "scheduled" as TurnState["toolCalls"][number]["status"],
        scheduledAt: new Date(),
      })),
      scheduledTools: schedule,
    };
  }

  // 开始执行工具。分叉点：有工具在等权限？先停在 AwaitingPermission——
  // UI 上的审批卡片就是这一相位的事件投影（UI 不是权威，状态机才是）。
  startToolExecution(): TurnState {
    // `.some()`：只要有一个元素满足条件就返回 true。
    const needsPermission = this.state.toolCalls.some((tc) => tc.status === "waiting_permission");
    const nextPhase = needsPermission ? Phase.AwaitingPermission : Phase.ExecutingTools;

    const state = this.transition(nextPhase);
    return {
      ...state,
      // 逐个工具更新：等权限的保持原状，其余标记 running 并记开始时间。
      // `{ ...tc, status: ... }`：拷贝单条调用记录再覆盖字段（不可变更新同前）。
      toolCalls: state.toolCalls.map((tc) => ({
        ...tc,
        status:
          tc.status === "waiting_permission"
            ? tc.status
            : ("running" as TurnState["toolCalls"][number]["status"]),
        startedAt: tc.status !== "waiting_permission" ? new Date() : tc.startedAt,
      })),
    };
  }

  // 单个工具跑完了：更新该调用的状态，并把结果追加进 toolResults 列表。
  completeTool(
    toolCallId: ToolCallId,
    result: { success: boolean; content: ModelMessageContent },
  ): TurnState {
    // 失败时把内容转成文本存进错误信息（modelMessageContentToText 是 contracts 的工具函数）。
    const errorMessage = result.success ? undefined : modelMessageContentToText(result.content);
    // map + 三元：目标项替换为新对象，其余原样返回（tc）——不可变更新单个元素的惯用法。
    const updatedToolCalls = this.state.toolCalls.map((tc) =>
      tc.id === toolCallId
        ? {
            ...tc,
            status: (result.success
              ? "completed"
              : "failed") as TurnState["toolCalls"][number]["status"],
            completedAt: new Date(),
            result: {
              success: result.success,
              content: result.content,
            },
          }
        : tc,
    );

    return {
      ...this.state,
      toolCalls: updatedToolCalls,
      toolResults: [
        ...this.state.toolResults,
        {
          success: result.success,
          content: result.content,
          error: result.success
            ? undefined
            : { type: "tool_error", message: errorMessage ?? "", recoverable: true },
        },
      ],
    };
  }

  // 执行中插话：不打断当前回合，先把话排队。
  queuePendingInput(input: PendingTurnInput): TurnState {
    return {
      ...this.state,
      // 展开旧数组 + 追加新元素 = 不可变的"入队"。
      pendingInputs: [...this.state.pendingInputs, input],
    };
  }

  // 回合收尾时一次性取出所有插话（取走即清空——"排水"）。
  // 返回值解构使用：{ inputs: 排队的话, state: 清空后的新状态 }。
  drainPendingInputs(): { inputs: PendingTurnInput[]; state: TurnState } {
    return {
      inputs: this.state.pendingInputs,
      state: {
        ...this.state,
        pendingInputs: [],
      },
    };
  }

  // 有工具需要审批：整体进入等待相位，并把对应调用标记为 waiting_permission。
  requestPermission(request: PermissionRequestState): TurnState {
    const state = this.transition(Phase.AwaitingPermission);
    return {
      ...state,
      toolCalls: state.toolCalls.map((tc) =>
        tc.id === request.toolCallId
          ? { ...tc, status: "waiting_permission" as TurnState["toolCalls"][number]["status"] }
          : tc,
      ),
      pendingPermissions: [...state.pendingPermissions, request],
    };
  }

  // 审批结果从 UI 流回来（经 RPC 事件），回合得以继续前进。
  resolvePermission(
    toolCallId: ToolCallId,
    decision: PermissionDecision,
    modifiedInput?: unknown,
  ): TurnState {
    const updatedToolCalls = this.state.toolCalls.map((tc) =>
      tc.id === toolCallId
        ? {
            ...tc,
            // 拒绝则标记终态；放行/改参则保持 waiting（相位由外层推回执行）。
            status:
              decision === "deny"
                ? ("permission_denied" as TurnState["toolCalls"][number]["status"])
                : tc.status,
            // 用户"修改参数后放行"（modify）：用改过的参数覆盖原输入（`??` 保底用原值）。
            input: modifiedInput ?? tc.input,
          }
        : tc,
    );

    return {
      ...this.state,
      toolCalls: updatedToolCalls,
      pendingPermissions: this.state.pendingPermissions.filter((p) => p.toolCallId !== toolCallId),
      resolvedPermissions: [
        ...this.state.resolvedPermissions,
        {
          toolCallId,
          decision,
          modifiedInput,
          resolvedAt: new Date(),
        },
      ],
    };
  }

  aggregateResults(): TurnState {
    return this.transition(Phase.AggregatingResults);
  }

  // 回合完成：记下最终回复、结局类型、结束时间。
  // `resultType: TurnResultType = "success"` 是参数默认值（buffer.ts 讲过）。
  complete(response: string, resultType: TurnResultType = "success"): TurnState {
    const state = this.transition(Phase.Completing);
    return {
      ...state,
      finalResponse: response,
      resultType,
      completedAt: new Date(),
    };
  }

  // 失败路径：注意这里**没有**走 transition 闸门，直接设置 Error 相位——
  // 刻意为之：任何相位都必须能失败，不能因为"迁移表没这条边"而无法报错。
  fail(error: TurnErrorState): TurnState {
    return {
      ...this.state,
      phase: Phase.Error,
      error,
      completedAt: new Date(),
    };
  }

  // "下一步该去哪"的推导函数：不改变状态，只根据当前状态**计算**建议相位——
  // 外层驱动器据此决定下一步动作（要不要开始跑工具 / 要不要回问模型 / 能不能收尾）。
  getNextPhase(): TurnPhase {
    // 解构赋值：一行取出三个字段当局部变量用。
    const { phase, toolCalls, streamingContent } = this.state;

    // 模型说完话且要调工具 → 去调度。
    if (phase === Phase.Streaming && toolCalls.length > 0) {
      return Phase.SchedulingTools;
    }

    // 模型说完话、不调工具、确实有内容 → 直接收尾。
    if (phase === Phase.Streaming && toolCalls.length === 0 && streamingContent) {
      return Phase.Completing;
    }

    // 工具都跑完了（没有 running 也没有等权限的）→ 去汇总。
    if (phase === Phase.ExecutingTools) {
      const pendingTools = toolCalls.filter(
        (tc) => tc.status === "running" || tc.status === "waiting_permission",
      );
      if (pendingTools.length === 0) {
        return Phase.AggregatingResults;
      }
    }

    // 汇总阶段的分岔：有失败/被拒的工具 → 终止回合；
    // 全部成功 → 把结果喂回模型进入下一轮"等模型"——Agent 循环的闭环处。
    if (phase === Phase.AggregatingResults) {
      const failedTools = toolCalls.filter(
        (tc) => tc.status === "failed" || tc.status === "permission_denied",
      );
      if (failedTools.length > 0) {
        return Phase.Completing;
      }
      return Phase.AwaitingModelResponse;
    }

    // 其他情况：维持原相位（继续等）。
    return phase;
  }

  isComplete(): boolean {
    return isTerminalPhase(this.state.phase);
  }
}
