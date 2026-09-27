/**
 * Layer 0: 基础设施
 * - IDisposable / DisposableStore: 资源生命周期管理
 * - Event / Emitter: 事件系统
 * - CancellationToken: 取消令牌
 *
 * 这些是整个 IPC 框架的地基，所有上层模块都依赖它们。
 */

// ============================================================================
// Disposable - 资源释放模式
// ============================================================================

// ── IDisposable：统一的资源释放接口 ──
// TS 语法：interface（接口）描述"一个对象必须具备哪些方法/字段"，
// 它只存在于编译期，编译成 JS 后就消失，不会产生任何运行时代码。
// 本框架约定：凡是持有需要清理的资源（连接、定时器、事件订阅）的对象，
// 都必须实现 dispose()——用完必须调用，否则就资源泄漏。
export interface IDisposable {
  dispose(): void;
}

// 工厂函数：把任意"清理逻辑函数"包装成标准的 IDisposable 对象。
// 为什么不直接到处传裸函数？因为框架需要统一的 dispose() 调用口径，
// 并且要保证多次 dispose 只真正执行一次（见下方 once 的实现）。
export function toDisposable(fn: () => void): IDisposable {
  return { dispose: once(fn) };
}

// 文件私有辅助函数（没有 export 关键字，只在本文可见）。
// "once" 包装器：用闭包（closure，内层函数记住外层变量）记录是否已调用过，
// 保证 fn 只被执行一次——防止资源被重复释放。
// 类型 `() => void` 读作："无参数、无返回值"的函数类型。
function once(fn: () => void): () => void {
  // let 声明"可以重新赋值"的变量（对比 const 不可重新赋值），充当已调用标记。
  let called = false;
  // 返回闭包函数：它能在 once 执行结束后继续访问 called 和 fn。
  return () => {
    if (!called) {
      called = true;
      fn();
    }
  };
}

/**
 * DisposableStore 收集多个 IDisposable，统一释放。
 * VS Code 里几乎每个类都有一个 DisposableStore 来管理子资源。
 */
// TS 语法：`implements IDisposable` 表示本类承诺满足 IDisposable 接口，
// 编译器会强制检查 dispose 方法真的存在，少写就报错。
export class DisposableStore implements IDisposable {
  // Set 是 JS 内置集合：元素不重复、增删都快。存放所有待释放的子资源。
  private items = new Set<IDisposable>();
  // private：只有类内部能访问（编译期检查）。标记本 store 是否已释放。
  private isDisposed = false;

  // 泛型方法（第一次遇到泛型）：`<T extends IDisposable>` 声明类型参数 T，
  // `extends IDisposable` 是泛型约束——要求调用方传入的类型必须实现 IDisposable。
  // 返回类型写 T 而不是 IDisposable，是为了保住调用方手里更具体的类型信息。
  add<T extends IDisposable>(item: T): T {
    // 防御：store 已释放还往里加资源属于使用错误——
    // 当场把资源释放掉并警告，避免它被悄悄吞掉泄漏。
    if (this.isDisposed) {
      console.warn("Adding to a disposed DisposableStore");
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  // 统一释放：逐个释放收集到的资源再清空集合。
  // 靠 isDisposed 标记做到"幂等"（重复调用无害，第二次直接返回）。
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    // for...of：逐个取出集合中的每一项。
    for (const item of this.items) {
      item.dispose();
    }
    this.items.clear();
  }
}

// ============================================================================
// Event System - 事件系统
// ============================================================================

/**
 * Event<T> 就是一个函数签名：传入 listener，返回一个 IDisposable 用于取消订阅。
 * 这是整个 IPC 框架中事件流转的核心类型。
 */
// 这是本框架最反直觉的设计，值得慢读：
// TS 允许直接用箭头函数的"形状"来描述函数类型。这行读作：
//   Event<T> 是一个函数——接收一个监听器函数，返回用于退订的 IDisposable。
// 也就是说"事件"不是一个类，就是一个可调用的订阅入口。
// `<T>` 是泛型参数（类型占位符），表示"该事件携带的数据类型"：
// Event<string> 就是携带 string 的事件，订阅方拿到的 e 就是 string。
export type Event<T> = (listener: (e: T) => void) => IDisposable;

// TS 语法：namespace（命名空间）把一组相关工具函数打包，且能"合并"到同名类型上——
// 于是 Event<T> 可以当类型用，Event.once(...) 又可以当工具函数用。编译后就是普通对象。
export namespace Event {
  /** 永远不触发的事件 */
  // `any` 表示"放弃类型检查"，这里是少数合理用法：None 不携带任何数据。
  // 返回一个 dispose 为空函数的对象——订阅它永远等不到触发，退订也无害。
  export const None: Event<any> = () => ({ dispose() {} });

