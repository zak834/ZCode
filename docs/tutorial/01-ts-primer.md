# 01 · TypeScript 预备章

> 本章你将学到：TypeScript 和 JavaScript 的关系；`tsconfig.json` 在 TS 里起什么作用、本仓库 `tsconfig.base.json` 每个选项是什么意思、**基座之外各包出现的全部配置项**（`strict`、`jsx`、`noEmit`、`paths` 等），以及**全仓库 38 份 tsconfig 的角色总览**；monorepo 里包和包怎么互相引用；以及本项目代码里最高频的几个 TS 概念——`import type`、interface、泛型、zod。
>
> 所有例子都来自本仓库的真实代码，读完你就能无障碍开始读项目源码。

---

## 1. TypeScript 是什么

一句话：**TypeScript = JavaScript + 类型标注**。它不是新语言，而是 JS 的「超集」——所有合法 JS 都是合法 TS。你写的 TS 代码经过编译（type check + 转译）后，最终运行的仍然是 JS。

为什么大项目都用 TS？JS 的变量类型只有运行时才知道，`user.nmae`（拼写错了）要等用户报障才发现；TS 在**你保存文件的那一刻**就告诉你 `nmae` 不存在于 `User` 类型上。仓库越大，这笔投资回报越高。

> 💡 **TS 知识点：类型只活在编译期**
> TS 的类型在编译成 JS 后**完全消失**。运行时没有 `User` 这个类型，只有真实的对象。这带来一个重要推论：**来自网络、磁盘、用户输入的数据，运行时无法自动获得类型保护**——这正是本仓库大量使用 zod 的原因（见第 6 节）。

---

## 2. tsconfig 逐项解读：从基座到全仓库 38 份配置

### tsconfig.json 在 TypeScript 中的作用

每个 TypeScript 项目都有一个 `tsconfig.json`——它是 TypeScript 编译器 `tsc` 的配置文件，告诉编译器「检查哪些文件、按什么规则检查和编译」。`tsc` 的所有行为都由它驱动，它回答三个问题：

| 问题                       | 由哪些字段回答                                                                 |
| -------------------------- | ------------------------------------------------------------------------------ |
| **编译哪些文件？**   | `include`（收编哪些目录/文件）、`exclude`（排除谁）、`files`（逐个点名） |
| **怎么编译？**       | `compilerOptions`——下方表格里的所有开关都住在它里面                        |
| **怎么复用与组合？** | `extends`（继承另一份配置）、`references`（项目引用，配合 `composite`）  |

四个新手容易踩的点：

1. **tsc 怎么找到它**：直接运行 `tsc`（不带文件参数）时，编译器从当前目录**逐级向上**找最近的 `tsconfig.json`，找到就按它执行，找不到就报错。所以「在哪个目录跑命令」会影响结果。本仓库的 `pnpm typecheck` 用 `tsc -b` 显式按项目引用构建，不依赖这个向上查找。
2. **它是 JSONC，不是严格 JSON**：tsconfig 允许 `//` 注释和尾逗号，严格 JSON 不允许。`tsconfig.base.json` 里能写逐行中文注释（用 IDE 打开就能看到），正是靠这个特性。
3. **它同时驱动 IDE**：VS Code 里的红色波浪线、自动补全、跳转到定义，背后就是按 tsconfig 配置在跑的 tsc 语言服务。改了 tsconfig 后 IDE 没反应，用命令面板执行「TypeScript: Restart TS Server」。
4. **没有它会怎样**：tsc 仍能编译你显式指定的文件，但全部用默认值（`target` 退回 ES5、没有严格检查），IDE 也不知道你的项目边界在哪，提示会失真。所以每个 TS 项目都以它为起点。

monorepo 只有一份 tsconfig 不够：30+ 个包要各自指定 `include` 和产物目录，但编译规则又必须完全一致。于是把公共部分抽成一个基础文件，各包 `extends` 它、只写自己的差异。本仓库的基础文件就是 `tsconfig.base.json`（文件里已附逐行中文注释，可对照下表阅读）：

🔍 `tsconfig.base.json`

