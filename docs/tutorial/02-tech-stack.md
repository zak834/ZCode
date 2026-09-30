# 02 · 技术栈清单

> 本章你将学到：这个项目用到的**每一个主要技术**——它是什么（小白解释）、装在哪个包里、想深入时去看哪个文件。
>
> 版本号均来自各 `package.json` 的实际声明，不是凭印象写的。读法建议：第一遍扫「是什么」建立印象，等 03 章读完仓库地图后再回来按「深入看哪」逐个击破。

---

## 语言与运行时

| 技术 | 是什么 | 在哪用 |
| --- | --- | --- |
| **TypeScript** | 见 [01 章](./01-ts-primer.md)。根 workspace 用 `^6.0.2`，`apps/zcode-cli` 嵌套 workspace 用 `^5.9.0` | 全仓库 |
| **Node.js 24.14.0** | JS 的服务端运行时。版本钉死在 `mise.toml` | server、zcode-server-cli、CLI/TUI 的运行环境 |
| **ESM** | ES Module，JS 官方模块标准（`import`/`export`）。根 `package.json` 的 `"type": "module"` 声明全仓库用 ESM 而非老的 CommonJS | 全仓库 |

## 包管理与工程化

| 技术 | 是什么 | 在哪用 |
| --- | --- | --- |
| **pnpm 10.33.2** | 包管理器，workspace 是 monorepo 的地基（见 [01 章](./01-ts-primer.md) 第 3 节） | 根 `pnpm-workspace.yaml` + 嵌套的 `apps/zcode-cli/pnpm-workspace.yaml` |
| **turbo** | monorepo 构建编排器：按依赖关系决定构建顺序、缓存构建结果 | 仅 `apps/zcode-cli`（它有独立 `turbo.json`）；主 workspace 用 `tsc -b` 项目引用 |
| **oxlint / oxfmt** | Rust 写的 linter / 格式化器，对标 ESLint/Prettier 但快一个量级。配置在根目录 `.oxlintrc.json`、`.oxfmtrc.json` | 全仓库，`pnpm lint` / `pnpm fmt` |
| **husky + lint-staged** | Git 提交钩子：commit 时只对「暂存的文件」自动跑 lint/格式化 | `.husky/` 目录 |
| **knip** | 静态分析找出「没人用的依赖、导出、文件」，防代码腐化 | `pnpm knip`，配置 `knip.json` |
| **release-it** | 自动化发版：改版本号、生成 changelog、打 tag | 根 `.release-it.mjs` |
| **tsx** | 直接运行 TS 文件的工具（不走完整编译，适合开发期） | `pnpm dev:server` 等开发脚本 |
| **tsup** | 把 TS 库打包成发布产物的工具（基于 esbuild） | `packages/server`、`packages/desktop`、`packages/zcode-server-cli` 及 CLI 各子包的 `build` 脚本 |
| **esbuild** | 极速 JS/TS 打包器（Go 写的），上面两位的底层引擎，也被直接使用 | `packages/services`、`apps/zcode-cli/packages/browser-use-plugin` 等 |

> 💡 **TS 知识点：tsx、tsup、esbuild、tsc 到底谁干啥**
> 四个都碰 TS 但分工不同：**tsc** 是官方编译器，负责类型检查 + 生成 `.d.ts`（`pnpm typecheck` 就是它）；**esbuild** 只管「快速把 TS 变 JS」，不查类型；**tsup** 是基于 esbuild 的「打包成品」封装（帮你处理格式、声明文件）；**tsx** 是「直接跑」的开发工具。一句话：**查类型找 tsc，跑代码用 tsx，发布打包用 tsup**。

## 前端（`packages/ui`、`packages/web`、`packages/desktop` 渲染层）

