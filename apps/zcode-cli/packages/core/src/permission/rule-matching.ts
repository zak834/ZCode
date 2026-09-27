// 把通配符模式（如 "example.com/*"）转成正则。
// 关键是转义：先按 * 切开，把每段里的正则特殊字符全部加反斜杠（`\\$&` 表示
// "在匹配到的字符前补一个反斜杠"），再用 .* 把段拼回去——这样用户写的 * 才是
// 通配符，其余字符都按字面匹配，不会被当成正则语法注入。
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  // `^...$` 锚定首尾：必须整串匹配，防止 "evil-example.com" 混过 "example.com"。
  return new RegExp(`^${escaped}$`);
}

// 从 URL 提取"域名规则主体"：规则匹配用的键（如 domain:example.com）。
// try/catch：URL 构造函数解析失败会抛错——非法 URL 就没有主体。
// 小写化 + 去掉末尾点（"Domain.com." 与 "domain.com" 是同一主机）。
function domainRuleSubject(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim());
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return hostname.length > 0 ? `domain:${hostname}` : undefined;
  } catch {
    return undefined;
  }
}

// webfetch 工具的规则主体：目前只有"域名"一种粒度。
export function webFetchRuleSubjects(url: string): string[] {
  const domain = domainRuleSubject(url);
  return domain ? [domain] : [];
}
