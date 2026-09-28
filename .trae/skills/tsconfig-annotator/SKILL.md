---
name: tsconfig-annotator
description: 给 tsconfig.json 等 JSONC 配置文件逐行添加面向 TS 初学者的原理级中文注释（前置概念、是什么、为什么、代码示例四层），并用解析器验证文件不被注释破坏。用户要求给 tsconfig、编译配置逐行加注释或讲解配置原理时使用；不用于修改配置值或编写业务代码。
---

# tsconfig 原理级中文注释

为 TypeScript 配置文件（tsconfig.base.json、各包 tsconfig.json、tsconfig.*.json 等）添加「小白能看懂原理」的中文注释。只加注释，绝不改动任何配置值、键名、include/exclude/references 内容。

## 触发场景

- 用户要求给 tsconfig.json / tsconfig.base.json / tsconfig.*.json 逐行加注释、作用说明
- 用户反馈现有注释「不够详细、不懂原理」，要求面向新手重写注释
- 用户要求批量给 monorepo 内所有包的 tsconfig 加注释

## 工作流程

### 1. 先调查，不动笔

1. 用 Glob 找全目标文件，例如 `**/tsconfig*.json`，向用户确认总数。
2. 逐个 Read，记录三类信息：
   - 每个配置项的实际取值（注释必须与取值一致，不能照抄模板）；
   - 已有注释，特别是中文 bug 修复注释——按仓库 AGENTS.md 要求必须原样保留，只能增补不能删除或改写其含义；
   - 文件角色（基座 / 解决方案入口 files:[] / 浏览器端 / Node 端 / 纯类型包 emitDeclarationOnly 等），注释要点出该角色。
3. 用 TodoWrite 按目录分批（主 workspace、desktop、apps/zcode-cli），每批写完即落盘。

### 2. 注释四层规范

基座文件（被 extends 的那个）在文件头用横幅注释补齐前置概念，子包文件不需要重复大段概念，注释其覆盖项即可。

**文件头概念（仅基座文件）**，用 `// ===` 横幅分节，讲清读者不懂的前置知识：

- TS 与 JS 的关系、编译在做什么、类型运行时被擦除；
- tsconfig.json 是编译器说明书，JSONC 原生支持 `//` 注释；
- 本文件是基座，子包通过 extends 继承再覆盖。

**每个选项的注释按四层写，缺一不可的是后三层**：

1. 是什么：一句话白话定义，先给结论；
2. 为什么需要：历史背景或底层原理（如 CommonJS 与 ESM 的默认导出矛盾、单文件转译看不到跨文件类型、.d.ts 类比 .h 头文件）；
3. 代码示例：给出「开启后正确写法」和「不开启/写错时的报错写法」对照，示例用真实 TS 代码；
4. 取值相关的具体后果：说明 true/false 或该取值在本仓库的实际影响。

相关选项用 `// ---` 横幅分组（如「模块系统」「声明文件与 sourceMap」「工程引用」「单文件转译约束」），组前用两三行讲该组共同背景。

写作要求：

- 简体中文；专有名词保留英文（ESM、CommonJS、NodeNext、Bundler、.d.ts、.tsbuildinfo）；
- 讲事实，不堆砌「重要」「注意」等空泛词；拿不准的选项含义查 TypeScript 官方文档，不臆测；
- 子包特有取值必须解释「为什么和基座不同」，例如浏览器端包 lib 加 DOM、moduleResolution 用 Bundler、noEmit 配 Vite；
- 注释加在对应键的上一行；数组/对象整体一条注释即可，不为括号加注释。

### 3. 不可违反的边界

- 只加注释与横幅空行；任何配置值、JSON 结构都不许变；
- 已有中文修复注释原样保留（AGENTS.md 硬性要求）；
- 不创建额外文档文件，不改教程/docs，除非用户另行要求；
- 文件较多时沿目录分批写入，每批并行 Write，避免单次上下文过载。

### 4. 验证（必做）

注释可能破坏 JSON（漏逗号、多逗号、中文引号、`/* */` 误嵌套）。写完每批后用仓库内 TypeScript 解析器验证。本机终端 PATH 中没有 node/npx，使用 bun：

```powershell
bun -e "const ts=require('d:/学习文件/zcode/ZCode/node_modules/typescript');const root='d:/学习文件/zcode/ZCode/';const files=['tsconfig.base.json','packages/xxx/tsconfig.json'];let fail=0;for(const f of files){const cfg=ts.readConfigFile(root+f,ts.sys.readFile);if(cfg.error){fail++;console.log('ERROR '+f+': '+ts.flattenDiagnosticMessageText(cfg.error.messageText,' '))}}console.log(fail===0?('ALL PARSE OK ('+files.length+' files)'):(fail+' FAILED'))"
```

全部输出 `ALL PARSE OK` 才算完成；有 ERROR 立即修复对应文件并重跑。对基座文件额外打印 `Object.keys(config.compilerOptions)` 核对配置项数量与改动前一致。

### 5. 汇报

用表格按批次汇总文件数与每个文件的角色特点，说明验证方式与结果；如实报告未覆盖或未验证的文件。
