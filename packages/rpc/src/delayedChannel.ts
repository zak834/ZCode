// "延迟通道"：把"未来才会就绪的通道"（Promise<IChannel>）包装成立即可用的 IChannel。
// 典型场景：连接还在建立中，调用方已经想拿通道发请求——不用到处 await，
// 直接用这个代理，内部会自动等就绪再把请求转过去。
// `import { type X }` 是混合导入：Event/Relay 是运行时值，type CancellationToken 只是类型。
import { type CancellationToken, Event, Relay } from "./foundation.js";
import type { IChannel } from "./channels.shared.js";

// `<T extends IChannel>`：泛型约束，T 是任何实现了 IChannel 的通道类型。
// 参数是"通道的 Promise"——此刻可能还没就绪。
export function getDelayedChannel<T extends IChannel>(promise: Promise<T>): T {
  // 返回一个"行为像 T"的代理对象：call/listen 都先等 promise 就绪再转发。
  // 结尾的 `as T` 类型断言：这个对象字面量只按 IChannel 的签名实现，
  // 编译器无法证明它就是 T（T 可能带更多成员），这里由我们向编译器明确担保。
  return {
    // call：promise.then 等通道就绪后原样转发；then 返回新 Promise，正好满足返回类型。
    call(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<any> {
      return promise.then((channel) => channel.call(command, arg, cancellationToken));
    },
    // listen 稍复杂：事件订阅必须**同步**返回 Event，但通道还没就绪。
    // 借用 Relay（事件中继，见 foundation.ts）当占位出口：
    // 先把 relay.event 交给订阅者；等通道就绪后把真正的事件源接进 relay.input，
    // 订阅者的监听器从此开始收到数据——这正是 Relay 存在的意义。
    listen(event: string, arg?: any): Event<any> {
      const relay = new Relay<any>();
      promise.then((channel) => {
        relay.input = channel.listen(event, arg);
      });
      return relay.event;
    },
  } as T;
}
