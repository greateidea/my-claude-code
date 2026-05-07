# Edit 和 Grep 工具深度分析

## 1. 为什么需要这两个工具？

当前我们拥有 5 个工具：bash、Read、Write、Glob、calculate。但 Claude Code 有两个额外核心工具，是让 LLM 高效操作代码的关键：

| 场景 | 没有 Edit/Grep | 有 Edit/Grep |
|------|---------------|--------------|
| 改一个函数名 | Read 整个文件 → LLM 输出完整新文件 → Write 整个文件 | Edit(old_string, new_string) 精确替换 |
| 改 3 处同样的问题 | 同上 ×3 次完整读写 | Edit 三次 或 replace_all 一次搞定 |
| 搜索代码中所有使用某 API 的地方 | 写 bash 命令 `grep -r` 或用 Glob 盲猜 | Grep(pattern, glob) 精确搜索 |
| 重构影响范围分析 | LLM 猜测 | Grep 搜索结果驱动 |

**核心优势：**
- **Edit**：省 token （只传 diff，不传整个文件）、速度快、保留文件原有格式
- **Grep**：专用代码搜索，比 bash grep 更可控、更安全、输出更结构化

---

## 2. Edit 工具

### 2.1 核心概念

Edit 不是"编辑文件"，而是**精确字符串替换**。你给一段旧文本和一段新文本，工具在原文件中找到旧文本，替换为新文本。

```
文件内容:  ABCDE
Edit(old_string="BCD", new_string="XY")
结果:      AXYE
```

### 2.2 Claude Code 的 Edit 工具定义

```typescript
// src/services/tools/FileEditTool.ts (精简)

export const FileEditTool = {
  name: 'Edit',
  description: `Performs exact string replacements in files.

Usage:
- You must use your Read tool at least once in the conversation before editing.
  This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation
  (tabs/spaces) as it appears AFTER the line number prefix.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless
  explicitly required.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger
  string with more surrounding context to make it unique or use replace_all.
- Use replace_all for replacing and renaming strings across the file.`,

  inputSchema: {
    file_path: z.string().describe('The absolute path to the file to modify'),
    old_string: z.string().describe('The text to replace'),
    new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
    replace_all: z.boolean().optional().describe(
      'Replace all occurrences of old_string (default false)',
    ),
  },

  isConcurrencySafe: () => false, // 写操作，必须串行
}
```

### 2.3 执行流程

```
Edit(file_path, old_string, new_string, replace_all?)
    │
    ├─ 1. 安全检查：验证 file_path 是绝对路径
    ├─ 2. 检查是否已读过文件（Read tool history）
    │       如果没读过 → 返回错误提示
    ├─ 3. 读取文件内容
    ├─ 4. 检查 old_string 是否存在于文件中
    │       ├─ 不存在 → 返回错误 "old_string not found"
    │       ├─ 存在但有多处匹配 → 返回错误，提示用 replace_all 或增加上下文
    │       └─ 存在且唯一 → 继续
    ├─ 5. 执行替换（replace_all: 替换所有匹配）
    ├─ 6. 写入文件
    └─ 7. 返回成功信息（含替换次数）
```

### 2.4 关键设计决策

#### 2.4.1 为什么要求先 Read 再 Edit？

```
❌ 不安全：LLM 猜测文件内容 → 可能猜错 old_string
✅ 安全：LLM 先 Read 看到真实文件 → old_string 一定有精确匹配

这是 Claude Code 的一个常见错误修复点：
用户抱怨 "Edit tool failed because old_string not found"
根本原因：LLM 在没读文件的情况下凭记忆编辑
```

Claude Code 中的实现：Edit 工具检查 `toolUseContext.readFileHistory` ——记录了本次会话中哪些文件被读过。

#### 2.4.2 为什么 old_string 必须唯一？

```
文件:
  function foo() { ... }
  // more code
  function foo() { ... }  ← 两个地方都有，不确定改哪个

Edit("function foo()", "function bar()")
→ 错误："old_string is not unique in file. Add more context to make it unique."

Edit("function foo() { ... }\n  // more code\n  function foo()", "function bar()")
→ 成功，包含了足够上下文使 old_string 唯一
```

#### 2.4.3 replace_all 模式

```
文件有多处 "useState" 需要改为 "useSignal":

Edit("useState", "useSignal", replace_all=true)
→ 一次性替换文件中所有的 useState → useSignal
```

### 2.5 边界情况

| 场景 | 行为 |
|------|------|
| 文件不存在 | 返回错误 |
| old_string 为空 | 返回错误 |
| old_string === new_string | 返回错误（无意义的编辑） |
| 路径是相对路径 | 返回错误（要求绝对路径）|
| 文件未读就编辑 | 返回错误，提示先 Read |
| Tab vs Space 不匹配 | 匹配失败，因为 Claude Code Read 输出带行号前缀 |

### 2.6 与 Write 工具的区别

