# 06 · UI 与状态管理

> 本章你将学到：`packages/ui` 的三层结构（store / hooks / 组件）；Zustand store 在真实业务代码里的样子；服务如何通过 React Context 进入组件；以及本仓库最重要的一条 UI 铁律——**UI 不是状态的权威**。
>
> 前置知识：[05 章](./05-agent-core.md) 结尾的「事件投影」概念。`packages/ui` 有 42 个 store 文件和 98 个 hooks，本章带你读透两个代表，剩下的都能举一反三。

---

## 0. ui 包在全局的位置

回顾 [03 章](./03-repo-map.md)：`packages/ui` 被 **desktop renderer** 和 **web** 同时复用——两个平台同一套界面。它能做到这一点，靠的是两条仓库铁律（`AGENTS.md`）：

1. 组件**通过 hooks 访问服务**，不直接拿平台对象；
2. 平台差异走 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调 `window.zcode`。

于是「这份代码跑在 Electron 还是浏览器」的判断被压到最底层，上面的 42 个 store、98 个 hooks、几百个组件对此无感。

## 1. 三层心智模型

```text
组件（视图）      "长什么样"           packages/ui/src/*.tsx
   │ 数据下钻、事件上抛
hooks（行为）     "怎么拿数据/做事"     packages/ui/src/hooks/    ← UI 访问服务的唯一通道
   │ 调用
store（状态）     "记得什么"           packages/ui/src/store/    ← Zustand 全局状态
```

分工可以粗暴记成：**store 管「记得」，hooks 管「去做」，组件管「显示」**。

## 2. store：一个领域一个 Zustand store

🔍 `packages/ui/src/store/`（42 个文件）

命名就是领域清单：`mcpStore.ts`、`skillStore.ts`、`pluginStore.ts`、`tabStore.ts`、`subagentsStore.ts`……大领域再拆 slice（`zcodeSessionStoreTaskSlice.ts`、`zcodeSessionStoreWorkspaceSlice.ts`）。

精读一个最小的真实 store——确认对话框 `store/confirmDialogStore.ts`（62 行，全文如下逻辑）：

```ts
export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  pendingRequest: undefined,
  requestChoice: (payload) => {
    if (get().pendingRequest) {           // 已有弹窗在等待 → 防重入
      logger.warn("[ConfirmDialogStore] confirmation already in progress");
      return Promise.resolve("dismiss");
    }
    return new Promise<ConfirmDialogChoice>((resolve) => {
      set({ pendingRequest: { ...payload, resolve } });   // 把 resolve 存进状态！
    });
  },
  settleChoice: (choice) => {
    const pendingRequest = get().pendingRequest;
    if (!pendingRequest) return;
    set({ pendingRequest: undefined });   // 先清状态
    pendingRequest.resolve(choice);       // 再兑现当初的 Promise
  },
}));
```

三个值得咀嚼的点：

1. **`create<ConfirmDialogState>((set, get) => ...)`**：泛型参数是状态接口的完整契约——字段 + 方法都声明在内，组件用 `useConfirmDialogStore()` 订阅，选择器取切片（如 `zcodeSessionStoreSelectors.ts` 专门放选择器）。
2. **又是 Deferred 模式**：业务代码 `const ok = await requestConfirmation({...})` 拿到 Promise；用户点按钮后 `settleChoice` 才兑现它。和 [05 章](./05-agent-core.md) 命令队列的 `resolve/reject` 是同一个思想——**「把未来交给状态保管」**。
3. 日志用 `logger`（`packages/ui/src/logger.ts` 的封装），不直接 `console.log`——AGENTS.md 的日志约定。

> 💡 **TS 知识点：`Extract<T, U>`——从联合类型里「提取」子集**
> `hooks/useGitRepository.ts` 里有这么一行：
>
> ```ts
> type GitRepositorySourceId = Extract<GitChangeSourceId, "unstaged" | "staged" | "branch">;
> ```
> `GitChangeSourceId` 是一个大联合类型（Git 面板的全部数据来源），`Extract` 从中**只留下**指定的三个成员。共享协议层（`@zcode/shared`）定义大而全的联合，消费方用 `Extract`/`Exclude` 裁剪出自己关心的子集——协议不用为每个界面开小灶，这是联合类型规模化的关键技巧。

## 3. hooks：行为层与服务访问

🔍 `packages/ui/src/hooks/`（98 个文件，全部 `useXxx` 命名）

### 3.1 服务的入口：useServices

🔍 `packages/ui/src/hooks/useServices.tsx` —— 全文 32 行，就干一件事：

