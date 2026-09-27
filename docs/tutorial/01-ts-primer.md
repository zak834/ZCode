# 01 · TypeScript 预备章

> 本章你将学到：TypeScript 和 JavaScript 的关系；`tsconfig.json` 在 TS 里起什么作用、本仓库 `tsconfig.base.json` 每个选项是什么意思；monorepo 里包和包怎么互相引用；以及本项目代码里最高频的几个 TS 概念——`import type`、interface、泛型、zod。
>
> 所有例子都来自本仓库的真实代码，读完你就能无障碍开始读项目源码。

---

## 1. TypeScript 是什么

一句话：**TypeScript = JavaScript + 类型标注**。它不是新语言，而是 JS 的「超集」——所有合法 JS 都是合法 TS。你写的 TS 代码经过编译（type check + 转译）后，最终运行的仍然是 JS。

为什么大项目都用 TS？JS 的变量类型只有运行时才知道，`user.nmae`（拼写错了）要等用户报障才发现；TS 在**你保存文件的那一刻**就告诉你 `nmae` 不存在于 `User` 类型上。仓库越大，这笔投资回报越高。

> 💡 **TS 知识点：类型只活在编译期**
> TS 的类型在编译成 JS 后**完全消失**。运行时没有 `User` 这个类型，只有真实的对象。这带来一个重要推论：**来自网络、磁盘、用户输入的数据，运行时无法自动获得类型保护**——这正是本仓库大量使用 zod 的原因（见第 6 节）。

---

## 2. 本仓库的 tsconfig.base.json 逐项解读

### tsconfig.json 在 TypeScript 中的作用

每个 TypeScript 项目都有一个 `tsconfig.json`——它是 TypeScript 编译器 `tsc` 的配置文件，告诉编译器「检查哪些文件、按什么规则检查和编译」。`tsc` 的所有行为都由它驱动，它回答三个问题：

| 问题 | 由哪些字段回答 |
| --- | --- |
| **编译哪些文件？** | `include`（收编哪些目录/文件）、`exclude`（排除谁）、`files`（逐个点名） |
| **怎么编译？** | `compilerOptions`——下方表格里的所有开关都住在它里面 |
| **怎么复用与组合？** | `extends`（继承另一份配置）、`references`（项目引用，配合 `composite`） |

四个新手容易踩的点：

1. **tsc 怎么找到它**：直接运行 `tsc`（不带文件参数）时，编译器从当前目录**逐级向上**找最近的 `tsconfig.json`，找到就按它执行，找不到就报错。所以「在哪个目录跑命令」会影响结果。本仓库的 `pnpm typecheck` 用 `tsc -b` 显式按项目引用构建，不依赖这个向上查找。
2. **它是 JSONC，不是严格 JSON**：tsconfig 允许 `//` 注释和尾逗号，严格 JSON 不允许。`tsconfig.base.json` 里能写逐行中文注释（用 IDE 打开就能看到），正是靠这个特性。
3. **它同时驱动 IDE**：VS Code 里的红色波浪线、自动补全、跳转到定义，背后就是按 tsconfig 配置在跑的 tsc 语言服务。改了 tsconfig 后 IDE 没反应，用命令面板执行「TypeScript: Restart TS Server」。
4. **没有它会怎样**：tsc 仍能编译你显式指定的文件，但全部用默认值（`target` 退回 ES5、没有严格检查），IDE 也不知道你的项目边界在哪，提示会失真。所以每个 TS 项目都以它为起点。

monorepo 只有一份 tsconfig 不够：30+ 个包要各自指定 `include` 和产物目录，但编译规则又必须完全一致。于是把公共部分抽成一个基础文件，各包 `extends` 它、只写自己的差异。本仓库的基础文件就是 `tsconfig.base.json`（文件里已附逐行中文注释，可对照下表阅读）：

🔍 `tsconfig.base.json`

