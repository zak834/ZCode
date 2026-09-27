/**
 * Layer 1: 二进制序列化
 *
 * RPC 消息需要编码为二进制才能通过 IMessagePassingProtocol 传输。
 * 这里实现了 VS Code 的自定义序列化协议：
 *
 * 格式: [1 byte 类型标签] [VQL 编码的长度] [数据]
 *
 * VQL (Variable-Length Quantity) 用 7 bit 存数据，最高位标记是否还有后续字节。
 * 小数字只需 1 byte，大数字按需扩展，比固定 4 byte 更紧凑。
 */

// import 语句（第一次遇到）：从另一个模块引入能力。
// `{ VSBuffer }` 是具名导入——只取那个模块 export 出来的同名成员。
// 路径里的 `.js` 后缀不是笔误：TS 的 ESM 规范要求写编译后的目标文件名
// （buffer.ts 编译成 buffer.js），TS 会自动帮你对应到 .ts 源文件。
import { VSBuffer } from "./buffer.js";

// ============================================================================
// Reader / Writer 接口
// ============================================================================

// 两个极简接口：定义"能读"和"能写"的能力契约。
// 面向接口而不是面向具体类编程——后面所有序列化函数只认这两个接口，
// 至于底层是内存 buffer、网络流还是文件，它们一概不关心。
export interface IReader {
  // 读取指定字节数，返回包含这些字节的新 VSBuffer。
  read(bytes: number): VSBuffer;
}

export interface IWriter {
  // 追加写入一个 buffer。
  write(buffer: VSBuffer): void;
}

/**
 * BufferReader: 从一个 VSBuffer 中按顺序读取数据。
 * 内部维护一个 pos 游标。
 */
export class BufferReader implements IReader {
  // pos 是"游标"：记录当前读到了第几个字节，每读一段就前移。
  private pos = 0;

  // TS 语法：`private buffer` 直接写在构造函数参数上——这是"参数属性"简写：
  // 等价于"声明字段 buffer"+"构造函数里 this.buffer = buffer"两步，一行搞定。
  constructor(private buffer: VSBuffer) {}

  // 读取 [pos, pos+bytes) 这一段，然后把游标后移实际读到的字节数。
  read(bytes: number): VSBuffer {
    const result = this.buffer.slice(this.pos, this.pos + bytes);
    this.pos += result.byteLength;
    return result;
  }
}

/**
 * BufferWriter: 收集多个写入的 buffer，最后通过 .buffer 属性一次性拼接。
 * 避免了写入时频繁的内存拷贝。
 */
export class BufferWriter implements IWriter {
  // 先把每段数据"记账"存进数组，而不是每写一段就拼一次——避免频繁内存拷贝。
  private buffers: VSBuffer[] = [];

  // getter：真正需要结果时（读取 buffer 属性）才一次性拼接所有片段。
  get buffer(): VSBuffer {
    return VSBuffer.concat(this.buffers);
  }

  // 写入 = 往账本里追加一条。
  write(buffer: VSBuffer): void {
    this.buffers.push(buffer);
  }
}

// ============================================================================
// VQL 编码
// ============================================================================

/**
 * 读取 VQL 编码的整数
 * @see https://en.wikipedia.org/wiki/Variable-length_quantity
 */
// 文件私有函数：没有 export，只被本文件的 serialize/deserialize 使用。
function readIntVQL(reader: IReader): number {
  // value 累积解码结果；n 记录当前字节的数据要左移多少位（每字节 7 个有效位）。
  let value = 0;
  // for 的三个位置都可以留空——这里没有循环条件，靠内部 return 退出。
  for (let n = 0; ; n += 7) {
    // 每次读 1 个字节。
    const next = reader.read(1);
    // `& 0b01111111`：0b 前缀是二进制字面量。与"低 7 位全 1"按位与，
    // 去掉最高位（那是"还有后续字节"的标记位），留下本字节真正的数据；
    // `<< n` 把它挪到该在的位置；`|=` 按位或赋值：把这段数据拼进 value。
    value |= (next.buffer[0] & 0b01111111) << n;
    // `& 0b10000000` 检查最高位：为 0 说明这是最后一个字节，解码完成。
    if (!(next.buffer[0] & 0b10000000)) {
      return value;
    }
  }
}

// 预创建的"数字 0"编码（0 的 VQL 就是单字节 0x00）。
// 它能调用下面才定义的 createOneByteBuffer——因为函数声明会被 JS"提升"到顶部。
const vqlZero = createOneByteBuffer(0);