| 技术 | 是什么 | 在哪用 |
| --- | --- | --- |
| **React 19** | UI 框架。根 `package.json` 用 pnpm `overrides` 把全仓库 React 钉在 19.2.7 | ui / web / desktop renderer，以及——出人意料地——终端 TUI（见下文「终端 UI」） |
| **Vite** | 前端开发服务器 + 打包器：开发期秒级热更新（HMR） | `packages/web`、`packages/desktop`、`packages/formal-proof`、`apps/zcode-cli/packages/debug`，各有 `vite.config.ts` |
| **Tailwind CSS v4** | 原子化 CSS：直接在 JSX 上写 `class="flex items-center"`。v4 走 `@tailwindcss/vite` 插件、CSS 内配置 | ui / web / desktop。UI 字体必须用 `DESIGN.md` 规定的 `text-ui-*` token |
| **Zustand 5** | 极简状态管理库：一个 `create()` 定义全局 store，组件按需订阅 | `packages/ui/src/store/`（全仓库的共享状态都在这） |
| **SWR** | 数据请求库：自带缓存、自动重验证 | `packages/ui` 的服务数据获取 |
| **Radix UI + shadcn 风格** | 无样式的可访问组件原语（对话框、下拉、菜单…）+ `class-variance-authority`/`tailwind-merge`/`clsx` 组合出组件体系 | `packages/ui/src/components/` |
| **Lexical** | Meta 开源的富文本编辑器框架 | 聊天输入框 `packages/ui/src/LexicalChatInput.tsx`、`packages/ui/src/prompt-editor/` |
| **xterm.js** | 浏览器里的终端模拟器 | `packages/ui/src/terminal/`（配合服务端 node-pty，见「桌面」） |
| **shiki** | 代码高亮引擎（用真实的 VS Code 语法定义） | ui 和 tui 都在用（终端里也高亮） |
| **streamdown** | 针对 LLM 流式输出优化的 Markdown 渲染（配合 `@streamdown/cjk`、`@streamdown/mermaid` 等） | AI 回复的渲染，`packages/ui` |
| **recharts / @xyflow/react / dnd-kit / motion** | 图表 / 节点流程图 / 拖拽 / 动画，各管一个交互域 | `packages/ui` |
| **pdf.js、react-pdf、docx-preview、@extend-ai/react-xlsx、@aiden0z/pptx-renderer** | 办公文档与 PDF 预览四件套 | `packages/ui/src/` 的 previewPane* 系列文件 |
| **katex、marked、highlight.js、pinyin-pro、@stripe/*** | 数学公式、Markdown 解析、高亮、拼音搜索（中文文件名匹配）、支付 | `packages/ui` |

> 💡 **TS 知识点：`.tsx` 不是新语言**
> `tsx` 后缀 = TypeScript + JSX（见下方专节）。只有包含 JSX 的文件才用 `.tsx`，纯逻辑文件仍是 `.ts`。本仓库约定：`packages/ui` 里连 hooks 都可能含 JSX，所以 hooks 目录里也有 `.tsx`。

### JSX：在 JS 里直接写「类 HTML 标签」的语法扩展

初学者第一次打开 `packages/ui/src/components/` 会看到这种代码：

```tsx
function Greeting({ name }: { name: string }) {
  return <h1 className="text-ui-lg">Hello, {name}!</h1>;
}
```

`<h1>...</h1>` 看起来像 HTML，但它其实是 **JSX**——一个由 React 团队发明的语法扩展，**不是 JS 的标准语法**。浏览器和 Node 都不认识它，必须先「编译」成普通 JS 才能运行。

#### 它本质上是什么：一个函数调用

编译后，上面那段等价于：

```ts
React.createElement('h1', { className: 'text-ui-lg' }, 'Hello, ', name, '!')
```

也就是说 `<h1>...</h1>` 只是个**语法糖**，编译器会把它翻译成对 `React.createElement` 的调用：第一个参数是标签名（或组件函数），第二个是属性对象，后面是子节点。JSX 的意义是让这种「创建 UI 元素」的代码写起来像 HTML 一样直观，不用写一长串嵌套函数调用。

#### 和 HTML 的关键差异（容易踩的坑）

| 点 | HTML | JSX |
| --- | --- | --- |
| 属性命名 | `class="foo"` | `className="foo"`（因为 `class` 是 JS 保留字） |
| 属性命名 | `for="id"` | `htmlFor="id"`（同理 `for` 是保留字） |
| 标签闭合 | `<br>` 可不闭合 | 必须写 `<br />`（自闭合或显式闭合） |
| 大小写 | 不区分 | 区分：`<div>` 是 HTML 标签，`<MyComp>` 是自定义组件（首字母大写即组件） |
| 注释 | `<!-- -->` | `{/* 注释 */}`（写在花括号里，因为这是 JS 上下文） |
| 条件渲染 | 没有原生方式 | `{cond && <Comp/>}` 或三元 `{c ? <A/> : <B/>}` |

#### 为什么需要 `jsx: "react-jsx"` 编译选项

TypeScript 编译器本身也不认识 JSX——它需要你在 `tsconfig.json` 里开 `jsx` 选项告诉它「怎么处理这些尖括号」：

- `"react-jsx"`（React 17+ 的自动转换）：编译器自动注入 `react/jsx-runtime` 里的辅助函数，**组件文件里不用再写 `import React`**。本仓库 web、ui、renderer、tui、debug 都用这个；
- `"react"`（旧式）：编译产物调用 `React.createElement`，所以每个文件都要 `import React from 'react'`；
- `"preserve"`：TS 不翻译，保留 JSX 原样，交给后续的 Babel/esbuild 处理（Vite 用这种，最终由 esbuild 转换）。

`react-jsx` 是现在的默认选择——本仓库的 tsconfig 里凡是有 `jsx: "react-jsx"` 的包，都享受这种「自动导入」的便利。

#### JSX 不是 React 独占的

JSX 是语法扩展，任何库都能用它的「在 JS 里写标签」能力。本仓库里就有两个非典型使用者：

- **React（浏览器/渲染进程）**：最主流用法，`<div>` 变 DOM 节点，见 `packages/ui`、`packages/web`、desktop renderer；
- **React + opentui（终端 TUI）**：同样的 `<Box>`、`<Text>` 组件，但渲染目标不是浏览器像素，而是终端字符网格——见 `apps/zcode-cli/packages/tui` 的 110+ 个 `app-*.tsx`。同一种写 UI 的心智模型，跨端复用。

#### 一个最小可运行例子

```tsx
// App.tsx —— 后缀必须是 .tsx 才能写 JSX
import { useState } from "react";

