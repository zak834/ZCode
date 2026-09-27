/**
 * Layer 5: ProxyChannel —— 服务自动代理（杀手锏）
 *
 * 这是让 VS Code 开发者效率极高的关键抽象。
 *
 * 没有 ProxyChannel 时，你需要为每个服务手写 IServerChannel：
 *   class FileServiceChannel implements IServerChannel {
 *     call(ctx, command, arg) {
 *       switch (command) {
 *         case 'readFile': return this.service.readFile(arg[0]);
 *         case 'writeFile': return this.service.writeFile(arg[0], arg[1]);
 *         // ... 每个方法都要手动映射
 *       }
 *     }
 *   }
 *
 * 有了 ProxyChannel，一行代码搞定：
 *   const channel = ProxyChannel.fromService(fileService);
 *   // 自动把所有方法映射为 call，所有 on* 事件映射为 listen
 *
 * 客户端同样一行：
 *   const fileService = ProxyChannel.toService<IFileService>(channel);
 *   await fileService.readFile(uri);  // 就像调用本地方法！
 *
 * 原理：
 * - fromService: 遍历 service 的属性，方法 → call，on* 事件 → listen
 * - toService: 利用 ES6 Proxy 拦截属性访问，自动分派到 call/listen
 */

import { Event, Emitter, IDisposable, DisposableStore } from "./foundation.js";
import { IChannel, IServerChannel } from "./channels.js";

// ============================================================================
// ProxyChannel
// ============================================================================

export namespace ProxyChannel {
  /**
   * 服务端：把一个 service 对象自动包装为 IServerChannel
   *
   * 约定：
   * - 以 on + 大写字母开头的属性视为事件 (如 onDidChange)
   * - 以 onDynamic + 大写字母开头的视为动态事件（方法，调用后返回事件）
   * - 其他方法视为 RPC 方法
   */
  export function fromService<TContext>(
    // `unknown`：只知道"是个对象"，不知道具体类型——接下来全靠运行时探测。
    service: unknown,
    disposables?: DisposableStore,
  ): IServerChannel<TContext> {
    // 索引签名断言：`{ [key: string]: unknown }` 读作"任意字符串键都能取值"，
    // 之后 handler[key] 这样按名字取成员就合法了。
    const handler = service as { [key: string]: unknown };

    // 预缓存所有事件并 buffer
    // for...in 遍历对象的**键名**（注意区别于 for...of 遍历值）。
    const eventMap = new Map<string, Event<unknown>>();
    for (const key in handler) {
      // 三个条件同时满足才算事件属性：符合 onXxx 命名、不是 onDynamicXxx、值确实是函数。
      if (isEvent(key) && !isDynamicEvent(key) && typeof handler[key] === "function") {
        // 把事件 buffer 化：即使没人订阅，事件也不会丢失
        // `as Event<unknown>`：从 unknown 断言回事件类型（探测结论，由我们担保）。
        eventMap.set(key, bufferEvent(handler[key] as Event<unknown>));
      }
    }

    return {
      listen<T>(_ctx: TContext, event: string, arg?: any): Event<T> {
        // `_ctx` 下划线惯例：服务端知道是谁在调，但这层包装用不上。
        // 先查缓存
        const cached = eventMap.get(event);
        if (cached) {
          return cached as Event<T>;
        }

        const target = handler[event];
        if (typeof target === "function") {
          // 动态事件：onDynamicXxx(arg) 返回一个 Event
          // `target.call(handler, arg)`：以 handler 为 this 调用该方法（function.call 的用法）。
          if (isDynamicEvent(event)) {
            return target.call(handler, arg);
          }
          // 延迟发现的事件（Proxy 服务可能不会在 for-in 中出现）
          // 首次被订阅时现查现缓存，效果与预缓存一致。
          if (isEvent(event)) {
            eventMap.set(event, bufferEvent(handler[event] as Event<unknown>));
            return eventMap.get(event) as Event<T>;
          }
        }

        // 既不在缓存也找不到目标：明确报错而不是静默失败。
        throw new Error(`Event not found: ${event}`);
      },

      call<T>(_ctx: TContext, command: string, args?: any[]): Promise<T> {
        const target = handler[command];
        if (typeof target === "function") {
          // `target.apply(handler, args)`：以 handler 为 this、把参数数组整体传入
          // （apply 与 call 的唯一区别：前者参数是数组，后者逐个列出）。
          let result = target.apply(handler, args || []);
          // RPC 约定结果必须是 Promise——方法返回普通值就包一层（`!` 是逻辑取反）。
          if (!(result instanceof Promise)) {
            result = Promise.resolve(result);
          }
          return result;
        }
        throw new Error(`Method not found: ${command}`);
      },
    };
  }

