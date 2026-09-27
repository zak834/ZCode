// token 用量的"持久化基线"：会话存档里记录的用量快照。
// 为什么单独一个文件？因为 provider 上报的 token 数据形状千奇百怪
// （有的没有 total、有的把缺失归一化成 0），这里的职责是把脏数据清洗成可靠基线。
import type { TokenUsageInfo } from "@zcode/contracts";

export interface PersistedTokenUsageBaseline {
  // 缓存命中的读/写（prompt cache 的计费维度）。
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // 本地估算的"上下文占用"——拿不准就是 undefined，绝不瞎猜。
  contextUsageTokens?: number;
  inputTokens: number;
  outputTokens: number;
}

// 把 provider 的用量数据清洗成基线；清洗不出来（数据不可信）就返回 undefined。
export function persistedTokenUsageBaseline(
  tokens: TokenUsageInfo | undefined,
): PersistedTokenUsageBaseline | undefined {
  if (!tokens) return undefined;
  // 第一步：确定"输入窗口"token 数（下面的辅助函数里有三种来源的回退链）。
  const inputTokens = persistedInputWindowTokens(tokens);
  if (inputTokens === undefined || inputTokens <= 0) return undefined;

  // `?? 0`：清洗不出就取 0（这几个字段允许为 0，不像 inputTokens 那样致命）。
  const outputTokens = positiveInteger(tokens.output) ?? 0;
  const cacheReadTokens = nonNegativeInteger(tokens.cache.read) ?? 0;
  const cacheWriteTokens = nonNegativeInteger(tokens.cache.write) ?? 0;
  const totalTokens = positiveInteger(tokens.total);
  // 历史 TokenUsageInfo 会把缺失的 provider outputTokens 归一化成 0。
  // 没有可用 total 时，0 无法证明 usage 已覆盖 assistant，必须把 assistant 留给本地估算。
  const contextUsageTokens =
    // 三层嵌套三元从上往下读：优先 input+output；没有 output 就用 total
    // （且必须 >= input 才可信）；再不行就 undefined（留给上层本地估算）。
    outputTokens > 0
      ? inputTokens + outputTokens
      : totalTokens !== undefined && totalTokens >= inputTokens
        ? totalTokens
        : undefined;

  return {
    cacheReadTokens,
    cacheWriteTokens,
    contextUsageTokens,
    inputTokens,
    outputTokens,
  };
}

// "输入窗口"的回退链：优先直接用 input；没有就用 total-output 倒推；
// 还没有就把缓存读写合计当近似值——数据源逐级降级，直到承认拿不到。
function persistedInputWindowTokens(tokens: TokenUsageInfo): number | undefined {
  const inputTokens = positiveInteger(tokens.input);
  if (inputTokens !== undefined) return inputTokens;

  const totalTokens = positiveInteger(tokens.total);
  if (totalTokens !== undefined) {
    // Math.max(0, ...) 兜底：倒推结果不允许是负数。
    return Math.max(0, totalTokens - (nonNegativeInteger(tokens.output) ?? 0));
  }

  const cacheTokens =
    (nonNegativeInteger(tokens.cache.read) ?? 0) + (nonNegativeInteger(tokens.cache.write) ?? 0);
  return cacheTokens > 0 ? cacheTokens : undefined;
}

// 两个"数据安检员"：只放行正整数 / 非负整数，其余（NaN、Infinity、小数、负数）一律 undefined。
// Number.isFinite 专门排除 NaN 和 ±Infinity——清洗外部数据的标准姿势。
function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}
