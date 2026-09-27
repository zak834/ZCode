# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 必读文档

- [AGENTS.md](AGENTS.md)：仓库核心工作规范（spec 先行、实现与验证、平台边界、日志约定），对本仓库所有改动生效。
- [CONTEXT.md](CONTEXT.md)：插件商店领域词汇表，修改商店相关 UI 前阅读。
- [DESIGN.md](DESIGN.md)：UI 设计规范，修改 UI 前阅读。最硬性的约束：应用 UI 字体必须使用 `text-ui-*` 系列 token，禁止 Tailwind 内置 `text-base/sm/xs`、任意 `text-[13px]` 或内联 font-size。

## 常用命令

版本以 [mise.toml](mise.toml) 为准：Node 24.14.0 + pnpm 10.33.2。命令均在仓库根目录执行。

```bash
node scripts/check-workspace-freshness.mjs   # 开工前检查基线
pnpm bootstrap                # 首次初始化：装依赖 + 桌面运行资源 + 构建

pnpm dev:desktop              # 桌面开发（= dev:desktop:prod，生产服务配置）
pnpm dev:desktop:test         # 桌面开发（测试环境）
pnpm dev:web                  # 同时起 Web(5173) 与后端(3030)
pnpm dev:server               # 仅后端

pnpm typecheck                # tsc 项目引用全量类型检查（必跑）
pnpm lint / lint:fix          # oxlint（必跑）
pnpm fmt:check / fmt          # oxfmt
pnpm verify:pre-push          # lint + architecture:check --changed

pnpm architecture:check -- --changed   # 只检查改动模块（写码前后都要跑）
pnpm architecture:context <module-id>  # 生成模块阅读包（contract + 相关 spec/测试）
pnpm architecture:baseline:update      # 仅限评审通过的基线变更；CI 不自动刷新
pnpm knip                       # 未使用依赖与导出
pnpm dep:refs --list-exports <file>    # 导出引用查询

pnpm build                      # 递归构建所有 workspace 包
pnpm bundle:desktop             # 桌面打包（默认 macOS arm64，--os/--arch 可选）
pnpm build:zcode                # 命令行发行包（需先设 ZCODE_DIST_BASE_URL）
```

**测试**：仓库没有统一的单测/E2E 命令。测试入口以目标包当前 `package.json` 和实际测试文件为准，不假定其存在。

## 架构总览

pnpm monorepo：`packages/*` + `apps/zcode-cli`（后者是嵌套 workspace，含 CLI、TUI、Agent 运行时及自己的 `packages/*` 与 `AGENTS.md`）。

ZCode 是 AI 编程工作台，三个入口共享同一套 UI 与服务层：

- **Desktop**（`packages/desktop`）：Electron。Main 只负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态；通过 stdio 与 Agent 通信，协议定义在 `packages/shared/src/zcode-protocol/index.ts`。每个窗口一个 window-scoped Local Host，本地 workspace 共享该 Host；远程 workspace 由窗口内连接注册表管理。
- **Web / 命令行版**（`packages/web` + `packages/server` + `packages/zcode-server-cli`）：后端托管 Web 页面与 Agent。
- **Agent CLI**（`apps/zcode-cli`）：终端 `zcode` 命令，也是 Desktop/Web 的 Agent 运行时。

### 模块分层（architecture-policy.yaml 管控）

- `packages/shared`：协议与类型；`packages/rpc`：RPC 框架；`packages/client`：Agent 客户端 SDK。
- `packages/services`：业务服务与持久化；`packages/provider(-node)`：模型 Provider。
- `packages/ui`：共享 React 组件、hooks（`src/hooks/`）与 Zustand store（`src/store/`）。
- 管控规则：禁止循环依赖、禁止深层导入（跨包只走公开入口 `contract.ts`）、单文件 ≤400 行。managed 模块按 `domain → app → adapters → ui` 分层：`domain` 纯净无 IO，`app` 通过 port 决定副作用，`adapters` 执行副作用。

### 必须维持的边界与不变量

- UI 通过 `packages/ui/src/hooks/` 访问服务；平台操作走 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调 `window.zcode`。
- 工作区身份：`workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作与展示。身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`；远程链路必须贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 流式链路两种语义并存且需同时验证：Desktop 的 `desktop-continuous`（实时直连）与手机的 `web-remote-replayable`（快照 + 缺口修复）。relay/Main 只做鉴权、配对、心跳、转发，不存业务状态。
- 已接受输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留草稿与 pending overlay；保留 owner/lease、跨 Host 路由与 stale run 防护。
- 日志：UI 用 `packages/ui/src/logger.ts`；服务层用 `createServiceLogger(scope)`；不用 `console.log`。跨平台（Windows/macOS/Linux）路径与子进程交互用 Node 标准 API，不硬编码 POSIX 语法。
- 环境变量统一 `ZCODE_` 前缀；新增前必须先在对应 spec 中定义。

## 改码工作流（架构治理）

1. `pnpm architecture:check -- --changed` 确认改动涉及模块。
2. `pnpm architecture:context <module-id>` 读取目标 contract 与相关 spec，再读实现。
3. **先写/改 spec 再写代码**：明确行为、唯一状态所有者、接口、事件顺序与验收场景。
4. 设计检查：每个可变状态只有一个 owner、一条写入路径（能复用现有 service/hook/adapter 就不新造）；异步/远程行为先写明事件顺序、幂等边界、stale 规则。
5. 改完再跑 `pnpm architecture:check -- --changed`，必须执行 `pnpm typecheck` 和 `pnpm lint` 并报告真实结果。bug 修复用中文注释说明原因与依据。
