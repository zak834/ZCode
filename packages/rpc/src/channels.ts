// "桶文件"（barrel）：把本包的公开成员统一从一个入口再导出。
// 外部只需要 `import { ... } from "./channels.js"` 一个路径，
// 不用关心内部拆了几个文件——内部怎么重构都不影响外部调用方。
// `export *`：把 channels.shared 导出的所有成员原样再导出。
export * from "./channels.shared.js";
export { ChannelServer } from "./channelServer.js";
export { ChannelClient } from "./channelClient.js";
export { getDelayedChannel } from "./delayedChannel.js";