```tsx
const ServiceContext = createContext<IServiceAccessor | null>(null);

export function useServices(): IServiceAccessor {
  const ctx = useContext(ServiceContext);
  if (!ctx) throw new Error("useServices 必须在 ServiceProvider 内使用");
  return ctx;
}
```

`ServiceProvider` 在应用根部把 `IServiceAccessor`（来自 `@zcode/services`，经 [04 章](./04-rpc-framework.md) 的 RPC 连到真正实现）放进 React Context，之后任何组件 `useServices()` 即取即用——头注释原话：「替代 props drilling」。

> 💡 **TS 知识点：`.ts` 还是 `.tsx`？**
> 我写本章时真的踩了个坑：按文件名去读 `useServices.ts`，结果文件不存在——它叫 `useServices.tsx`。规则来自 AGENTS.md：**hooks 里只要含 JSX（`<ServiceProvider>` 这样的标签），文件就必须用 `.tsx`**。反过来纯逻辑 hooks（如 `useGitAutoRefresh.ts`）保持 `.ts`。看到 `.tsx` 的 hook，八成它返回了组件或渲染了东西。

### 3.2 一个业务 hook 的真实长相

🔍 `packages/ui/src/hooks/useGitRepository.ts`（Git 面板数据）

它的开头就浓缩了本仓库的多个核心约定，值得逐行品味：

- 类型全部来自 `@zcode/shared`（`GitFileChange`、`GitDiffResult`…）——UI 不自定义协议类型，[01 章](./01-ts-primer.md) 说的「shared 是宪法」在这里兑现
- `workspaceKey` 贯穿始终——对应 AGENTS.md 的身份铁律：**身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`**，远程工作区绝不按路径匹配
- `shouldEnableWorkspaceRpc()`（`lib/workspaceRpcAvailability.js` 导入）：本地/远程工作区走不同的数据链路，但 hook 的输出形状一致——平台差异在 hook 内部消化

### 3.3 hooks 与 store 的配合

典型分工：hook 负责把「服务事件」翻译成「store 更新」。例如会话事件流（[05 章](./05-agent-core.md) 的 `SessionEventSink` 发出）由会话相关 hooks 接住，写入 `zcodeSessionStore`；组件只订阅 store。于是**事件→状态→视图**是单向流，出问题好排查。

## 4. 铁律：UI 不是状态的权威

AGENTS.md 反复强调的几条，落到 ui 包就是：

- 「Zustand 状态位于 `packages/ui/src/store/`」——store 是 UI 侧唯一的全局状态家，组件局部 `useState` 只放真正的临时 UI 状态（输入框草稿、悬浮态）
- 「UI 局部状态不应被误当作服务端事实」——会话进行到哪个相位（[05 章](./05-agent-core.md) 的 `TurnPhase`）、权限批了没有，**权威在 Agent 侧状态机**；store 里存的只是「最近一次事件投影出的视图」。断线重连后以服务端快照为准
- 「广播同步的主题、语言等字段需要防止回环」——设置项在多窗口间同步时，自己发出的更新不能再触发自己保存一遍（否则死循环），同步字段带来源标记
- 审批弹窗（`confirmDialogStore`）、错误横幅（`ChatErrorBanner.tsx`）都只是「等待中的视图」——决定权在别处

## 5. 样式约定（一分钟版）

全仓库 Tailwind CSS v4，视觉 token 定义在 `DESIGN.md`。最硬的一条：**应用 UI 字体必须用 `text-ui-*` 系列 token**（`text-ui-xl/lg/base/caption/sm/xs`），禁止 Tailwind 内置 `text-base/sm/xs`、任意 `text-[13px]` 或内联 font-size——违规按「设计系统缺陷」处理，不是风格偏好。写 UI 前把 `DESIGN.md` 的颜色 token 一节过一遍（`--color-brand`、`--color-card`、`--color-popover`…）。

---

## 6. 动手环节

1. 跑 `pnpm dev:web`，打开浏览器 DevTools，触发一次确认对话框（如删除任务），对照 `confirmDialogStore.ts` 观察 `pendingRequest` 的生命周期。
2. 打开 `packages/ui/src/store/index.ts`，数一数导出了多少 store；挑一个你感兴趣的（推荐 `mcpStore.ts`），只读它的 state 接口定义，猜每个字段对应界面上的什么。
3. 进阶：找一个 `hooks/` 里的 `.tsx` 文件和一个 `.ts` 文件，验证第 3.1 节的规则。

---

**下一章**：[07 · 协议与插件系统](./07-protocol-plugins.md) —— 把前六章串成闭环：ZCode Protocol v4 的消息长什么样、MCP 如何给 Agent 接工具、插件市场如何分发能力。