| 选项 | 值 | 小白解释 |
| --- | --- | --- |
| `target` | `es2024` | 编译产物按 ES2024 标准输出。Node 24 足够新，所以可以用最现代的 JS 语法，不用老掉牙的转译 |
| `lib` | `es2024` | 允许使用的全局 API 类型（`Promise`、`Map`、`structuredClone` 等）按 ES2024 提供 |
| `module` / `moduleResolution` | `nodenext` | 按Node.js 官方 ESM 规则处理模块。**对本仓库影响最大的一条**，见下方卡片 |
| `declaration` + `declarationMap` | `true` | 编译时生成 `.d.ts` 类型声明文件。**monorepo 的关键**：包 A 引用包 B 时，B 的类型就来自这些 `.d.ts` |
| `composite` | `true` | 启用「项目引用（project references）」。根目录 `pnpm typecheck` 用的 `tsc -b`（build 模式）要求它，还能增量缓存、只重查改过的包 |
| `esModuleInterop` | `true` | 让 ESM 的 `import` 和老式 CommonJS 的 `require` 互操作更顺手 |
| `resolveJsonModule` | `true` | 允许 `import data from "./x.json"` |
| `skipLibCheck` | `true` | 不检查第三方库内部的类型错误（只查你自己的代码，加速编译） |
| `verbatimModuleSyntax` | `true` | **强制你区分「导入值」还是「导入类型」**（见第 4 节） |
| `isolatedModules` | `true` | 每个文件必须能被单独编译。esbuild/tsup 这类快速打包器是逐文件处理的，这条保证它们不出错 |
| `noUncheckedIndexedAccess` | `true` | 最严格的防越界开关：`arr[i]` 的类型是 `T \| undefined` 而不是 `T`，逼你处理「索引可能不存在」 |

> 💡 **TS 知识点：为什么本仓库的 import 都带 `.js` 后缀**
> 在 `nodenext` 模式下，相对导入必须写完整文件名，而且**写 `.js` 而不是 `.ts`**：
>
> ```ts
> // ✅ 本仓库的写法（源文件是 runtime.ts，却导入 runtime.js）
> import { AgentRuntime } from "./runtime/agent-runtime.js";
> ```
> 因为编译后 `runtime.ts` 会变成 `runtime.js`，Node 直接运行编译产物时按你写的路径找文件——写 `.ts` 运行时就找不到了。

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

[zod](https://zod.dev) 一次定义，两头受益：

```ts
const UserMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
type UserMessage = z.infer<typeof UserMessage>;  // ← 自动推导出 TS 类型！
UserMessage.parse(someJson);                     // ← 运行时真实校验，不对就抛错
```

本仓库的用法（都已在 `package.json` 里确认）：

- 主 workspace 统一用 **zod 4.6.5**：`packages/shared`（200+ 个协议/类型文件基本都有对应 schema）、`packages/provider`、`packages/services`
- 嵌套 workspace 的 `apps/zcode-cli/packages/contracts` 用 **zod 3** + `zod-to-json-schema`（需要把 schema 转成 JSON Schema 供工具声明使用）

> 💡 **TS 知识点：为什么两个 zod 版本并存**
> monorepo 的不同区域可以依赖不同版本——pnpm 按包隔离依赖，互不冲突。读代码时注意：`packages/shared` 里的 schema 是 zod 4 风格，`contracts` 里是 zod 3 风格，API 略有差异（如错误处理），别混着抄。

---

## 7. 报错了怎么办：typecheck 与 lint

本仓库的日常验证三件套（根目录执行）：

| 命令 | 干什么 | 输出怎么读 |
| --- | --- | --- |
| `pnpm typecheck` | `tsc -b` 按依赖顺序逐包做类型检查（增量，只查改过的） | `packages/ui/src/Foo.tsx(42,7): error TS2339: Property 'nmae' does not exist...` —— 文件(行,列) + 错误码 + 描述，直接点报错里的文件路径跳过去改 |
| `pnpm lint` | oxlint 做代码规范检查（Rust 写的，极快） | 同样是 文件(行,列) + 规则名 |
| `pnpm fmt:check` | oxfmt 检查格式是否统一 | 不通过就跑 `pnpm fmt` 自动修 |

> 💡 **TS 知识点：错误码是检索工具**
> `TS2339`、`TS2307` 这类错误码直接拿去搜索，能找到官方文档和大量案例。常见三巨头：`TS2307`（找不到模块——九成是 import 路径少写了 `.js`）、`TS2339`（属性不存在——拼写或类型不对）、`TS2532`（对象可能是 undefined——`noUncheckedIndexedAccess` 在保护你）。

### 🔧 动手环节

1. 打开 `packages/shared/src/version.ts`（或任一简短文件），故意把一个函数的返回类型改成错的，比如 `: string` 改成 `: numbr`。
2. 根目录跑 `pnpm typecheck`，观察报错格式，找到「文件(行,列)」三要素。
3. 改回来，确认 `pnpm typecheck` 恢复通过。
4. 再试一次 `pnpm lint`，感受 lint 和 typecheck 的关注点差异。

---

**下一章**：[02 · 技术栈清单](./02-tech-stack.md) —— 这个项目到底用了哪些轮子，每个轮子装在哪。