  /** 只触发一次就自动取消订阅 */
  // 装饰器手法：不修改原事件，而是包一层得到新事件。
  // 用 fired 标记保证监听器只执行一次，并自动退订。
  export function once<T>(event: Event<T>): Event<T> {
    return (listener) => {
      let fired = false;
      // 先订阅原事件、拿到退订句柄。注意顺序：必须先 dispose 再通知监听器，
      // 避免监听器内部又触发本事件造成重入。
      const disposable = event((e) => {
        if (!fired) {
          fired = true;
          disposable.dispose();
          listener(e);
        }
      });
      return disposable;
    };
  }

  /** 把事件转为 Promise，resolve 后自动取消订阅 */
  // Promise 是 JS 的异步原语：代表"未来才会有结果"的值。
  // new Promise((resolve) => ...) 中的 resolve 是"成功时交出结果"的回调。
  // 这里把 resolve 直接当作一次性监听器挂上去——事件一触发，Promise 就完成。
  export function toPromise<T>(event: Event<T>): Promise<T> {
    return new Promise((resolve) => once(event)(resolve));
  }

  /** 过滤事件 */
  // 返回的新事件只把满足 fn 条件的数据转发给监听器，不满足的直接丢弃。
  export function filter<T>(event: Event<T>, fn: (e: T) => boolean): Event<T> {
    return (listener) =>
      event((e) => {
        if (fn(e)) {
          listener(e);
        }
      });
  }

  /** 映射事件 */
  // `<T, R>` 两个泛型参数：输入事件携带 T，经 fn 变换后得到 R。
  export function map<T, R>(event: Event<T>, fn: (e: T) => R): Event<R> {
    return (listener) => event((e) => listener(fn(e)));
  }
}

/**
 * Emitter<T> 是事件的发射器。
 *
 * 关键设计：
 * - onWillAddFirstListener: 第一个订阅者到来时触发（懒初始化资源）
 * - onDidRemoveLastListener: 最后一个订阅者离开时触发（释放资源）
 *
 * 这个"懒订阅"机制在 IPC 框架中至关重要——
 * ChannelClient 的 requestEvent 正是利用它来实现
 * "有人监听才发送 EventListen 请求，无人监听就发 EventDispose"。
 */
// `implements IDisposable`：Emitter 自己也是资源，用完同样要 dispose。
export class Emitter<T> implements IDisposable {
  // 存放当前所有监听器。`(e: T) => void` 是"监听器函数"的类型：接收事件数据 e，无返回值。
  private listeners = new Set<(e: T) => void>();
  // 释放标记：释放后不再接受订阅、不再派发。
  private disposed = false;
  // `?` 表示该属性可能不存在（undefined）。存放构造时传入的可选钩子。
  private options?: EmitterOptions;

  // 构造函数：new Emitter({...}) 时执行。参数前的 ? 同样表示可以不传。
  constructor(options?: EmitterOptions) {
    this.options = options;
  }

