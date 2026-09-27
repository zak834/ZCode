// bash 工具的超时策略：默认超时 + 上限，两层防线（单条命令别跑太久，也永远别超过上限）。
// 常量单独命名（AGENTS.md：不散落字面量）；`120_000` 的下划线是数字分隔符 = 120 秒。
export interface BashTimeoutPolicy {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const DEFAULT_BASH_MAX_TIMEOUT_MS = 600_000;

export const DEFAULT_BASH_TIMEOUT_POLICY: BashTimeoutPolicy = {
  defaultTimeoutMs: DEFAULT_BASH_TIMEOUT_MS,
  maxTimeoutMs: DEFAULT_BASH_MAX_TIMEOUT_MS,
};

// 从环境变量解析策略。env 由调用方注入而不是直接读 process.env——core 不碰外部世界的纪律。
// `Readonly<Record<...>>`：Record 字典（turn-state 讲过）再套 Readonly 只读视图，防函数内乱改。
export function resolveBashTimeoutPolicy(
  env: Readonly<Record<string, string | undefined>>,
): BashTimeoutPolicy {
  const defaultTimeoutMs =
    parsePositiveTimeout(env.BASH_DEFAULT_TIMEOUT_MS) ?? DEFAULT_BASH_TIMEOUT_MS;
  const configuredMaxTimeoutMs = parsePositiveTimeout(env.BASH_MAX_TIMEOUT_MS);

  return {
    defaultTimeoutMs,
    // 上限永远 >= 默认值（Math.max 兜底）：防止配置出"上限比默认还小"的矛盾策略。
    maxTimeoutMs:
      configuredMaxTimeoutMs !== undefined
        ? Math.max(configuredMaxTimeoutMs, defaultTimeoutMs)
        : Math.max(DEFAULT_BASH_MAX_TIMEOUT_MS, defaultTimeoutMs),
  };
}

// 计算一次调用真正生效的超时：调用方给的就尊重（但不超过上限），没给就用默认。
// `inputTimeoutMs || 默认` 的 || 是刻意的：0 不是合法超时，falsy 一律视为"没给"。
export function resolveBashTimeoutMs(
  inputTimeoutMs: number | undefined,
  policy: BashTimeoutPolicy,
): number {
  return Math.min(inputTimeoutMs || policy.defaultTimeoutMs, policy.maxTimeoutMs);
}

// 字符串 → 正整数毫秒。空串/非数字/非正数一律 undefined（交还给默认值逻辑）。
function parsePositiveTimeout(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}