| 选项                                 | 值           | 小白解释                                                                                                                           |
| ------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `target`                           | `es2024`   | 编译产物按 ES2024 标准输出。Node 24 足够新，所以可以用最现代的 JS 语法，不用老掉牙的转译                                           |
| `lib`                              | `es2024`   | 允许使用的全局 API 类型（`Promise`、`Map`、`structuredClone` 等）按 ES2024 提供                                              |
| `module` / `moduleResolution`    | `nodenext` | 按Node.js 官方 ESM 规则处理模块。**对本仓库影响最大的一条**，见下方卡片                                                      |
| `declaration` + `declarationMap` | `true`     | 编译时生成`.d.ts` 类型声明文件。**monorepo 的关键**：包 A 引用包 B 时，B 的类型就来自这些 `.d.ts`                        |
| `composite`                        | `true`     | 启用「项目引用（project references）」。根目录`pnpm typecheck` 用的 `tsc -b`（build 模式）要求它，还能增量缓存、只重查改过的包 |
| `esModuleInterop`                  | `true`     | 让 ESM 的`import` 和老式 CommonJS 的 `require` 互操作更顺手                                                                    |
| `resolveJsonModule`                | `true`     | 允许`import data from "./x.json"`                                                                                                |
| `skipLibCheck`                     | `true`     | 不检查第三方库内部的类型错误（只查你自己的代码，加速编译）                                                                         |
| `verbatimModuleSyntax`             | `true`     | **强制你区分「导入值」还是「导入类型」**（见第 4 节）                                                                        |
| `isolatedModules`                  | `true`     | 每个文件必须能被单独编译。esbuild/tsup 这类快速打包器是逐文件处理的，这条保证它们不出错                                            |
| `noUncheckedIndexedAccess`         | `true`     | 最严格的防越界开关：`arr[i]` 的类型是 `T \| undefined` 而不是 `T`，逼你处理「索引可能不存在」                                 |

> 💡 **TS 知识点：为什么本仓库的 import 都带 `.js` 后缀**
> 在 `nodenext` 模式下，相对导入必须写完整文件名，而且**写 `.js` 而不是 `.ts`**：
>
> ```ts
> // ✅ 本仓库的写法（源文件是 runtime.ts，却导入 runtime.js）
> import { AgentRuntime } from "./runtime/agent-runtime.js";
> ```
>
> 因为编译后 `runtime.ts` 会变成 `runtime.js`，Node 直接运行编译产物时按你写的路径找文件——写 `.ts` 运行时就找不到了。

### 2.1 基座之外：各包出现的全部配置项

基座的 14 个选项是「公共校规」，但各包还有「本班补充规定」。下面把**其余 37 份配置里出现过的每一个选项**讲透。每份 tsconfig 里的中文注释也是按这套解释写的，可以对照阅读。

#### A. 顶层字段（不放在 `compilerOptions` 里）

| 字段           | 作用                                                                                                      | 本仓库示例                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `extends`    | 继承另一份 tsconfig，父配置的选项全部生效，本文件只写要覆盖的差异                                         | 主 workspace 的包几乎都写`"extends": "../../tsconfig.base.json"`  |
| `include`    | 圈定哪些文件属于本工程（目录或 glob，如`["src/**/*.ts"]`）                                              | 几乎每个包都有                                                      |
| `exclude`    | 从工程里排除文件（依赖、产物、测试最常见）                                                                | `["node_modules", "dist", "**/*.test.ts"]`（core 包排除测试文件） |
| `files`      | 逐个点名要编译的文件；给空数组`[]` 表示「本工程不含源码，只做聚合」                                     | desktop 的解决方案入口`files: []` + 5 个 references               |
| `references` | 声明依赖的其他 TS 工程；`tsc -b` 先构建被引用方，本工程直接读它的 `.d.ts`，不把对方源码拖进来重复检查 | 如 client 引用`../rpc`、`../services`                           |
| `$schema`    | 给编辑器看的 JSON 结构说明书地址，只影响自动补全/校验提示，不影响编译                                     | 仅`apps/zcode-cli/tools/typescript/tsconfig.json` 写了            |