  // getter（访问器）：让 `emitter.event` 像属性一样访问，但读取时实际执行下面这段代码。
  // 它返回的不是数据，而是一个"订阅函数"（正是上面定义的 Event<T> 类型）。
  get event(): Event<T> {
    return (listener: (e: T) => void) => {
      // 已释放的发射器不接受订阅：返回空退订句柄（订阅无效但不报错）。
      if (this.disposed) {
        return { dispose() {} };
      }

      // 记下"我来的时候是不是第一个订阅者"。必须在 add 之前判断，
      // 否则把自己加进去之后就永远判断不出来了。
      const isFirst = this.listeners.size === 0;
      this.listeners.add(listener);

      // `?.` 可选链（第一次遇到）：只有前面的值不是 null/undefined 才继续往后调用，
      // 否则整个表达式安静地返回 undefined——省去层层 if 判空。
      // 这里实现"懒初始化"：第一个订阅者出现时才通知外部去准备资源。
      if (isFirst) {
        this.options?.onWillAddFirstListener?.();
      }

      // 返回退订句柄：调用 dispose() 时把自己从集合移除；
      // 若这是最后一个订阅者，再通知外部释放底层资源。
      return toDisposable(() => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) {
          this.options?.onDidRemoveLastListener?.();
        }
      });
    };
  }

  // 触发事件：把数据依次派发给当前所有监听器（同步调用）。
  fire(event: T): void {
    if (this.disposed) {
      return;
    }
    // `[...this.listeners]` 展开运算符：把 Set 复制成新数组再遍历。
    // 为什么多此一举？若某个监听器执行时又订阅/退订了本事件，
    // 直接遍历原 Set 会"边遍历边改动"，行为不可预测——快照迭代免疫此问题。
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  // 释放：之后 fire 不再派发、event 不再接受订阅。
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

// Emitter 可选钩子的类型定义。两个字段的 ? 都表示"可以不传"。
interface EmitterOptions {
  onWillAddFirstListener?: () => void;
  onDidRemoveLastListener?: () => void;
}

/**
 * Relay 是一个"事件中继器"，可以动态切换输入源。
 * 用于 getDelayedChannel 中：先创建 Relay，等 channel promise resolve 后切换 input。
 */
// `implements IDisposable`：Relay 自己也是资源。
export class Relay<T> implements IDisposable {
  // 内部持有一个真正的发射器，负责对外提供 event。
  private emitter = new Emitter<T>();
  // 当前输入源的退订句柄。初始为"空操作"对象，保证首次切换前 dispose 也安全。
  private inputDisposable: IDisposable = { dispose() {} };

  // readonly（第一次遇到）：只能在初始化时赋值，之后不可修改——防止外部误改。
  // 对外只暴露订阅入口，把内部发射器藏起来。
  readonly event = this.emitter.event;

  // setter（赋值访问器）：让 `relay.input = 某个事件` 像赋值一样切换输入源。
  // 先退订旧源（防泄漏），再订阅新源：新事件一触发就转发给内部发射器。
  set input(event: Event<T>) {
    this.inputDisposable.dispose();
    this.inputDisposable = event((e) => this.emitter.fire(e));
  }

  // 整体清理：退订输入源 + 释放内部发射器。
  dispose(): void {
    this.inputDisposable.dispose();
    this.emitter.dispose();
  }
}

/**
 * EventMultiplexer 聚合多个事件源为一个事件。
 * IPCServer 的 getMulticastEvent 用它来聚合所有客户端的同名事件。
 */
export class EventMultiplexer<T> implements IDisposable {
  // emitter 负责对外统一发射；disposables 记录每个输入源的退订句柄，便于整体清理。
  private readonly emitter = new Emitter<T>();
  private readonly disposables: IDisposable[] = [];

  readonly event = this.emitter.event;

  // 再接入一个事件源：立即订阅并转发到内部发射器；
  // 返回的句柄可以单独退订这一路（重复 dispose 无害，见 once Disposable 的幂等设计）。
  add(event: Event<T>): IDisposable {
    const d = event((e) => this.emitter.fire(e));
    this.disposables.push(d);
    return d;
  }

  // 整体清理：退订所有输入源，再释放内部发射器。
  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.emitter.dispose();
  }
}

// ============================================================================
// CancellationToken - 取消令牌
// ============================================================================

// 取消令牌（CancellationToken）：协作式取消的标准模式。
// 发起方握着 CancellationTokenSource（遥控器），执行方拿着 token（信号灯），
// 通过轮询 isCancellationRequested 或订阅 onCancellationRequested 感知"该停了"。
export interface CancellationToken {
  // readonly：外部只能读不能改——"是否取消"的决定权只在 Source 手里。
  readonly isCancellationRequested: boolean;
  // Event<void> 的 void 表示事件不携带数据——只通知"取消了"这个事实本身。
  readonly onCancellationRequested: Event<void>;
}

// 又是 namespace 挂常量的用法：None 是"永远不会取消"的现成令牌，
// 供不支持取消的接口当默认值，调用方无需判空。
export namespace CancellationToken {
  // 对象字面量直接"实现"接口：TS 会逐字段检查形状是否匹配。
  export const None: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: Event.None,
  };
}

export class CancellationTokenSource implements IDisposable {
  // `?` 惰性持有：token 第一次被访问时才创建（见下方 getter）。
  private _token?: CancellationToken;
  // 取消时靠它向所有 token 持有者广播。Emitter<void>：事件不带数据。
  private emitter = new Emitter<void>();
  // 防止 cancel 被重复调用时重复广播。
  private _isCancelled = false;

  // 惰性初始化：首次访问 token 才创建令牌对象，把令牌的"取消事件"接到内部发射器。
  // 之后每次访问都返回同一个对象——保证所有拿到 token 的人看到同一份取消状态。
  get token(): CancellationToken {
    if (!this._token) {
      this._token = {
        isCancellationRequested: false,
        onCancellationRequested: this.emitter.event,
      };
    }
    return this._token;
  }

  // 触发取消：先置标记再广播，保证监听器回调里读 isCancellationRequested 时已是 true。
  // fire() 不带参数——因为事件类型是 Event<void>。
  cancel(): void {
    if (!this._isCancelled) {
      this._isCancelled = true;
      this.emitter.fire();
    }
  }

  // 释放广播器。注意：dispose 不会自动触发 cancel，只是不能再广播了。
  dispose(): void {
    this.emitter.dispose();
  }
}