/**
 * 写入 VQL 编码的整数
 * 例: 0 → [0x00], 127 → [0x7F], 128 → [0x80, 0x01]
 */
// 把整数按 VQL 编码写入。
// 例: 0 → [0x00], 127 → [0x7F], 128 → [0x80, 0x01]
// `=== 0` 用严格相等（推荐写法）：不做类型转换，1 == "1" 为真但 1 === "1" 为假。
function writeInt32VQL(writer: IWriter, value: number): void {
  // 0 是特殊情况：直接复用预创建的 buffer，省一次内存分配。
  if (value === 0) {
    writer.write(vqlZero);
    return;
  }
  // 第一遍循环：`>>> 7` 每轮把数值右移 7 位（丢掉已处理的 7 个低位），
  // 数一数几次能移完，就知道总共需要几个字节。
  let len = 0;
  for (let v = value; v !== 0; v = v >>> 7) {
    len++;
  }

  // 按算好的长度分配，第二遍循环填充内容。
  const scratch = VSBuffer.alloc(len);
  for (let i = 0; value !== 0; i++) {
    // 取低 7 位作为本字节的数据部分。
    scratch.buffer[i] = value & 0b01111111;
    // 右移 7 位，准备处理下一个 7 位组。
    value = value >>> 7;
    // 后面还有数据？给最高位置 1，告诉解码器"还有后续字节"。
    if (value > 0) {
      scratch.buffer[i] |= 0b10000000;
    }
  }
  writer.write(scratch);
}

// ============================================================================
// 数据类型标签
// ============================================================================

// enum（枚举，第一次遇到）：给一组相关常量起名字，比满屏魔法数字可读。
// 这里显式指定数字值——它们会写进二进制协议，两端必须一致，绝不能改。
// 与后面 channels.shared.ts 里 const enum 的区别到那时再讲。
enum DataType {
  Undefined = 0,
  String = 1,
  Buffer = 2,
  VSBuffer = 3,
  Array = 4,
  Object = 5, // JSON fallback
  Int = 6, // VQL 编码的整数
}

// 造一个单字节 buffer：分配 1 字节，把 value 写进第 0 位。
function createOneByteBuffer(value: number): VSBuffer {
  const result = VSBuffer.alloc(1);
  result.writeUInt8(value, 0);
  return result;
}

/** 预创建的类型标签 buffer，避免每次序列化都分配内存 */
// 每种数据类型的"1 字节标签"只造一次、反复复用——热路径上的性能微优化。
const BufferPresets = {
  Undefined: createOneByteBuffer(DataType.Undefined),
  String: createOneByteBuffer(DataType.String),
  Buffer: createOneByteBuffer(DataType.Buffer),
  VSBuffer: createOneByteBuffer(DataType.VSBuffer),
  Array: createOneByteBuffer(DataType.Array),
  Object: createOneByteBuffer(DataType.Object),
  Int: createOneByteBuffer(DataType.Int),
};

// 嵌套二进制的"暗号"：对象字段里出现 Uint8Array 时（见下方 encodeRpcJsonValue），
// 用这个特殊字段名做标记 + base64 文本存数据，让 JSON 能无损携带二进制。
// v1 是版本号：将来格式变了换 v2，两端按版本兼容处理。
const RPC_NESTED_UINT8_ARRAY_MARKER = "__zcode_rpc_nested_uint8array_v1";
const RPC_NESTED_UINT8_ARRAY_BASE64_KEY = "base64";

// ============================================================================
// serialize / deserialize
// ============================================================================

/**
 * 序列化任意数据到 writer。
 *
 * 格式：[1 byte 类型] [VQL 长度(如果需要)] [数据]
 *
 * 每条 RPC 消息 = serialize(header) + serialize(body)
 * header 通常是 [RequestType, id, channelName, methodName]
 * body 是方法参数或返回值
 */