> 💡 **为什么 references 这么重要**：不写它，tsc 发现你 import 了别的包，会顺着包入口把对方的 **.ts 源码**当自己的输入重新检查一遍——同一批错误在每个消费方都打印一次，还可能因为两个包的编译选项不同而给出矛盾结果。写了 references，消费方只读对方已生成的 `.d.ts`，快且一致。仓库里 rpc 包相关的 references 修复注释记录的就是这个坑。

#### B. 目录与产物

| 选项                    | 取值                                                       | 小白解释                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rootDir`             | `src` / `.`                                            | **源码的根目录**。产物会剥掉这个前缀：`src/a/x.ts` → `dist/a/x.js`。所有被编译文件必须在它之下，否则报错。debug 服务端配置因为输入横跨 `server/`、`scripts/`、`src/shared.ts`，根只能设为包根 `.` |
| `outDir`              | `dist` / `out/main` / `dist-types` / `dist-server` | **产物输出目录**。desktop 五个子工程分别输出到 `out/main`、`out/host` 等避免互相覆盖；纯类型包用 `dist-types`；debug 面板与服务端用 `dist` 与 `dist-server` 分开                                     |
| `noEmit`              | `true` / `false`                                       | `true` = tsc **只查错、不产出任何文件**。浏览器端包（web、renderer、formal-proof、debug 面板）都开它，因为 JS 由 Vite/electron-vite 打包，tsc 再产物只会重复覆盖                                             |
| `emitDeclarationOnly` | `true`                                                   | **只产 `.d.ts` 声明、不产 JS**。纯类型/契约包（shared-types、contracts、browser-use-plugin）使用，它们的运行时代码由消费方打包带走                                                                           |
| `declaration`         | `false`                                                  | 基座默认`true`（库要对外暴露类型）；debug 的服务端配置显式设 `false`——产物只给自己运行，不需要声明文件                                                                                                         |

#### C. 类型环境：让 tsc 认识「你在什么世界写代码」

| 选项        | 取值                     | 小白解释                                                                                                                                                             |
| ----------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types`   | `["node"]`             | **显式点名加载哪些全局类型包**。写了它，TS 才认识 `process`、`Buffer`、`__dirname`。一旦显式写了 types，其他 `@types/*` 就不会被自动全局加载           |
| `types`   | `["vite/client"]`      | Vite 客户端专属类型：`import.meta.env.DEV`、`import logo from './logo.svg'` 这类资源导入。formal-proof 和 debug 面板使用                                         |
| `types`   | `["node", "electron"]` | 额外获得`Electron` 命名空间类型（如 `Electron.MessageEvent`）。desktop scheduler 使用                                                                            |
| `jsx`     | `react-jsx`            | 告诉 tsc 怎么理解`.tsx` 里的 `<div/>`。`react-jsx` 是 React 17+ 自动转换，**不用再写 `import React`**。web、ui、renderer、tui、debug 面板使用          |
| `allowJs` | `true`                 | 允许把`.js` 文件纳入编译/检查（默认只认 `.ts/.tsx`）。shared 包有历史 JS 工具文件，故开启                                                                        |
| `paths`   | `{"@/*": ["./src/*"]}` | **路径别名**：`import x from '@/hooks/useX'` 等价于 `./src/hooks/useX`，省去 `../../..`。只影响 TS 解析，Vite 侧需配等价别名（两边要同步）。仅 ui 包使用 |

`lib` 在基座里是 `["es2024"]`，各包按运行环境覆盖，三种典型组合：

- **纯 Node**（services、provider-node、desktop main/host/scheduler）：只有 `es2025`，不加 DOM——主进程里本来就没有 `window`，加上反而会掩盖误用；
- **浏览器/渲染端**（web、ui、renderer、client、formal-proof）：`es2025`/`es2024` + `dom` + `dom.iterable`。`dom.iterable` 让 `document.querySelectorAll()` 的结果能 `for...of`；
- **同构库**（rpc、provider、zcode-server-cli）：ES 标准库 + DOM 都给，因为同一份代码两端都可能跑。

#### D. 严格检查与编码规则