| | Edit | Write |
|------|------|-------|
| 操作方式 | 精确替换片段 | 覆盖整个文件 |
| Token 消耗 | 只传 diff 片段 | 传整个文件内容 |
| 格式保留 | 天然保留 | 依赖 LLM 准确复现 |
| 适用场景 | 修改现有代码 | 创建新文件、完全重写 |
| 安全性 | 高（验证 old_string 存在） | 低（直接覆盖） |
| 并发安全 | false（写操作） | false（写操作） |

### 2.7 我们的简化实现方案

由于我们是学习项目，可以做以下简化：

1. **跳过 Read-first 检查** — 不做 readFileHistory 追踪，依赖 LLM 自觉
2. **跳过符号链接处理** — 不做 symlink 解析
3. **跳过保护目录** — 不做 .git 等特殊目录保护（权限系统已处理）
4. **保留**：唯一性检查、replace_all、绝对路径验证、old_string===new_string 检查

```typescript
// 简化版 Edit 工具
export const EditTool: Tool = {
  name: 'Edit',
  description: `Performs exact string replacements in files.
Usage:
- The edit will FAIL if old_string is not unique in the file.
  Either provide a larger string with more surrounding context to make it unique or use replace_all.
- Use replace_all for replacing and renaming strings across the file.`,
  inputSchema: {
    file_path: z.string().describe('The absolute path to the file to modify'),
    old_string: z.string().describe('The text to replace'),
    new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
    replace_all: z.boolean().optional().describe('Replace all occurrences of old_string (default false)'),
  },
  execute: async ({ file_path, old_string, new_string, replace_all }) => {
    // 1. 绝对路径检查
    if (!file_path.startsWith('/')) {
      return "Error: file_path must be an absolute path"
    }
    // 2. 参数检查
    if (!old_string) return "Error: old_string must not be empty"
    if (old_string === new_string) return "Error: old_string and new_string must be different"
    // 3. 读文件
    const content = await readFile(file_path, 'utf-8')
    // 4. 匹配 old_string
    const count = content.split(old_string).length - 1
    if (count === 0) return "Error: old_string not found in file"
    if (count > 1 && !replace_all) {
      return `Error: old_string appears ${count} times in file. Use replace_all=true or add more context.`
    }
    // 5. 替换
    const newContent = replace_all
      ? content.replaceAll(old_string, new_string)
      : content.replace(old_string, new_string)
    // 6. 写回
    await writeFile(file_path, newContent, 'utf-8')
    return `Successfully replaced ${replace_all ? count : 1} occurrence(s)`
  },
  ...writeTool(),
}
```

---

## 3. Grep 工具

### 3.1 核心概念

Grep 是代码内容搜索工具。跟 Glob（文件名搜索）形成互补：**Glob 按文件名找，Grep 按内容找**。

底层使用 ripgrep（`rg`），性能远优于传统 `grep -r`。

### 3.2 Claude Code 的 Grep 工具定义

```typescript
// src/services/tools/GrepTool.ts (精简)

export const GrepTool = {
  name: 'Grep',
  description: `A powerful search tool built on ripgrep.

