/**
 * 示例 1: 基础 IPC —— 通过内存 Queue 演示完整的 RPC 调用
 *
 * 演示了最核心的流程：
 * 1. 创建内存传输对 (QueueProtocol)
 * 2. 在服务端注册一个 channel
 * 3. 客户端获取 channel 并调用方法 / 监听事件
 *
 * 数据流：
 *   client.call('add', [1, 2])
 *       ↓ serialize → send
 *   [protocol A] ──buffer──→ [protocol B]
 *       ↓ deserialize → dispatch
 *   channel.call(ctx, 'add', [1, 2])
 *       ↓ return 3
 *   [protocol B] ──buffer──→ [protocol A]
 *       ↓ deserialize → resolve promise
 *   result = 3
 */

import {
  Emitter,
  Event,
  IServerChannel,
  ChannelServer,
  ChannelClient,
  createQueuePair,
} from "../src/index.js";

// ============================================================================
// Step 1: 定义一个 service（普通 TypeScript 对象）
// ============================================================================

// 一个普通的服务类——注意它与 RPC 框架零耦合：就是普通的对象 + 事件。
// 泛型参数 { op: string; result: number } 是内联对象类型（channelServer 讲过）：
// 表示事件携带"运算描述 + 结果"两个字段。
class CalculatorService {
  private readonly _onDidCompute = new Emitter<{ op: string; result: number }>();
  readonly onDidCompute = this._onDidCompute.event;

  add(a: number, b: number): number {
    const result = a + b;
    // 每次运算顺便广播事件（op 字段记录"算的是什么"，模板字符串拼出如 "1 + 2"）。
    this._onDidCompute.fire({ op: `${a} + ${b}`, result });
    return result;
  }

  multiply(a: number, b: number): number {
    const result = a * b;
    this._onDidCompute.fire({ op: `${a} * ${b}`, result });
    return result;
  }

  // async 方法：返回 Promise——RPC 方法天然允许异步（比如内部要读文件）。
  async divide(a: number, b: number): Promise<number> {
    if (b === 0) {
      // throw 的错误会被 ChannelServer 捕获并跨网络回传给客户端（错误传播）。
      throw new Error("Division by zero");
    }
    const result = a / b;
    this._onDidCompute.fire({ op: `${a} / ${b}`, result });
    return result;
  }
}

// ============================================================================
// Step 2: 手写 IServerChannel（后面的例子会用 ProxyChannel 自动化）
// ============================================================================

// 手写的"通道适配器"：把命令名翻译成对 service 的真实调用。
// 这正是 ProxyChannel 要消灭的样板代码（对比示例 2）。
class CalculatorChannel implements IServerChannel {
  constructor(private service: CalculatorService) {}

  call(_ctx: string, command: string, arg?: any): Promise<any> {
    // arg 是参数数组：客户端传 [10, 20]，这里拆出 arg[0]、arg[1]。
    switch (command) {
      case "add":
        // 同步方法用 Promise.resolve 包成 Promise（RPC 契约要求）。
        return Promise.resolve(this.service.add(arg[0], arg[1]));
      case "multiply":
        return Promise.resolve(this.service.multiply(arg[0], arg[1]));
      case "divide":
        // divide 本身就是 async，直接返回即可。
        return this.service.divide(arg[0], arg[1]);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  listen(_ctx: string, event: string): Event<any> {
    switch (event) {
      case "onDidCompute":
        // 事件订阅就是把 service 的事件入口原样交出去。
        return this.service.onDidCompute;
      default:
        throw new Error(`Unknown event: ${event}`);
    }
  }
}

// ============================================================================
// Step 3: 建立连接并进行 RPC
// ============================================================================

// 用 async 函数包住主流程：函数体内才能放心用 await（顶层 await 需要特殊配置）。
async function main() {
  // 创建内存传输对
  // 解构元组（protocol 的 createQueuePair 讲过）：一次接住返回的两个协议。
  const [protocolA, protocolB] = createQueuePair();

  // 服务端：在 protocolB 上注册 channel
  const service = new CalculatorService();
  const server = new ChannelServer(protocolB, "server-ctx");
  server.registerChannel("calculator", new CalculatorChannel(service));

  // 客户端：通过 protocolA 获取 channel
  const client = new ChannelClient(protocolA);

  // 等待初始化完成
  // 服务端构造时会立刻发 Initialize；客户端必须等收到它才能发请求。
  await Event.toPromise(client.onDidInitialize);

  const calculator = client.getChannel("calculator");

  // 订阅事件
  // 两段调用：listen(...) 返回 Event，紧接着 (e) => {...} 完成订阅（channelServer 讲过）。
  // 返回的退订句柄存好，结束前要清理。
  const disposable = calculator.listen<{ op: string; result: number }>("onDidCompute")((e) => {
    console.log(`  [event] ${e.op} = ${e.result}`);
  });

  // 调用方法
  console.log("--- Basic IPC Demo ---");

  // 发起 RPC：`call<number>` 泛型实参指定返回值类型；参数打包成数组传输。
  const sum = await calculator.call<number>("add", [10, 20]);
  console.log(`add(10, 20) = ${sum}`);

  const product = await calculator.call<number>("multiply", [6, 7]);
  console.log(`multiply(6, 7) = ${product}`);

  const quotient = await calculator.call<number>("divide", [100, 3]);
  console.log(`divide(100, 3) = ${quotient}`);

  // 测试错误传播
  // 服务端 throw 的错误跨过网络后在本端 re-throw。`err: any` 是 catch 参数的常见省事写法
  // （TS 的 catch 参数默认 unknown；生产代码建议保持 unknown 再收窄）。
  try {
    await calculator.call("divide", [1, 0]);
  } catch (err: any) {
    console.log(`divide(1, 0) → Error: ${err.message}`);
  }

  // 清理
  // 订阅 → 客户端 → 服务端。
  disposable.dispose();
  client.dispose();
  server.dispose();

  console.log("\nDone!");
}

// 执行并兜底：main 是 async 的，任何一步抛错都会被 .catch 捕获打印。
main().catch(console.error);