| 选项                                 | 小白解释                                                                                                                                                                                                                     | 典型报错场景                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `strict`                           | **一键开启全部严格检查**的总开关：`noImplicitAny`（参数不标类型且推断不出时报错）、`strictNullChecks`（`null/undefined` 不能直接当字符串用）等。基座没统一开，provider、rpc 及 apps/zcode-cli 下大多数包自行开启 | 函数参数忘了类型 → 隐式 any 报错          |
| `forceConsistentCasingInFileNames` | import 路径大小写必须和磁盘文件名**完全一致**。Windows/macOS 文件系统不区分大小写，Linux 区分——不打开会出现「本地能跑、CI 找不到模块」                                                                               | `import './Utils'` 而文件叫 `utils.ts` |
| `noFallthroughCasesInSwitch`       | `switch` 的 `case` 漏写 `break` 贯穿到下一个分支时报错                                                                                                                                                                 | 漏 break 导致多个 case 连续执行            |
| `noImplicitOverride`               | 子类重写父类方法必须写`override` 关键字；父类方法日后改名，子类会立刻报错而不是悄悄变成「新增方法」                                                                                                                        | —                                         |
| `allowSyntheticDefaultImports`     | 只在**类型层面**允许 `import x from 'pkg'`（即使对方没有默认导出）；真正生成互操作代码的是 `esModuleInterop`，两者常一起出现                                                                                       | —                                         |

#### E. 为什么 apps/zcode-cli 下的包把选项重写一遍

主 workspace 的包都 `extends` 基座；但 `apps/zcode-cli` 是一个**嵌套 workspace**（自己有 packages、tools），它下面 18 份配置**不继承根基座**，而是把 `module: NodeNext`、`esModuleInterop`、`strict`、`skipLibCheck` 等选项各自写全。所以你会在这些文件里看到基座选项的「副本」——不是重复劳动，而是嵌套 workspace 刻意保持独立、可单独发行。

### 2.2 全仓库 38 份 tsconfig 角色总览

下表是仓库里**每一份** tsconfig 的角色与标志性设置（38 = 基座 1 + 主 workspace 13 + desktop 6 + 嵌套 workspace 18）。

**基座（1）**

| 文件                   | 角色                                        | 标志性设置                                                         |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `tsconfig.base.json` | 全仓库公共基座，被主 workspace 各包 extends | ES2024、NodeNext、composite、noUncheckedIndexedAccess，未开 strict |

**主 workspace packages/（13）**

| 文件                                    | 角色                             | 继承基座     | 标志性设置                                                                          |
| --------------------------------------- | -------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| `packages/zcode-server-cli`           | 服务端 CLI 启动器                | 是           | `lib: [ES2022, DOM]`、types node；引用 shared/rpc/services                        |
| `packages/web`                        | 浏览器 Web 客户端（Vite）        | 是           | DOM 类型、jsx、`noEmit`；引用 ui/client                                           |
| `packages/ui`                         | 共享 React 组件/hooks/store      | 是           | jsx、`paths @/*→src/*`、显式 glob include；引用 provider/shared/services/rpc     |
| `packages/shared`                     | 跨端协议与类型                   | 是           | types node、`allowJs`                                                             |
| `packages/services`                   | 业务服务与持久化（Node）         | 是           | ES2025、types node；引用 shared/rpc                                                 |
| `packages/server/tsconfig.json`       | 后端服务的日常检查配置           | 是           | `lib: ES2022`；引用 shared/services/client/rpc                                    |
| `packages/server/tsconfig.build.json` | 后端服务的**发版构建**配置 | **否** | 独立写全选项，ES2022，供构建脚本`-p` 指定                                         |
| `packages/rpc`                        | 跨端 RPC 框架（同构）            | **否** | ES2022 +`moduleResolution: bundler`、strict、composite、lib 含 DOM                |
| `packages/provider`                   | 模型供应商抽象层                 | 是           | `lib: [ES2025, DOM]`、strict                                                      |
| `packages/provider-node`              | provider 的 Node 实现            | 是           | ES2025、strict、types node，**不含 DOM**                                      |
| `packages/formal-proof`               | 形式化证明前端页（Vite）         | 是           | `moduleResolution: Bundler`、types vite/client、noEmit，include 含 vite.config.ts |
| `packages/model-option-map`           | 模型选项映射数据                 | 是           | 仅 ES2025 覆盖                                                                      |
| `packages/client`                     | Agent 客户端 SDK（同构）         | 是           | ES2025 + DOM；引用 services/rpc                                                     |

