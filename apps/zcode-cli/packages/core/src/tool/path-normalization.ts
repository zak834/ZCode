// ============================================================
// Tool Path Normalization Helpers
// ============================================================
// 路径归一化：把各种来源的工具路径（用户输入、模型给的、Git Bash 风格的）
// 统一成可比较的标准形。为什么重要？"同一个文件"可能有 N 种写法，
// read-file-state、权限规则都靠"字符串相等"识别路径，不归一就会认错文件。

import path, { normalize } from "node:path";
import { platform as currentPlatform } from "node:process";

export type ToolPathPlatform = NodeJS.Platform;
// `typeof path.posix`（第一次遇到对"值"取 typeof）：
// 取 path.posix 这个**对象**的类型（一个路径处理 API 集合）。
// 联合起来 = "要么 posix 风格 API，要么 win32 风格 API"——方法同名但行为不同。
export type ToolPathApi = typeof path.posix | typeof path.win32;

export function getToolPathApi(platform: ToolPathPlatform): ToolPathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

// 对外主入口：按平台选归一化策略，最后统一做 Unicode NFC 归一。
// `.normalize("NFC")`（第一次遇到）：同一个字符可能有多种 Unicode 编码
// （如 é = 单码位，或 e + 组合符），NFC 选"组合成单码位"的标准形——
// 否则两个"看起来一样"的文件名会因编码不同被判为不同路径。
export function normalizeToolPathForComparison(
  filePath: string,
  platform: ToolPathPlatform = currentPlatform,
): string {
  const normalized =
    platform === "win32" ? normalizeWindowsToolPath(filePath) : normalize(filePath);
  return normalized.normalize("NFC");
}

function normalizeWindowsToolPath(filePath: string): string {
  // Windows 的三步归一流水线：Git Bash 别名 → 官方 normalize + 剥扩展前缀 → 盘符大写。
  const driveAliasNormalized = normalizeWindowsDriveAlias(filePath);
  const prefixStripped = stripWindowsExtendedPathPrefix(path.win32.normalize(driveAliasNormalized));
  return canonicalizeWindowsDriveLetter(prefixStripped);
}

function normalizeWindowsDriveAlias(filePath: string): string {
  // Read/Edit/Write 和 Bash cwd 都会收到 Git Bash 风格的 /c/... 路径；
  // 统一转换到 drive-letter 形式，避免各工具重复实现 Windows path 兼容逻辑。
  // match 返回"匹配结果数组 | null"：[0] 是整体匹配、[1] 是第一个捕获组（盘符字母）。
  const driveAliasMatch = filePath.match(/^\/([A-Za-z])\//);
  if (!driveAliasMatch) return filePath;

  // `!` 非空断言：捕获组 [1] 在这里必然存在（模式里写死了有这个组）。
  const drive = driveAliasMatch[1]!.toUpperCase();
  const rest = filePath.slice(2);
  // 拼上 C: 前缀并把所有正斜杠换成反斜杠（replaceAll 全量替换）。
  return `${drive}:${rest}`.replaceAll("/", "\\");
}

// 盘符大小写归一：c:\ 与 C:\ 必须算同一路径。replace 的第二个参数是回调函数，
// `_` 惯例表示"整个匹配（用不到）"，drive 是捕获组内容。
function canonicalizeWindowsDriveLetter(filePath: string): string {
  return filePath.replace(/^([a-zA-Z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

function stripWindowsExtendedPathPrefix(filePath: string): string {
  // 只剥离 extended UNC 和 drive path，保留 Volume/GLOBALROOT 等设备命名空间。
  // `\\?\...` 是 Windows 的扩展长度前缀（绕过 260 字符限制）；剥掉它才能与普通路径比较。
  if (filePath.startsWith("\\\\?\\UNC\\")) return `\\\\${filePath.slice("\\\\?\\UNC\\".length)}`;
  if (filePath.startsWith("\\\\?\\") && filePath.length >= 7 && filePath[5] === ":") {
    return filePath.slice("\\\\?\\".length);
  }
  return filePath;
}