  /**
   * 客户端：把一个 IChannel 包装成类型安全的 service 对象
   *
   * 利用 ES6 Proxy 拦截所有属性访问：
   * - 访问 on* → channel.listen(propKey)
   * - 访问其他 → 返回一个函数，调用时变成 channel.call(propKey, args)
   */
  export function toService<T extends object>(
    channel: IChannel,
    options?: { context?: unknown },
  ): T {
    // ES6 Proxy（本框架最"魔法"的一处）：`new Proxy(目标对象, 处理器)`
    // 返回一个"影子对象"，对它的一切属性访问都会被下面的 get 陷阱拦截。
    // `{} as T`：影子对象的真身是个空对象——所有成员都是"被访问时现造"的。
    return new Proxy({} as T, {
      // get 陷阱：每次读属性都进这里。propKey 的类型 PropertyKey = string | symbol。
      get(target: T, propKey: PropertyKey, receiver: object) {
        // React 开发态、日志工具和浏览器运行时会探测对象的 Symbol / then 等内置属性。
        // 之前这里把所有未知属性都强行当成 RPC 成员处理，读取 Symbol.toStringTag 会直接抛错，
        // 读取 then 还会把普通 service 误判成 thenable，导致远程 workspace 在选目录后重渲染时炸掉。
        // 这类运行时探测属性应该回退到普通对象语义，而不是走 RPC。
        if (typeof propKey === "symbol") {
          // Reflect.get：执行"本来会发生"的普通属性读取。
          return Reflect.get(target as object, propKey, receiver);
        }

        if (typeof propKey === "string") {
          // `then` 是 Promise 约定的方法名：返回 undefined 表示"我不是 thenable"，
          // 防止别人 await 这个 service 时被误当成 Promise 处理。
          if (propKey === "then") {
            return undefined;
          }

          // 动态事件
          // 返回的不是事件本身，而是"调用后给你事件"的函数——匹配 onDynamicXxx(arg) 的用法。
          if (isDynamicEvent(propKey)) {
            return (arg: unknown) => channel.listen(propKey, arg);
          }

          // 普通事件
          // 访问 service.onXxx 直接得到事件订阅入口。
          if (isEvent(propKey)) {
            return channel.listen(propKey);
          }

          // 方法调用
          // 其余一切属性都当成方法：返回一个异步函数，真正调用时才发起 RPC。
          // `...args` 是剩余参数：把所有实参收进一个数组。
          return async (...args: unknown[]) => {
            // 可选：注入 context 作为第一个参数
            // `options?.context`：没传 options 就不注入；`[ctx, ...args]` 把 context 拼在最前。
            const methodArgs = options?.context !== undefined ? [options.context, ...args] : args;
            return channel.call(propKey, methodArgs);
          };
        }

        return Reflect.get(target as object, propKey, receiver);
      },
    });
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 匹配 onXxx 事件命名约定 */
// 判断名字是否形如 onXxx（X 是大写字母）。
// charCodeAt 取字符的 ASCII 码：65~90 恰好是 A~Z——为什么不直接比对字符？
// 因为要判断的是"任意大写字母"这个范围，不是某个特定字母。
function isEvent(name: string): boolean {
  return (
    name.length >= 3 &&
    name[0] === "o" &&
    name[1] === "n" &&
    name.charCodeAt(2) >= 65 && // A
    name.charCodeAt(2) <= 90
  ); // Z
}

/** 匹配 onDynamicXxx 动态事件命名约定 */
// 同上：第 9 位必须是大写字母——区分 onDynamicFoo 与恰好叫 onDynamic 的普通属性。
function isDynamicEvent(name: string): boolean {
  return (
    name.length >= 10 &&
    name.startsWith("onDynamic") &&
    name.charCodeAt(9) >= 65 &&
    name.charCodeAt(9) <= 90
  );
}

/**
 * 缓冲事件：确保在订阅之前触发的事件不会丢失。
 * 未订阅时事件存入队列，一有订阅者就 flush。
 */
// 缓冲事件：确保在订阅之前触发的事件不会丢失。
// 未订阅时事件存入队列，一有订阅者就 flush。
// 思路同响应式编程的 ReplaySubject：解决"事件发生得太早、订阅者来得太晚"的竞态。
function bufferEvent<T>(event: Event<T>): Event<T> {
  // 暂存队列；flushing 标记防重入；listener 是对底层事件的实际订阅句柄。
  let buffer: T[] = [];
  let flushing = false;
  let listener: IDisposable | undefined;

  const emitter = new Emitter<T>({
    // 第一个订阅者出现：这才去订阅底层事件。
    onWillAddFirstListener: () => {
      listener = event((e) => {
        // 正在 flush 就直接转发（不重复入队）；否则先存起来。
        if (flushing) {
          emitter.fire(e);
        } else {
          buffer.push(e);
        }
      });
    },
    // 没人听了：退订底层并清空缓冲（事件的意义只对订阅者存在）。
    onDidRemoveLastListener: () => {
      listener?.dispose();
      listener = undefined;
      buffer = [];
    },
  });

  // 一旦有订阅者，先 flush 缓冲区
  // 把 emitter.event 再包一层：订阅动作完成后，把攒下的事件按顺序重放给新订阅者。
  // flushing 置位 + 重放后清空——重放期间底层新触发的事件走上面的转发路径，不丢不错序。
  const originalEvent = emitter.event;
  return (listener_fn) => {
    const disposable = originalEvent(listener_fn);
    if (!flushing) {
      flushing = true;
      for (const item of buffer) {
        emitter.fire(item);
      }
      buffer = [];
    }
    return disposable;
  };
}