**desktop 桌面端（6）**

| 文件                               | 角色                           | 标志性设置                                             |
| ---------------------------------- | ------------------------------ | ------------------------------------------------------ |
| `packages/desktop/tsconfig.json` | 解决方案入口，不编译源码       | `files: []`，聚合 5 个子工程引用                     |
| `tsconfig.main.json`             | Electron 主进程（纯 Node）     | `outDir: out/main`，无 DOM；引用 shared/services     |
| `tsconfig.host.json`             | Local Host 宿主进程（纯 Node） | `outDir: out/host`；引用 shared/services/rpc         |
| `tsconfig.scheduler.json`        | 子进程调度器                   | `types: [node, electron]`                            |
| `tsconfig.preload.json`          | 预加载安全桥                   | `rootDir: src`（含 src/shared 桥接文件）、lib 含 DOM |
| `tsconfig.renderer.json`         | React 渲染进程（Chromium）     | jsx、DOM、`noEmit`；引用 shared/ui/client            |

**apps/zcode-cli 嵌套 workspace（18，均不继承基座）**

| 文件                                    | 角色                       | 标志性设置                                                                          |
| --------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `tools/typescript`                    | 内置 TS 工具目录的选项载体 | 选项最全：ES2024 + strict + override/fallthrough 等；`include: ["tsconfig.json"]` |
| `tools/prompt-trajectory`             | 提示词轨迹脚本             | `noEmit`，运行时直接执行 TS                                                       |
| `packages/tui`                        | 终端 UI（React JSX）       | jsx react-jsx，产出 dist                                                            |
| `packages/telemetry`                  | 遥测上报                   | 标准 Node 库包模板                                                                  |
| `packages/swift-bridge`               | Swift 原生能力桥接         | 标准 Node 库包模板                                                                  |
| `packages/shared-types`               | 共享纯类型                 | `emitDeclarationOnly` → dist-types                                               |
| `packages/node-repl-host`             | Node REPL 宿主             | 标准模板 + exclude dist                                                             |
| `packages/i18n`                       | 国际化资源                 | ES2022 + noUncheckedIndexedAccess（防缺翻译）                                       |
| `packages/dynamic-workflow`           | 动态工作流定义             | ES2022 + noUncheckedIndexedAccess                                                   |
| `packages/dynamic-workflow-runtime`   | 工作流运行时执行器         | 同上，与定义侧基线对齐                                                              |
| `packages/debug/tsconfig.json`        | 调试面板（浏览器/Vite）    | DOM + Bundler + jsx + noEmit + types vite/client                                    |
| `packages/debug/tsconfig.server.json` | 调试面板的服务端           | `declaration: false`、`noEmit: false`、outDir dist-server、rootDir `.`        |
| `packages/core`                       | 核心 agent loop/会话       | 标准模板 + 排除`**/*.test.ts`                                                     |
| `packages/contracts`                  | 模块契约/schema            | `emitDeclarationOnly` → dist-types                                               |
| `packages/cli`                        | zcode 命令入口             | 最小配置（无 outDir/rootDir/declaration）                                           |
| `packages/browser-use-plugin`         | 浏览器自动化插件           | `emitDeclarationOnly` → dist-types                                               |
| `packages/bootstrap`                  | 启动装配层                 | 标准 Node 库包模板                                                                  |
| `packages/adapters`                   | 外部 I/O 适配器            | 标准 Node 库包模板                                                                  |

> 💡 **读配置的快捷方法**：先看有没有 `extends`（继承基座还是独立写全）→ 看 `lib`/`types`/`jsx`/`noEmit` 判断它跑在 Node 还是浏览器、谁负责打包 → 看 `outDir` + `emitDeclarationOnly` 判断产物形态 → 看 `references` 判断它依赖哪些兄弟包。