// 序列化入口。参数 data: any 表示"什么类型都收"——序列化层的天然需求。
// 下面是一串 typeof/instanceof 判断链：按数据的**运行时类型**分派编码方式。
export function serialize(writer: IWriter, data: any): void {
  // undefined：只写 1 字节标签，不带数据。
  if (typeof data === "undefined") {
    writer.write(BufferPresets.Undefined);
  } else if (typeof data === "string") {
    // 字符串：标签 + VQL 长度 + UTF-8 字节。读方先读长度，再读那么多字节。
    const buffer = VSBuffer.fromString(data);
    writer.write(BufferPresets.String);
    writeInt32VQL(writer, buffer.byteLength);
    writer.write(buffer);
  } else if (data instanceof VSBuffer) {
    // 二进制（VSBuffer 包装）：与字符串同构——标签 + 长度 + 原始字节。
    writer.write(BufferPresets.VSBuffer);
    writeInt32VQL(writer, data.byteLength);
    writer.write(data);
  } else if (data instanceof Uint8Array) {
    // 裸 Uint8Array：包一层 VSBuffer 后走同样的"标签+长度+字节"路径。
    const buffer = VSBuffer.wrap(data);
    writer.write(BufferPresets.Buffer);
    writeInt32VQL(writer, buffer.byteLength);
    writer.write(buffer);
  } else if (Array.isArray(data)) {
    // 数组：标签 + 元素个数，然后**逐个递归**序列化每个元素
    // （每个元素自带类型标签，所以数组里可以混装任意类型）。
    writer.write(BufferPresets.Array);
    writeInt32VQL(writer, data.length);
    for (const el of data) {
      serialize(writer, el);
    }
  } else if (typeof data === "number" && (data | 0) === data) {
    // `(data | 0) === data` 是经典的"是否为 32 位整数"判定技巧：
    // 按位或 0 会把数截断成 32 位整数，若截断后仍等于自身，说明它本来就是整数
    // （1.5、NaN、超范围大数都通不过）。
    // 整数用 VQL 编码，比 JSON 更紧凑
    writer.write(BufferPresets.Int);
    writeInt32VQL(writer, data);
  } else {
    // 对象字段里的 Uint8Array 之前会被 JSON.stringify 展开成 {"0":...}，
    // 远端 RPC 收到后不再是二进制，skill sync 这类归档传输会在解压阶段失败。
    // 这里保持 Object JSON fallback 的协议形态，只对嵌套 Uint8Array 加标记并在反序列化时恢复。
    const buffer = VSBuffer.fromString(JSON.stringify(data, encodeRpcJsonValue));
    writer.write(BufferPresets.Object);
    writeInt32VQL(writer, buffer.byteLength);
    writer.write(buffer);
  }
}

/**
 * 从 reader 反序列化数据
 */
// 反序列化入口：与 serialize 互为镜像。返回 any——因为具体类型由字节流决定，
// 编译期无从知晓，只能信任写入方的编码。
export function deserialize(reader: IReader): any {
  // 先读 1 字节类型标签，决定后面按什么格式解析。
  const type = reader.read(1).readUInt8(0);

  // switch 按标签分派。每个 case 读数据的顺序必须与 serialize 写入的顺序严格一致。
  switch (type) {
    case DataType.Undefined:
      return undefined;
    case DataType.String:
      // 链式调用：readIntVQL 先读出长度 → read 按长度取字节 → toString 解码。
      return reader.read(readIntVQL(reader)).toString();
    case DataType.Buffer:
      // .buffer 取出内部裸 Uint8Array 返回。
      return reader.read(readIntVQL(reader)).buffer;
    case DataType.VSBuffer:
      return reader.read(readIntVQL(reader));
    case DataType.Array: {
      // case 加 {} 花括号：为该分支开辟独立的块级作用域，
      // 这样在 case 里声明的 const/let 不会与其他 case 的同名变量冲突。
      const length = readIntVQL(reader);
      const result: any[] = [];
      // 逐个递归反序列化——与 serialize 的递归写入一一对应。
      for (let i = 0; i < length; i++) {
        result.push(deserialize(reader));
      }
      return result;
    }
    case DataType.Object:
      // JSON.parse 的第二个参数是 reviver（复活函数）：
      // 解析出的每个键值都会先经过它，见下方 decodeRpcJsonValue。
      return JSON.parse(reader.read(readIntVQL(reader)).toString(), decodeRpcJsonValue);
    case DataType.Int:
      return readIntVQL(reader);
  }
}

// JSON.stringify 的 replacer（替换器）：stringify 时每个值都先过这里，
// 返回什么就真正序列化什么。`_key` 的下划线前缀是惯例：表示"这个参数我用不到"。
// `unknown` 是比 any 安全的"未知类型"：必须先检查才能使用，防止乱来。
function encodeRpcJsonValue(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    // 二进制进不了 JSON（会被展开成 {"0":12,...} 的字典），所以替换成：
    // 一个带暗号标记 + base64 文本的对象。`[常量]:` 是计算属性键——
    // 用常量的**值**当字段名（这里值恰好就是那个字符串），而不是字面上叫 "[常量]"。
    return {
      [RPC_NESTED_UINT8_ARRAY_MARKER]: true,
      [RPC_NESTED_UINT8_ARRAY_BASE64_KEY]: bytesToBase64(value),
    };
  }
  return value;
}

