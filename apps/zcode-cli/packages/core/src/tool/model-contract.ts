// 工具的"模型契约"投影：发给模型看的不是工具代码，而是 schema + 描述声明。
// 有些工具的契约是**动态的**（依上下文变化，比如启用某 MCP 后参数不同），
// 这两个函数负责在"注册时的静态契约"之上叠加"运行时投影"。
import type { ModelToolContract } from "@zcode/contracts";
import type { ToolEntry, ToolExecutionModelContext } from "./types.js";

// 给注册表条目套上动态投影。`entry.resolveModelContract?.(context)`：
// 可选方法调用（channelClient 讲过）——工具没声明投影就原样返回。
export function resolveToolEntryModelContract(
  entry: ToolEntry,
  context: ToolExecutionModelContext,
): ToolEntry {
  const projection = entry.resolveModelContract?.(context);
  if (!projection) return entry;
  // 展开覆盖技巧：`...(条件 ? { 新字段 } : {})`——条件不满足就展开空对象（等于没加），
  // 避免 undefined 把已有字段覆盖坏。
  return {
    ...entry,
    ...(projection.inputSchema ? { inputSchema: projection.inputSchema } : {}),
    metadata: {
      ...entry.metadata,
      ...(projection.description !== undefined ? { description: projection.description } : {}),
    },
  };
}

// 同样的投影逻辑，作用对象换成"已构造好的模型契约"（MCP 等外部工具走这条路）。
export function projectToolModelContract(
  contract: ModelToolContract,
  entry: ToolEntry | undefined,
  context: ToolExecutionModelContext,
): ModelToolContract {
  if (!entry) return contract;
  const projection = entry.resolveModelContract?.(context);
  if (!projection) return contract;
  return {
    ...contract,
    ...(projection.description !== undefined ? { description: projection.description } : {}),
    ...(projection.inputSchema ? { inputSchema: projection.inputSchema } : {}),
  };
}
