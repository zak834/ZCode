// 权限规则里的"工具名"匹配：把规则文本解析成干净的工具名集合。
// 规则形如 "WebSearch" 或 "Bash(git *)"——括号里是参数模式，这里只取工具名部分。
// `readonly string[]`：只读数组类型——承诺不修改调用方的数组（比 string[] 更严格的契约）。
export function normalizeToolNameAlias(toolName: string): string {
  // 历史别名归一：旧名字映射到现行名字，规则书写者不用关心拼写演进。
  return toolName === "web_search" ? "WebSearch" : toolName;
}

function getToolRuleName(rule: string): string {
  const trimmed = rule.trim();
  // 找到第一个 "(" 就把括号及其后的参数模式切掉，只留工具名。
  const parenIndex = trimmed.indexOf("(");
  const rawName = parenIndex > 0 ? trimmed.slice(0, parenIndex) : trimmed;
  return normalizeToolNameAlias(rawName);
}

// 把规则列表预编译成 Set（集合），查询 O(1)。空清单返回 undefined 表示"没有限制"。
export function createToolRuleNameSet(
  rules: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (!rules || rules.length === 0) return undefined;
  const names = new Set<string>();
  for (const rule of rules) {
    const name = getToolRuleName(rule);
    if (name) names.add(name);
  }
  return names.size > 0 ? names : undefined;
}

// 判断某工具是否被禁用。`?.has(...) === true`：没有禁用清单时 ? 短路成 undefined，
// 与 true 严格比较后得 false——"没有清单 = 不禁用"，一个表达式写完两层语义。
export function isToolNameDisallowed(
  toolName: string,
  disallowedTools: readonly string[] | undefined,
): boolean {
  const disallowed = createToolRuleNameSet(disallowedTools);
  return disallowed?.has(normalizeToolNameAlias(toolName)) === true;
}

// 批量版：从工具名列表里剔除被禁用的。
export function filterDisallowedToolNames(
  toolNames: readonly string[],
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  const disallowed = createToolRuleNameSet(disallowedTools);
  if (!disallowed) return toolNames;
  return toolNames.filter((toolName) => !disallowed.has(normalizeToolNameAlias(toolName)));
}
