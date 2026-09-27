/**
 * Layer 0.5: 跨平台 Buffer 抽象
 *
 * VS Code 需要在 Node.js (Buffer) 和浏览器 (Uint8Array) 之间统一二进制操作。
 * VSBuffer 是对 Uint8Array 的薄封装，提供统一的读写接口。
 *
 * 这是序列化层和传输层的基础。
 */

// TS 语法：`private constructor` —— 私有构造函数（第一次遇到）：
// 禁止外部直接 new VSBuffer(...)，强制大家走下面的静态工厂方法创建实例。
// 好处：创建入口集中、命名表意（alloc/wrap/fromString 各司其职）。
export class VSBuffer {
  // Uint8Array 是 JS 的"字节数组"：每个元素是一个 0~255 的整数，正好对应一个字节。
  readonly buffer: Uint8Array;
  // 缓存字节数，避免每次都去读底层 数组的 length。
  readonly byteLength: number;

  // 真正的构造逻辑：把底层字节数组和它的长度记下来。
  private constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    this.byteLength = buffer.byteLength;
  }

  /** 分配指定大小的空 buffer */
  // static：静态方法，直接挂在类本身上（VSBuffer.alloc(...)）调用，不需要先有实例。
  // new Uint8Array(n) 分配 n 个字节，初始值全是 0。
  static alloc(byteLength: number): VSBuffer {
    return new VSBuffer(new Uint8Array(byteLength));
  }

  /** 包装已有的 Uint8Array */
  // 最薄的一层：不复制数据，直接把已有字节数组包起来（零拷贝）。
  static wrap(buffer: Uint8Array): VSBuffer {
    return new VSBuffer(buffer);
  }

  /** 从字符串创建 buffer (UTF-8) */
  // TextEncoder 是浏览器/Node 都内置的 UTF-8 编码器：字符串 → 字节。
  // 为什么不用 Node 的 Buffer.from？因为本类要跨环境（浏览器里没有 Buffer）。
  static fromString(str: string): VSBuffer {
    const encoder = new TextEncoder();
    return new VSBuffer(encoder.encode(str));
  }

  /** 拼接多个 buffer */
  // `totalLength?: number` 的 ? 表示该参数可不传；`VSBuffer[]` 表示"VSBuffer 数组"。
  static concat(buffers: VSBuffer[], totalLength?: number): VSBuffer {
    // `??`（空值合并，第一次遇到）：左侧是 null/undefined 时才取右侧的默认值。
    // 与 || 的区别：只在"真的没传"时才用备胎，传入 0、'' 这类合法值不会被误覆盖。
    // reduce：把数组归约成一个值——这里把所有 buffer 的长度累加。
    const len = totalLength ?? buffers.reduce((sum, b) => sum + b.byteLength, 0);
    // 先分配一块总长度的全新内存。
    const result = VSBuffer.alloc(len);
    // offset 记录"下一个 buffer 该从哪个字节位置开始放"。
    let offset = 0;
    for (const buf of buffers) {
      // 把每个 buffer 依次拷贝进结果的对应位置，然后后移写入指针。
      result.set(buf, offset);
      offset += buf.byteLength;
    }
    return result;
  }

  /** 转为 UTF-8 字符串 */
  // TextDecoder：字节 → 字符串（与 TextEncoder 方向相反），同样跨环境可用。
  toString(): string {
    const decoder = new TextDecoder();
    return decoder.decode(this.buffer);
  }

  /** 切片 */
  // 截取 [start, end) 区间。注意 slice 返回**新数组**（复制数据），不共享内存。
  slice(start: number, end?: number): VSBuffer {
    return new VSBuffer(this.buffer.slice(start, end));
  }

  /** 拷贝数据到 this buffer 的指定位置 */
  // 参数默认值（第一次遇到）：`offset = 0` 表示调用时不传就自动用 0。
  // 联合类型 `VSBuffer | Uint8Array`：两种类型都接受。
  set(source: VSBuffer | Uint8Array, offset = 0): void {
    // `instanceof`：运行时判断对象是哪个类的实例，借此"收窄"联合类型——
    // 是 VSBuffer 就取出它内部的原生字节数组，否则直接用传入的数组。
    // `cond ? a : b` 是三元表达式：条件成立取 a，否则取 b。
    const raw = source instanceof VSBuffer ? source.buffer : source;
    // Uint8Array.set：把 raw 的内容拷贝到 this.buffer 从 offset 开始的位置（覆盖写入，不是插入）。
    this.buffer.set(raw, offset);
  }

  // 读取下标 offset 处的 1 个字节（0~255）。
  readUInt8(offset: number): number {
    return this.buffer[offset];
  }

  // 写入 1 个字节：直接下标赋值。
  writeUInt8(value: number, offset: number): void {
    this.buffer[offset] = value;
  }

  // 读取 4 个字节，按"大端序"（Big-Endian：高位字节在前）拼成一个 32 位无符号整数。
  // 例：字节 [0x00,0x00,0x01,0x00] → 0x00000100 = 256。本框架的帧长度头就是这么读的。
  // 位运算逐个拆解：
  //   `<< 24`：第一字节左移 24 位，挪进 32 位空间的最高 8 位；<< 16、<< 8 依次类推；
  //   `|`（按位或）：四段互不重叠的部分拼接合并；
  //   `>>> 0`（无符号右移 0 位）：唯一作用是把结果强制转成无符号 32 位整数——
  //   JS 位运算默认按"有符号 32 位"处理，最高位是 1 时结果会变负数，必须纠正。
  readUInt32BE(offset: number): number {
    return (
      ((this.buffer[offset] << 24) |
        (this.buffer[offset + 1] << 16) |
        (this.buffer[offset + 2] << 8) |
        this.buffer[offset + 3]) >>>
      0
    );
  }

  // 与上面相反：把一个 32 位整数拆成 4 个字节按大端序写入。
  //   `value >>> 24`：无符号右移 24 位，把最高 8 位挪到最低 8 位的位置；
  //   `& 0xff`：按位与，0xff 是二进制的 8 个 1——只保留低 8 位、清掉更高位。
  // 右移量 24/16/8/0 依次取出从高到低的四个字节。
  writeUInt32BE(value: number, offset: number): void {
    this.buffer[offset] = (value >>> 24) & 0xff;
    this.buffer[offset + 1] = (value >>> 16) & 0xff;
    this.buffer[offset + 2] = (value >>> 8) & 0xff;
    this.buffer[offset + 3] = value & 0xff;
  }
}