---

## 3. monorepo：一个仓库，多个包

本仓库不是「一个项目」，而是 **30+ 个包组成的 monorepo**（一个仓库管理多个可独立构建的包）。

**pnpm workspace** 是粘合剂。根目录的 `pnpm-workspace.yaml` 声明了哪些目录是包：

```yaml
packages:
  - packages/*                # 主 workspace 的 14 个包
  - apps/zcode-cli            # 嵌套 workspace 本身
  - apps/zcode-cli/packages/* # 嵌套 workspace 里的 16 个子包
  - apps/zcode-cli/tools/*
```

包和包之间怎么依赖？看任何一个包的 `package.json`，依赖版本写成 `workspace:*`：

```jsonc
// packages/client/package.json
"dependencies": {
  "@zcode/rpc": "workspace:*",       // ← 不是从 npm 下载！直接链接到本仓库的 packages/rpc
  "@zcode/services": "workspace:*",
  "@zcode/shared": "workspace:*"
}
```

> 💡 **TS 知识点：`workspace:*` 与类型从哪来**
> `workspace:*` 表示「链接到 workspace 里的本地包」。你改了 `packages/shared` 的类型，引用它的包**立刻**感知到——因为第 2 节的 `declaration: true` 会生成最新 `.d.ts`，`pnpm typecheck` 时按依赖顺序逐包重查。这就是为什么改共享包后要跑一次全量 typecheck。

---

## 4. import / export 与 `import type`

模块系统基础（ESM 语法）：

```ts
// utils.ts —— 导出
export function formatSize(n: number): string { ... }  // 具名导出
export default class Foo { ... }                        // 默认导出（每文件至多一个）

// app.ts —— 导入
import Foo, { formatSize } from "./utils.js";  // 默认导出 + 具名导出
```

本仓库因为开了 `verbatimModuleSyntax`，**类型导入必须显式写 `import type`**：

```ts
// packages/client/src/websocket.ts 的真实开头（节选）
import {
  Emitter,            // ← 这些是「值」：运行时真实存在的函数/类
  VSBuffer,
  ChannelClient,
  type IMessagePassingProtocol,  // ← 行内标注：只导入类型
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";  // ← 整句只导入类型
```

> 💡 **TS 知识点：为什么强制 `import type`**
> 类型编译后会消失，但值不会。如果不区分，编译器有时无法判断该删除还是保留这条 import（尤其在 `isolatedModules` 的单文件编译模式下）。`import type` 一锤定音：**这条导入编译后一定被删掉**，还能防止「只为拿类型却意外引入运行时依赖」——这对本仓库严守的模块边界很重要。

---

## 5. interface、type 与泛型一瞥

**`interface` 和 `type`** 都能描述对象形状，本仓库两者都用。新手只需记住：描述「对象长什么样」用哪个都行，联合类型等高级用法只能用 `type`：

```ts
interface WebSocketConnectionOptions {      // 描述对象形状
  onClose?: (event: CloseEvent) => void;    // ? 表示可选字段
  onOpenSocket?: (socket: WebSocket) => void;
}
type Id = string | number;                  // 联合类型：只能是其中之一
```

**泛型**是「类型的参数」。看本仓库的真实例子（`apps/zcode-cli/packages/core/src/runtime.ts`）：

```ts
export interface RuntimeFactory {
  create(config: AgentRuntimeConfig): Promise<AgentRuntime>;
  //                ↑ 参数有类型                          ↑ 返回值也有类型
}
```

`Promise<AgentRuntime>` 就是泛型：`Promise` 像「未来才到的快递盒」，尖括号里声明盒子里装的是什么类型。`await` 之后你拿到的就是 `AgentRuntime` 类型的值，IDE 能自动补全它的所有方法。

> 💡 **TS 知识点：`type` 导入也遵循第 4 节规则**
> 同一个文件里 `runtime.ts` 既有 `export { AgentRuntime }`（值）又有 `export type { ... }`（纯类型清单）——导出侧同样要区分，和 `import type` 呼应。打开 `packages/client/src/index.ts`、`apps/zcode-cli/packages/core/src/runtime.ts` 都能看到这种「值和类型分开导出」的风格，读代码时把它当成背景音即可。