function App() {
  const [n, setN] = useState(0);
  return (
    <button onClick={() => setN(n + 1)}>
      点击了 {n} 次
    </button>
  );
}
```

注意三件事：
1. 文件后缀是 `.tsx`（不是 `.ts`）——TS 遇到 `.ts` 里的尖括号会把它当成「类型断言」语法报错；
2. `onClick` 用驼峰（不是 HTML 的 `onclick`），值是**函数**而不是字符串——这是「属性是 JS 表达式」的体现；
3. `{n}` 是「JSX 表达式插值」：花括号里可以放任何 JS 表达式，编译后会被作为子节点插入。

> 💡 **TS 知识点：`.tsx` 里的尖括号歧义**
> 同样一个 `<Foo>`，在 `.tsx` 里是 JSX 标签，在 `.ts` 里会被当成类型断言 `value as Foo` 的旧式写法。这也是为什么 JSX 必须放 `.tsx` 文件——让编译器明确切换到「JSX 模式」，避免歧义。本仓库 ui 包的 tsconfig 里 `include` 用了 `src/**/*.tsx` 显式 glob，就是为了把这些 JSX 文件稳定纳入工程。

## 桌面（`packages/desktop`）

| 技术 | 是什么 | 在哪用 |
| --- | --- | --- |
| **Electron** | 用 Chromium + Node.js 把 Web 应用打包成桌面应用 | 整个 `packages/desktop`，入口 `src/main/index.ts`（构建产物 `out/main/index.js`） |
| **electron-builder** | 打包分发工具：产出 DMG / NSIS 安装包 / AppImage | `pnpm bundle:desktop` |
| **electron-updater** | 应用内自动更新 | `packages/desktop/src/main/autoUpdater.ts` |
| **node-pty** | 伪终端（PTY）：让程序「以为」自己在真终端里运行。xterm.js 显示 + node-pty 执行 = 应用内完整终端 | desktop 和 server 都内置了各平台二进制 |
| **ssh2** | SSH 协议实现：远程工作区连接 | desktop / server |
| **http-mitm-proxy** | HTTP 中间人代理（开发调试抓包用） | desktop devDeps、CLI 的 debug 工具 |

> 💡 **TS 知识点：Electron 的三个进程**
> Electron 应用有三个世界，本仓库目录严格对应：**main**（`src/main/`，主进程，Node.js 环境，管窗口/原生能力）、**preload**（`src/preload/`，安全桥，把受限的 API 暴露给页面——这就是为什么 UI 层规则说「通过 `IPlatformService` 而不是直接碰 `window.zcode`」）、**renderer**（`src/renderer/`，就是 Chromium 里的 React 页面）。进程间通信（IPC）走 `packages/rpc`。

## 服务端（`packages/server`、`packages/zcode-server-cli`）

| 技术 | 是什么 | 在哪用 |
| --- | --- | --- |
| **Hono 4** | 轻量 Web 框架（对标 Express，但类型安全、更快、可跑在多运行时） | `packages/server/src/http.ts`，入口 `src/entry-http.ts`（默认端口 3030） |
| **@hono/node-server + @hono/node-ws** | Hono 的 Node 适配器 + WebSocket 支持 | server / zcode-server-cli |
| **ws** | 最流行的 Node WebSocket 库 | server、desktop（客户端侧则直接用浏览器原生 `WebSocket`，见 `packages/client/src/websocket.ts`） |
| **undici / axios** | HTTP 客户端（undici 是 Node 官方底层库） | server 用 axios 调产品服务，services/desktop 用 undici |

## 协议与校验

| 技术 | 是什么 | 在哪用 |
| --- | --- | --- |
| **zod** | 运行时 schema 校验 + 类型推导（见 [01 章](./01-ts-primer.md) 第 6 节）。主仓库 4.6.5，CLI 的 contracts 包用 3.x | `packages/shared`、`packages/provider`、`apps/zcode-cli/packages/contracts` |
| **自研 RPC 框架** | 「VS Code 风格 IPC 通信抽象」——7 层架构从序列化一直做到远程连接。**全仓库零外部依赖**，进程间/设备间通信全靠它 | `packages/rpc/src/index.ts` 开头有作者画的架构图，教科书级注释 |
| **ZCode Protocol v4** | ZCode 自己的客户端↔Agent 协议，schema + 运行时校验 | `packages/shared/src/zcode-protocol-v4/` |
| **MCP（Model Context Protocol）** | Anthropic 发起的「给 AI 接工具」的开放协议，本仓库既是 MCP 客户端也内置 MCP server | `apps/zcode-cli/packages/adapters/src/mcp/`、`node-repl-host`、`browser-use-plugin` |

## AI 层

| 技术 | 是什么 | 在哪用 |
| --- | --- | --- |
| **Vercel AI SDK v6**（`ai`） | 统一各家大模型 API 的 SDK：流式输出、工具调用、多模态都有统一抽象 | `apps/zcode-cli/packages/adapters`（钉版 6.0.193）、`packages/ui` |
| **@ai-sdk/anthropic、@ai-sdk/openai、@ai-sdk/openai-compatible** | AI SDK 的各家 provider 插件：Anthropic / OpenAI / 任何兼容 OpenAI 接口的服务 | `apps/zcode-cli/packages/adapters/src/model/`。其中 anthropic 和 openai-compatible 两个包带着 pnpm 补丁（见根目录 `patches/`） |

> 💡 **TS 知识点：为什么 AI SDK 值得学**
> 它是「用泛型 + 判别联合（discriminated union）建模流式协议」的范本：模型每吐一段内容是一个带 `type` 字段的事件（`text-delta` / `tool-call` / `finish`…），TS 能对每种事件给出精确类型——读 `packages/ui` 里渲染 AI 消息的代码时，你会反复见到对这种联合类型的 `switch` 收窄。

## 可观测与终端

| 技术 | 是什么 | 在哪用 |
| --- | --- | --- |
| **OpenTelemetry 2.x** | 行业标准的链路追踪 / 指标采集 | `apps/zcode-cli/packages/telemetry`、`packages/desktop`（OTLP 导出） |
| **@mbears/opentui-core / opentui-react 0.2.15** | **用 React 写终端界面**的渲染器：React 组件不渲染到 DOM，而是渲染到终端字符网格 | `apps/zcode-cli/packages/tui`（110+ 个 `app-*.tsx` 文件都是终端 React 组件） |
| **web-tree-sitter** | 增量语法解析器（编辑器高亮/折叠的底层技术） | tui 的代码渲染 |
| **@arms/rum-electron** | 阿里云 ARMS 前端监控（带 pnpm 补丁） | desktop 遥测 |

## 根目录支撑设施

| 位置 | 是什么 |
| --- | --- |
| `patches/` | 3 个 pnpm 补丁：`@ai-sdk/anthropic`、`@ai-sdk/openai-compatible`、`@arms/rum-electron`。上游库有小问题/需要定制时，不改源码、用补丁文件叠加修改（`pnpm-workspace.yaml` 里登记生效） |
| `scripts/` | 40+ 个 Node 构建维护脚本：`bootstrap.mjs`（初始化）、`build-zcode.mjs`（命令行发行包）、`dev-desktop-env.mjs`（桌面开发环境选择）、`architecture/`（架构检查引擎）、`native-search-tools-*`（原生搜索工具的构建打包）、`licenses.mjs` 等。都是普通 JS，不用怕 |
| `config/` | 随客户端发布的内置 Provider 配置（`default.json` + `provider/` 目录） |
| `third-party/` | 开源合规材料：依赖清单、上游组件副本、许可声明（对应根目录 `THIRD-PARTY-NOTICES.md`） |

---

**下一章**：[03 · 仓库地图](./03-repo-map.md) —— 30 多个包每个是干嘛的，一次对话如何穿过它们。