// JSON.parse 的 reviver（复活函数）：parse 时每个值都先过这里，返回什么就最终是什么。
// 与上面的 replacer 互为逆操作。
function decodeRpcJsonValue(_key: string, value: unknown): unknown {
  // 不是我们的暗号对象？原样放行（绝大多数普通值走这条路）。
  if (!isRpcEncodedUint8Array(value)) {
    return value;
  }
  // 是暗号对象：把 base64 文本还原成二进制。
  return base64ToBytes(value[RPC_NESTED_UINT8_ARRAY_BASE64_KEY]);
}

// 类型谓词（第一次遇到）：返回类型写成 `value is {...}` 的布尔函数。
// 意义：只要本函数返回 true，TS 就在后续代码里把 value **当作**花括号里的类型——
// 这是自定义"类型守卫"的标准写法，比到处写 as 断言安全得多。
// 花括号里的类型用常量做属性名，与 encode 侧写出的对象形状精确对应。
function isRpcEncodedUint8Array(value: unknown): value is {
  [RPC_NESTED_UINT8_ARRAY_MARKER]: true;
  [RPC_NESTED_UINT8_ARRAY_BASE64_KEY]: string;
} {
  // 三连排除：不是对象、是 null（typeof null 也是 "object"，经典陷阱）、是数组——都不算。
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  // `as Record<string, unknown>`：类型断言（第一次遇到）——
  // 告诉编译器"我比它更清楚，把它当作'键为字符串、值为未知'的字典来用"。
  // 注意：断言不做任何运行时转换，只是绕过编译器检查，用错了要自己负责。
  const record = value as Record<string, unknown>;
  // 严格校验暗号：标记为 true、base64 字段是字符串、且**恰好只有这两个字段**
  // （防止用户的普通对象恰好带同名字段时被误伤）。
  return (
    record[RPC_NESTED_UINT8_ARRAY_MARKER] === true &&
    typeof record[RPC_NESTED_UINT8_ARRAY_BASE64_KEY] === "string" &&
    Object.keys(record).length === 2
  );
}

// 字节 → base64 文本。base64 是把任意二进制编码成纯 ASCII 字符串的方案，
// 只有变成字符串才能塞进 JSON。实现分两条路：有 Node Buffer 用 Buffer，否则用浏览器 API。
function bytesToBase64(bytes: Uint8Array): string {
  // globalThis：跨环境的"全局对象"（浏览器 window、Node global 的统一写法）。
  // `globalThis as {...}` 结构化断言：告诉 TS "全局上可能存在一个可选的 Buffer"，
  // 并描述它的形状（from 接收字节、toString 支持 base64）——
  // 这样既能在 Node 里安全使用，又不会让浏览器端的类型检查报错。
  const bufferCtor = (
    globalThis as {
      Buffer?: {
        from(input: Uint8Array): { toString(encoding: "base64"): string };
      };
    }
  ).Buffer;
  // Node 环境路：Buffer 自带 base64 编解码，一步到位。
  if (bufferCtor) {
    return bufferCtor.from(bytes).toString("base64");
  }

  // 浏览器环境路：btoa 只接受"每个字符码位都在 0~255 的二进制字符串"，
  // 所以先把字节逐个转成字符拼起来。0x8000 = 32768：分块处理，防止超大数组
  // 一次性展开撑爆调用栈（`...chunk` 是展开运算符传参，见 foundation 的说明）。
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    // subarray 与 slice 类似但**共享内存不复制**——这里只是临时视图，安全。
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

// base64 文本 → 字节。同样 Node / 浏览器两条路，与上一个函数互为逆操作。
function base64ToBytes(base64: string): Uint8Array {
  const bufferCtor = (
    globalThis as {
      Buffer?: {
        from(input: string, encoding: "base64"): Uint8Array;
      };
    }
  ).Buffer;
  if (bufferCtor) {
    // Node 路：Buffer.from 解码 base64，再包一层 Uint8Array 统一返回类型。
    return new Uint8Array(bufferCtor.from(base64, "base64"));
  }

  // 浏览器路：atob 解出"二进制字符串"，再逐字符取码位填进字节数组。
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  // charCodeAt：取字符串第 index 个字符的码位（0~255），正好对应一个字节。
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