---

## 6. zod：类型骗不了运行时

第 1 节说过：TS 类型编译后消失。而本仓库是一个 **AI Agent 工作台**，进程之间充斥着网络消息：WebSocket 帧、stdio 协议、模型返回的 JSON……这些数据在运行时到达，**结构对不对没人保证**。

[zod](https://zod.dev) 一次定义，两头受益。先看补全了 import 的完整代码：

```ts
import { z } from "zod";  // z 是 zod 导出的「总入口对象」，所有 API 都挂在它身上

// ① 定义 schema：一个【运行时真实存在】的校验器对象（编译后不会被删掉）
const UserMessage = z.object({
  role: z.enum(["user", "assistant"]),  // 只能是这两个字符串之一
  content: z.string(),                  // 必须是字符串
});

// ② 从 schema 反推出 TS 类型（纯编译期操作，零运行时成本）
type UserMessage = z.infer<typeof UserMessage>;
// 等价于手写：type UserMessage = { role: "user" | "assistant"; content: string }

// ③ 运行时校验：数据不合法直接抛错，合法则返回类型精确的数据
const msg = UserMessage.parse(someJson);  // msg 自动就是 UserMessage 类型
```

这段代码的精髓是**值和类型同源**，同一个名字 `UserMessage` 其实活在两个世界：

- `const UserMessage` 是**值**：一个带 `.parse()` 方法的校验器对象，负责运行时把关，编译后仍然存在；
- `type UserMessage` 是**类型**：不是手写的，而是从上面的值**推导**出来的，编译后消失——但它永远和校验逻辑一致，因为它们出自同一个定义。

`z.infer<typeof UserMessage>` 拆开是两步推导：

1. `typeof UserMessage`——TS 的**类型查询**：把「值」变成「值的类型」。它和 JS 运行时那个返回 `"object"` 字符串的 `typeof` 只是重名，这里发生在编译期，取到的是 `z.object({...})` 返回对象的类型（zod 造每个 schema 时，都把这个 schema 会产出什么形状记在了类型里）；
2. `z.infer<...>`——zod 提供的**类型工具**：从 schema 的类型里把「校验通过后的输出形状」提取出来（概念上等于读取 schema 类型内部记录的输出字段）。

数据流向是「**值 → 类型**」：先有校验器这个值，才谈得上从它推导类型，所以必须先写 `const` 再写 `type`。另外 `const UserMessage` 和 `type UserMessage` 同名不冲突——TS 里值和类型分属两个命名空间（`class Foo` 也同时声明了一个值和一个类型），这是 zod 官方推荐的同名惯用法。

> 💡 **TS 知识点：为什么 `.parse()` 是「两头受益」的关键**
> 网络来的 `someJson` 类型是 any，编译器对它一无所知。对它调用 `.parse()` 之后，你同时得到：**运行时**——一个保证合法的对象（不合法抛 ZodError，脏数据进不来）；**编译期**——返回值的类型就是 `UserMessage`，后面写 `msg.content` 有补全，写 `msg.nmae` 直接报错。第 1 节说的「类型骗不了运行时」在这里闭环：不是类型保护了运行时，而是运行时校验**喂给**了类型系统一个可信的值。

### 同名两界：`UserMessage.parse()` 里用的是值还是类型？

答案：**值**。`.parse()` 是运行时的方法调用，只有真实存在的对象才有方法——这里用的是 `const UserMessage`（schema 校验器对象）。类型 `type UserMessage` 编译后就消失了，不可能有 `.parse` 方法。

TS 区分同名标识符靠的是**书写位置**，不看名字——同一个名字在「值世界」和「类型世界」各有一份，取哪份由位置决定：

| 位置 | 取哪份 | 例子 |
| --- | --- | --- |
| 能放「代码」的地方：`.` 调方法、`=` 右边、传参、`new` | 值 | `UserMessage.parse(x)` |
| `:` 冒号后面（标注类型） | 类型 | `const msg: UserMessage = ...` |
| 泛型尖括号里 | 类型 | `Promise<UserMessage>` |
| `type X =` 的右边 | 类型 | `type Inbox = UserMessage[]` |

一个特殊位置：`z.infer<typeof UserMessage>` 里的 `UserMessage` 写在 `typeof` 后面——`typeof` 的职责就是「把值的类型取出来」，所以它引用的还是**值**。

> 💡 **TS 知识点：TS2693 是「用错了世界」的信号**
> 把类型名写在值的位置，TS 报 `TS2693: 'UserMessage' only refers to a type, but is being used as a value here.`——多半是你只 `import type` 拿了类型、没 import 真正的 schema 值。`class Foo` 也是同一套机制：`new Foo()` 用值，`x: Foo` 用类型。

**那 `type UserMessage = z.infer<...>` 这行是必须的吗？** 单看上面三行 demo，删掉它代码照样工作——`msg` 的精确类型来自 `.parse()` 的返回值类型（zod 内部用同一套 infer 机制算出来的），demo 里保留它是为了展示「同名两界」这个惯用法。这行的真正价值是**给推导结果起名字**，让类型能被别处引用：

```ts
function render(msg: UserMessage) { ... }  // 函数参数需要类型名
type Inbox = UserMessage[];                // 组合成新类型
```

shared 包里全是 `export type BackgroundBashOutput = z.infer<typeof backgroundBashOutputSchema>` 这种写法——schema 管运行时校验，同名的 `export type` 把编译期类型发给全仓库。反过来，定义了却没有任何地方引用的类型别名是死代码，可以删。

本仓库的用法（都已在 `package.json` 里确认）：

- 主 workspace 统一用 **zod 4.6.5**：`packages/shared`（200+ 个协议/类型文件基本都有对应 schema）、`packages/provider`、`packages/services`
- 嵌套 workspace 的 `apps/zcode-cli/packages/contracts` 用 **zod 3** + `zod-to-json-schema`（需要把 schema 转成 JSON Schema 供工具声明使用）

> 💡 **TS 知识点：为什么两个 zod 版本并存**
> monorepo 的不同区域可以依赖不同版本——pnpm 按包隔离依赖，互不冲突。读代码时注意：`packages/shared` 里的 schema 是 zod 4 风格，`contracts` 里是 zod 3 风格，API 略有差异（如错误处理），别混着抄。

---

## 7. 报错了怎么办：typecheck 与 lint

本仓库的日常验证三件套（根目录执行）：

| 命令               | 干什么                                                  | 输出怎么读                                                                                                                                          |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` | `tsc -b` 按依赖顺序逐包做类型检查（增量，只查改过的） | `packages/ui/src/Foo.tsx(42,7): error TS2339: Property 'nmae' does not exist...` —— 文件(行,列) + 错误码 + 描述，直接点报错里的文件路径跳过去改 |
| `pnpm lint`      | oxlint 做代码规范检查（Rust 写的，极快）                | 同样是 文件(行,列) + 规则名                                                                                                                         |
| `pnpm fmt:check` | oxfmt 检查格式是否统一                                  | 不通过就跑`pnpm fmt` 自动修                                                                                                                       |

> 💡 **TS 知识点：错误码是检索工具**
> `TS2339`、`TS2307` 这类错误码直接拿去搜索，能找到官方文档和大量案例。常见三巨头：`TS2307`（找不到模块——九成是 import 路径少写了 `.js`）、`TS2339`（属性不存在——拼写或类型不对）、`TS2532`（对象可能是 undefined——`noUncheckedIndexedAccess` 在保护你）。

### 🔧 动手环节

1. 打开 `packages/shared/src/version.ts`（或任一简短文件），故意把一个函数的返回类型改成错的，比如 `: string` 改成 `: numbr`。
2. 根目录跑 `pnpm typecheck`，观察报错格式，找到「文件(行,列)」三要素。
3. 改回来，确认 `pnpm typecheck` 恢复通过。
4. 再试一次 `pnpm lint`，感受 lint 和 typecheck 的关注点差异。

---

**下一章**：[02 · 技术栈清单](./02-tech-stack.md) —— 这个项目到底用了哪些轮子，每个轮子装在哪。
