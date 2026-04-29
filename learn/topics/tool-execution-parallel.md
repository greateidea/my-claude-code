# Claude Code 工具调用机制深度分析

## 1. 工具调用的核心入口

### 文件位置
- `src/services/tools/toolOrchestration.ts` - 核心编排逻辑
- `src/services/tools/toolExecution.ts` - 单工具执行
- `src/query.ts` - 查询入口

### 调用链
```
query.ts
  ↓
runTools(toolUseBlocks, ...)
  ↓
toolOrchestration.ts
  ├─ partitionToolCalls()  // 决定并行/串行
  ├─ runToolsConcurrently() // 并行执行
  └─ runToolsSerially()    // 串行执行
```

---

## 2. 并行 vs 串行的决策机制

### 核心函数: `partitionToolCalls()`

```typescript
// src/services/tools/toolOrchestration.ts:91-116
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    // 关键：检查工具是否实现 isConcurrencySafe
    const isConcurrencySafe = parsedInput?.success
      ? Boolean(tool?.isConcurrencySafe(parsedInput.data))
      : false

    // 如果当前工具安全且前一个批次也安全，合并到同一批次（并行）
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      // 否则创建新批次（串行）
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
```

### 决策逻辑图

```
┌─────────────────────────────────────────────────────────────┐
│                  工具调用决策流程                            │
├─────────────────────────────────────────────────────────────┤
│  输入: ToolUseBlock[]                                       │
│    ↓                                                         │
│  partitionToolCalls()                                       │
│    ↓                                                         │
│  For each toolUse:                                          │
│    ├─ 找到工具定义                                           │
│    ├─ 解析输入参数                                          │
│    ├─ 调用 tool.isConcurrencySafe(input)                   │
│    │         ↓                                              │
│    │    YES ─→ 添加到当前并行批次                           │
│    │    NO  ─→ 结束当前批次，创建新串行批次                  │
│    ↓                                                         │
│  输出: Batch[] (isConcurrencySafe + blocks)                │
│    ↓                                                         │
│  For each batch:                                            │
│    ├─ isConcurrencySafe=true → runToolsConcurrently()     │
│    └─ isConcurrencySafe=false → runToolsSerially()        │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 工具的 isConcurrencySafe 实现

### 并行安全 (isConcurrencySafe = true)

| 工具 | 代码位置 | 说明 |
|------|----------|------|
| **FileReadTool** | FileReadTool.ts:373 | 只读操作，无副作用 |
| **GlobTool** | GlobTool.ts:76 | 只读搜索 |
| **GrepTool** | GrepTool.ts:183 | 只读搜索 |
| **WebSearchTool** | WebSearchTool.ts:92 | 只读 API 调用 |
| **WebFetchTool** | WebFetchTool.ts:95 | 只读网络请求 |
| **TaskListTool** | TaskListTool.ts:56 | 只读任务列表 |

### 串行安全 (isConcurrencySafe = false 或 未实现)

| 工具 | 代码位置 | 说明 |
|------|----------|------|
| **BashTool** | BashTool.tsx | 执行任意命令，有副作用 |
| **FileWriteTool** | FileWriteTool.ts | 写入文件，有副作用 |
| **FileEditTool** | FileEditTool.ts | 修改文件，有副作用 |
| **McpAuthTool** | McpAuthTool.ts:67 | `isConcurrencySafe: false` |

---

## 4. 批量执行策略

### 并行执行 (runToolsConcurrently)

```typescript
// src/services/tools/toolOrchestration.ts:152-177
async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  ...
): AsyncGenerator<MessageUpdateLazy, void> {
  // 使用 all() 组合器，限制最大并发数为 10
  yield* all(
    toolUseMessages.map(toolUse => runToolUse(toolUse, ...)),
    getMaxToolUseConcurrency()  // 默认 10，可通过环境变量配置
  )
}
```

### 串行执行 (runToolsSerially)

```typescript
// src/services/tools/toolOrchestration.ts:118-150
async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  ...
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext

  for (const toolUse of toolUseMessages) {
    // 依次执行每个工具
    for await (const update of runToolUse(toolUse, ...)) {
      yield { message: update.message, newContext: currentContext }
    }
    // 标记完成
    markToolUseAsComplete(toolUseContext, toolUse.id)
  }
}
```

---

## 5. 实际执行流程示例

### 场景: 用户请求读取多个文件 + 写入一个文件

**输入**: [Read(file1), Read(file2), Write(file3)]

**处理流程**:

```
1. partitionToolCalls()
   ├─ Read(file1): isConcurrencySafe=true → 加入并行批次A
   ├─ Read(file2): isConcurrencySafe=true → 加入并行批次A
   └─ Write(file3): isConcurrencySafe=false → 创建串行批次B

   结果: [BatchA(isConcurrencySafe=true, [Read, Read]), 
          BatchB(isConcurrencySafe=false, [Write])]

2. 执行 BatchA (并行)
   → runToolsConcurrently([Read, Read])
   → 两个 Read 同时执行

3. 执行 BatchB (串行)  
   → runToolsSerially([Write])
   → Write 单独执行
```

---

## 6. 关键设计决策

### 6.1 为什么 Read 可以并行？

1. **只读操作**：不会修改系统状态
2. **无副作用**：多个读取不会相互影响
3. **I/O 优化**：并行读取减少等待时间

### 6.2 为什么 Write/Bash 必须串行？

1. **有状态修改**：写入文件可能影响后续操作
2. **潜在冲突**：并发写入可能导致文件损坏
3. **结果依赖**：后续操作可能依赖前一个结果

### 6.3 并发数限制

```typescript
function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
  )
}
```
- 默认最大 10 个并发
- 可通过环境变量 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 配置

---

## 7. 与我们的实现对比

| 方面 | Claude Code | 我们的实现 |
|------|------------|-----------|
| **并行/串行决策** | `isConcurrencySafe()` 方法 | 无 |
| **并发控制** | `all()` 组合器 + 最大并发数 | 无 |
| **只读工具** | 自动识别并行 | 无区分 |
| **写工具** | 强制串行 | 无区分 |

---

## 8. 总结

Claude Code 的工具执行策略：

1. **智能分区**：通过 `isConcurrencySafe` 判断工具是否可并行
2. **批量处理**：将连续的只读工具合并为并行批次
3. **安全优先**：有副作用的工具（Write, Bash）强制串行
4. **可配置**：并发数可调整

这解释了：
- 为什么多个 Read 可以同时执行
- 为什么 Write 必须等待 Read 完成
- 为什么 Bash 总是串行执行