Usage:
- ALWAYS use Grep for search tasks. NEVER invoke grep or rg as a Bash command.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default),
  "count" shows match counts
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\`
  to find \`interface{}\` in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns
  like \`struct \\{[\\s\\S]*?field\`, use multiline: true`,

  inputSchema: {
    pattern: z.string().describe('The regular expression pattern to search for'),
    path: z.string().optional().describe('File or directory to search in. Defaults to cwd.'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
    output_mode: z.enum(['content','files_with_matches','count']).optional().describe(
      'Output mode. Default: files_with_matches. "content" shows matching lines.',
    ),
    '-i': z.boolean().optional().describe('Case insensitive search'),
    '-n': z.boolean().optional().describe('Show line numbers (default true for content mode)'),
    head_limit: z.number().optional().describe(
      'Limit output to first N lines/entries. Default 250. Set to 0 for unlimited.'
    ),
    multiline: z.boolean().optional().describe(
      'Enable multiline mode where . matches newlines. Default false.'
    ),
  },

  isConcurrencySafe: () => true, // 只读操作，可并行
}
```

### 3.3 底层实现

Claude Code 的 Grep 直接调用 ripgrep 进程：

```typescript
async function executeGrep(params: GrepParams): Promise<string> {
  const args: string[] = ['--no-heading', '--with-filename']

  if (params.output_mode === 'files_with_matches' || !params.output_mode) {
    args.push('-l') // 只输出文件名
  }
  if (params.output_mode === 'count') {
    args.push('-c') // 输出计数
  }
  if (params['-i']) args.push('-i')
  if (params['-n'] !== false) args.push('-n')
  if (params.multiline) {
    args.push('--multiline', '--multiline-dotall')
  }
  if (params.glob) {
    args.push('--glob', params.glob)
  }

  args.push('--', params.pattern, params.path || '.')

  const result = await execFileAsync('rg', args, {
    timeout: 10000,
    maxBuffer: 10 * 1024 * 1024,
  })

  let output = result.stdout
  if (params.head_limit && params.head_limit > 0) {
    output = output.split('\n').slice(0, params.head_limit).join('\n')
  }

  return output || 'No matches found'
}
```

### 3.4 输出模式详解

```
假设在 src/ 中有：
  src/App.tsx:  import React from 'react'
  src/App.tsx:  export default function App() {
  src/utils.ts: import { useState } from 'react'

Grep(pattern="import", output_mode="files_with_matches"):
  → src/App.tsx
  → src/utils.ts

Grep(pattern="import", output_mode="content"):
  → src/App.tsx:1: import React from 'react'
  → src/utils.ts:1: import { useState } from 'react'

Grep(pattern="import", output_mode="count"):
  → src/App.tsx: 1
  → src/utils.ts: 1
```

### 3.5 与 Bash grep 的区别

为什么 Claude Code 坚持用专用的 Grep 工具而不是让 LLM 写 `grep -r` 命令？

| | Grep 工具 | Bash grep |
|------|-----------|------------|
| 权限 | 只读，自动允许 | 需要通过 Bash 权限 |
| 参数验证 | Type-safe，拒绝危险参数 | 可能注入恶意参数 |
| 超时控制 | 内置 timeout | 需要手动设置 |
| 输出大小 | head_limit 自动截断 | 可能输出过大 |
| 错误处理 | TypeScript try/catch | shell 错误码 |
| 跨平台 | ripgrep 统一接口 | grep/ripgrep 差异 |

### 3.6 我们的简化实现方案

```typescript
export const GrepTool: Tool = {
  name: 'Grep',
  description: `A powerful search tool built on ripgrep.
Usage:
- ALWAYS use Grep for search tasks. NEVER invoke grep or rg as a Bash command.
- Supports full regex syntax
- Filter files with glob parameter (e.g. "*.js", "**/*.tsx")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default),
  "count" shows match counts`,
  inputSchema: {
    pattern: z.string().describe('The regular expression pattern to search for'),
    path: z.string().optional().describe('File or directory to search in. Defaults to cwd.'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js")'),
    output_mode: z.string().optional().describe(
      'Output mode: "content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts'
    ),
    '-i': z.boolean().optional().describe('Case insensitive search'),
    head_limit: z.number().optional().describe('Limit output to first N entries (default 250)'),
  },
  execute: async ({ pattern, path, glob, output_mode, '-i': caseInsensitive, head_limit = 250 }) => {
    try {
      const args: string[] = ['--no-heading', '--with-filename']

      const mode = output_mode || 'files_with_matches'
      if (mode === 'files_with_matches') args.push('-l')
      if (mode === 'count') args.push('-c')
      if (caseInsensitive) args.push('-i')
      if (glob) args.push('--glob', glob)
      if (mode === 'content') args.push('-n')

      args.push('--', pattern, path || '.')

      const result = await execFileAsync('rg', args, {
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
      })

      let output = result.stdout.trim()
      if (head_limit > 0 && output) {
        output = output.split('\n').slice(0, head_limit).join('\n')
      }

      return output || 'No matches found'
    } catch (e: any) {
      if (e.code === 1) return 'No matches found' // rg returns 1 for no matches
      if (e.code === 'ENOENT') return 'Error: ripgrep (rg) not installed. Please install ripgrep.'
      return `Error: ${e.message}`
    }
  },
  ...readOnlyTool(),
}
```

---

## 4. 工具分类总览

加上 Edit 和 Grep 后，我们的工具矩阵更新为：

| 工具 | 类型 | 并发安全 | 功能 |
|------|------|---------|------|
| Read | 只读 | ✅ 并行 | 读取文件内容 |
| Write | 写入 | ❌ 串行 | 创建/覆盖文件 |
| **Edit** | **写入** | **❌ 串行** | **精确字符串替换** |
| Glob | 只读 | ✅ 并行 | 文件名模式搜索 |
| **Grep** | **只读** | **✅ 并行** | **文件内容正则搜索** |
| Bash | 写入 | ❌ 串行 | 执行 shell 命令 |
| calculate | 只读 | ✅ 并行 | 数学计算 |

这样一来，**代码检索**（Glob + Grep + Read）形成完整闭环，**代码修改**（Edit + Write）各有分工。

---

## 5. 总结

| | Edit | Grep |
|------|------|------|
| 作用 | 精确字符串替换 | 代码内容搜索 |
| 类比 | 精准手术刀 | 代码探测器 |
| 底层 | Node.js fs | ripgrep (rg) |
| 比 Bash 好在哪里 | 不用传全文，token 省 | 权限自动放行，参数安全 |
| 关键设计 | old_string 唯一性检查 | 多种输出模式 |
| 简化点 | 跳过了 read-first 检查 | 跳过了 type 参数、multiline |
