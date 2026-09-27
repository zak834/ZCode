// ============================================================
// Tool Path Policy
// ============================================================
// 工具的路径策略：把"模型给的相对/绝对路径"落成确定的绝对路径。
// 这是路径越界防护（AGENTS.md"工具与副作用契约"）的第一道关口——
// 当前策略宽松，但收敛点已统一在这里（见下方英文注释）。

import { isAbsolute, normalize, resolve } from "node:path";
import { CoreErrorType, createCoreError } from "@zcode/contracts";

interface ToolWorkspacePathOptions {
  inputPath: string;
  workingDirectory: string;
  workspaceRoot: string;
  // 字面量联合：三种操作形态（未来权限规则可按操作粒度区分）。
  operation: "read" | "write" | "execute";
}

export function resolveWorkspacePath(options: ToolWorkspacePathOptions): string {
  // 先校验两个基准目录必须是绝对路径（第二个调用纯做校验，返回值弃用）。
  const workingDirectory = normalizeAbsoluteDirectory(
    options.workingDirectory,
    "workingDirectory",
  );
  normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const requestedPath = options.inputPath;

  // 空路径直接抛结构化错误（createCoreError 用法 turn-machine 讲过）。
  if (requestedPath.length === 0) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Tool path must not be empty", {
      context: {
        operation: options.operation,
      },
      recoverable: true,
    });
  }

  // 核心分叉：绝对路径只做归一化；相对路径基于工作目录 resolve 成绝对路径。
  const resolvedPath = isAbsolute(requestedPath)
    ? normalize(requestedPath)
    : resolve(workingDirectory, requestedPath);

  // Current release intentionally does not hard-block paths outside workspaceRoot.
  // Cause: subagents may need to inspect user-requested sibling repos or external files
  // before the filesystem permission adapter grows explicit ask/deny rules for them.
  // （补充：当前版本刻意不硬拦工作区外的路径——等文件系统权限 adapter
  //   长出显式 ask/deny 规则前，子代理可能需要查看用户指定的外部文件。）
  return resolvedPath;
}

// 解析工具实际使用的工作目录：调用方给了 cwd 就按路径策略解析它，没给就沿用默认。
// `Omit<T, K>` 工具类型：从 T 的形状里**剔除** K 字段——与 Pick（挑出）相对，
// 用于"复用类型但少几个字段"。
export function resolveToolWorkingDirectory(
  inputCwd: string | undefined,
  options: Omit<ToolWorkspacePathOptions, "inputPath">,
): string {
  if (!inputCwd) {
    const workingDirectory = normalizeAbsoluteDirectory(
      options.workingDirectory,
      "workingDirectory",
    );
    normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
    return workingDirectory;
  }

  return resolveWorkspacePath({
    ...options,
    inputPath: inputCwd,
  });
}

// 私有校验器：目录规范化后必须仍是绝对路径，否则抛配置错误。
// `recoverable: false`：配置错误重试也不会好——要在部署时修好。
// `[label]: value` 计算属性键（serialization 讲过）：错误上下文的字段名由 label 动态决定。
function normalizeAbsoluteDirectory(value: string, label: string): string {
  const normalized = normalize(value);
  if (!isAbsolute(normalized)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `${label} must be an absolute path for tool execution`,
      {
        context: {
          [label]: value,
        },
        recoverable: false,
      },
    );
  }
  return normalized;
}
