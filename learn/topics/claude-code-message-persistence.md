# Claude Code 消息持久化系统 — 深度分析

## 一、概述

Claude Code 的消息持久化系统负责保存和恢复对话历史。它不是简单地 `JSON.stringify(全部消息)` 存成一个文件，而是采用了**追加式 JSONL + 树状消息结构 + 写入队列批处理**的架构。核心实现在 `src/utils/sessionStorage.ts`（~3500 行）。

这套设计解决了几个核心问题：崩溃恢复、对话分支、子代理隔离、文件历史撤销、大文件 OOM 防护。

## 二、存储布局

### 2.1 完整目录结构

```
~/.claude/
├── sessions/<pid>.json                            # 会话元数据（按进程 PID 索引）
├── history.jsonl                                  # Shell 命令历史（跨项目全局）
├── projects/
│   └── <project-hash>/
│       ├── <session-id>.jsonl                     # ★ 完整对话记录（JSONL 追加式）
│       ├── <session-id>/                          # 会话资产目录
│       │   ├── subagents/
│       │   │   ├── <agent-id>.jsonl               # 子代理对话
│       │   │   └── <agent-id>.meta.json           # 子代理元数据
│       │   └── tool-results/                      # 缓存的工具输出
│       └── memory/                                # 记忆系统（独立子系统）
├── file-history/<session-id>/                     # 文件快照（用于撤销编辑）
├── backups/                                       # 编辑前的文件备份
└── debug/<session-id>/                            # 调试日志
```

### 2.2 Project Hash 算法与路径

```typescript
// src/utils/sessionStorage.ts:436-438
export const getProjectDir = memoize((projectDir: string): string => {
  return join(getProjectsDir(), sanitizePath(projectDir))
})

// src/utils/sessionStorage.ts:198-200
export function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

// src/utils/sessionStorage.ts:202-205
export function getTranscriptPath(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}
```

`sanitizePath` 将 `/Users/bigorange/my-project` 转换为 `-Users-bigorange-my-project`（和我们项目的实现一致）。`getProjectDir` 被 `memoize` 包裹，同一 `cwd` 只计算一次。

`getTranscriptPath` 有 `getSessionProjectDir` 的回退路径：当 `--resume` 切换到另一个项目的会话时，使用该会话实际所在的目录而不是当前 cwd。

## 三、会话元数据层：`sessions/<pid>.json` 的真相

### 3.1 纠正一个常见误解

`sessions/<pid>.json` **不是对话恢复的核心机制**。它是一个**进程注册表（process registry）**，解决的问题是「现在有几个 Claude Code 进程在运行？」。真正的对话恢复靠的是 `projects/<hash>/<sessionId>.jsonl`。

两者的分工：

| | `sessions/<pid>.json` | `projects/<hash>/<sessionId>.jsonl` |
|---|---|---|
| **角色** | 进程注册表 | 对话持久化 |
| **回答的问题** | 哪些会话正在运行？ | 会话里说了什么？ |
| **索引键** | 进程 PID | 会话 UUID |
| **数据内容** | pid, sessionId, cwd, kind, startedAt | user/assistant/tool_result 消息链 + 元数据 |
| **生命周期** | 进程启动创建，正常退出删除 | 会话创建后持久保留 |
| **消费方** | `claude ps`、并发检测 | `--continue`、`--resume` |

### 3.2 Sessions 目录：进程注册表

`~/.claude/sessions/<pid>.json` 内容（来自 `concurrentSessions.ts:59-108` `registerSession()`）：

```json
{
  "pid": 35858,
  "sessionId": "461ee844-d946-486a-81b5-448b3f0d1a18",
  "cwd": "/Users/bigorange/nodecode/my-claude-code",
  "startedAt": 1777544302736,
  "kind": "interactive",
  "entrypoint": "cli"
}
```

`kind` 字段的取值（来自 `concurrentSessions.ts:18`）：

```typescript
type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
```

**写入时机（启动时）：**

```typescript
// concurrentSessions.ts:59-108
export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false  // 子代理不注册

  const kind: SessionKind = envSessionKind() ?? 'interactive'
  const dir = getSessionsDir()
  const pidFile = join(dir, `${process.pid}.json`)

  // 注册退出清理 — 正常退出时删除 PID 文件
  registerCleanup(async () => {
    try { await unlink(pidFile) } catch { /* ENOENT is fine */ }
  })

  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(pidFile, jsonStringify({
    pid: process.pid,
    sessionId: getSessionId(),
    cwd: getOriginalCwd(),
    startedAt: Date.now(),
    kind,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
  }))

  // --resume 切换 sessionId 时，同步更新 PID 文件
  onSessionSwitch(id => { void updatePidFile({ sessionId: id }) })
  return true
}
```

**删除时机（正常退出）：**

```
进程退出 → registerCleanup handler 触发 → unlink(sessions/<pid>.json) → 文件消失
```

**孤儿检测时机（`countConcurrentSessions`，`concurrentSessions.ts:168-204`）：**

```typescript
// 扫描 sessions/ 目录，统计并发会话数，顺便清理孤儿
export async function countConcurrentSessions(): Promise<number> {
  const files = await readdir(getSessionsDir())
  let count = 0
  for (const file of files) {
    // 严格文件名检查：只匹配 <pid>.json
    // 防止 2026-03-14_notes.md 被 parseInt 误解析为 PID 2026（#34210）
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === process.pid) {
      count++  // 自己
    } else if (isProcessRunning(pid)) {
      count++  // 活着的并发会话
    } else if (getPlatform() !== 'wsl') {
      // 孤儿 — 进程不存在，删除残留文件
      // WSL 跳过：Windows PID 无法从 WSL 探测
      void unlink(join(dir, file)).catch(() => {})
    }
  }
  return count
}
```

### 3.3 所以「崩溃恢复」实际走了两条路

```
终端意外关闭，进程被杀死
  │
  ├─→ sessions/<pid>.json 残留
  │     └─→ 下次 claude ps 或启动时，countConcurrentSessions() 检测到孤儿
  │         └─→ 清理残留文件（或提示用户有未正常退出的会话）
  │
  └─→ projects/<hash>/<sessionId>.jsonl 完好无损（JSONL 追加式的优势）
        └─→ 用户执行 --continue 或 --resume <sessionId>
            └─→ loadConversationForResume() 加载 JSONL
                └─→ processResumedConversation() 恢复完整状态
```

**关键洞察：PID 文件和 JSONL 在崩溃恢复中各自承担不同的责任。** PID 文件负责「检测到崩溃发生过」，JSONL 负责「恢复崩溃前的对话内容」。两者通过 `sessionId` 字段关联。

### 3.4 `--continue` / `--resume` 的实际恢复流程

**`--continue`（恢复最近会话）：**

```typescript
// conversationRecovery.ts:459-549 → loadConversationForResume(undefined, ...)
// 1. loadMessageLogs() → 列出项目中所有 JSONL 文件，按时间排序
// 2. 跳过正在运行的 bg/daemon 会话（它们正活跃写入自己的 JSONL）
// 3. 取最近的一个 log
// 4. loadTranscriptFile(jsonl路径) → 读取完整对话
// 5. buildConversationChain(byUuid, tip) → 从叶子节点回溯构建消息链
// 6. removeExtraFields() → 去掉内部字段
```

**`--resume <sessionId>`（恢复指定会话）：**

```typescript
// conversationRecovery.ts:459-549 → loadConversationForResume(sessionId, ...)
// 同上，但按 sessionId 定位 JSONL 而非取「最近的」
// 还支持 --resume <path/to/session.jsonl> 直接指定 JSONL 路径
```

### 3.5 `processResumedConversation` 恢复了什么

从 `sessionRestore.ts:409-551`，**恢复 9 种状态**：

| 恢复内容 | 来源 | 说明 |
|---------|------|------|
| **对话消息** | JSONL 中的 transcript messages | user/assistant/tool_result 完整链 |
| **Session ID** | JSONL 中消息的 sessionId | `switchSession()` 切换当前会话 |
| **会话元数据** | JSONL 末尾的 metadata 行 | customTitle, tag, agentName |
| **Agent 定义** | JSONL 中的 agentSetting | 恢复到上次用的 custom agent + model |
| **Worktree 目录** | JSONL 中的 worktree 记录 | `process.chdir()` 切回 worktree |
| **文件历史快照** | JSONL 中的 file-history 条目 | 支持撤销编辑 |
| **归属状态** | JSONL 的 attribution-snapshot | 记录代码归属（ant 功能） |
| **上下文折叠** | JSONL 的 context-collapse | compact 后的对话摘要 |
| **Todo 列表** | JSONL 中最后一个 TodoWrite tool_use | 从对话提取恢复 |

```typescript
// sessionRestore.ts:409-551 processResumedConversation() 核心流程：
// 1. matchSessionMode() → 匹配 coordinator/normal 模式
// 2. switchSession(sid) → 切换到恢复的 session ID
// 3. restoreSessionMetadata() → 恢复标题、标签、agent 等
// 4. restoreWorktreeForResume() → cd 回 worktree 目录
// 5. adoptResumedSessionFile() → 指向恢复的 JSONL
// 6. restoreAgentFromSession() → 恢复 agent 和 model
// 7. saveMode() → 持久化当前模式
// 8. 计算 initialState → 返回给渲染层
```

## 四、核心架构：Project 类与写入队列

### 4.1 Project 单例

`src/utils/sessionStorage.ts:532-568` — `class Project` 是整个持久化的核心管理器：

```typescript
class Project {
  sessionFile: string | null = null
  // 在 sessionFile 确定之前，条目暂存于此
  private pendingEntries: Entry[] = []

  // 写入队列 — 按文件路径分组
  private writeQueues = new Map<string, Array<{ entry: Entry; resolve: () => void }>>()

  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeDrain: Promise<void> | null = null
  private FLUSH_INTERVAL_MS = 100          // ★ 100ms 批量窗口
  private readonly MAX_CHUNK_BYTES = 100 * 1024 * 1024  // ★ 100MB 分块

  // Session 元数据缓存 — 退出时重新追加到文件末尾
  currentSessionTag: string | undefined
  currentSessionTitle: string | undefined
  currentSessionAgentName: string | undefined
  currentSessionLastPrompt: string | undefined
  // ...
}
```

**关键设计：`pendingEntries` 缓冲**

Session file 不是一开始就创建的。在第一条真正的消息（user/assistant）写入之前，条目暂存在 `pendingEntries` 数组中。这避免了创建只有元数据而没有内容的空 session 文件。

### 4.2 写入流程：入队 → 定时批量排出

```
调用 recordTranscript()
  → insertMessageChain()
    → enqueueWrite(filePath, entry)    ← 入队，不直接写磁盘
      → scheduleDrain()                ← 设置 100ms 定时器
        → drainWriteQueue()            ← 定时器触发，批量写入
          → appendToFile(filePath, chunk)  ← 实际 fs.appendFile
```

**enqueueWrite** — 将条目放入按文件分组的队列：

```typescript
// src/utils/sessionStorage.ts:606-615
private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
  return new Promise<void>(resolve => {
    let queue = this.writeQueues.get(filePath)
    if (!queue) {
      queue = []
      this.writeQueues.set(filePath, queue)
    }
    queue.push({ entry, resolve })
    this.scheduleDrain()
  })
}
```

**scheduleDrain** — 100ms 定时器，避免重复设置：

```typescript
// src/utils/sessionStorage.ts:618-632
private scheduleDrain(): void {
  if (this.flushTimer) return         // 已有定时器，不需重复设置
  this.flushTimer = setTimeout(async () => {
    this.flushTimer = null
    this.activeDrain = this.drainWriteQueue()
    await this.activeDrain
    this.activeDrain = null
    // 如果在排出期间又有新条目到达，重新调度
    if (this.writeQueues.size > 0) {
      this.scheduleDrain()
    }
  }, this.FLUSH_INTERVAL_MS)
}
```

**drainWriteQueue** — 批量写入，按 100MB 分块：

```typescript
// src/utils/sessionStorage.ts:645-681
private async drainWriteQueue(): Promise<void> {
  for (const [filePath, queue] of this.writeQueues) {
    if (queue.length === 0) continue
    const batch = queue.splice(0)
    let content = ''
    const resolvers: Array<() => void> = []

    for (const { entry, resolve } of batch) {
      const line = jsonStringify(entry) + '\n'

      if (content.length + line.length >= this.MAX_CHUNK_BYTES) {
        // 到达 100MB 分块边界，先写出已有内容
        await this.appendToFile(filePath, content)
        for (const r of resolvers) r()
        resolvers.length = 0
        content = ''
      }

      content += line
      resolvers.push(resolve)
    }

    if (content.length > 0) {
      await this.appendToFile(filePath, content)
      for (const r of resolvers) r()
    }
  }
}
```

**为什么是 100ms？** 这是一个权衡：
- 太短（如 0ms）→ 每条消息单独 write()，大量系统调用
- 太长（如 5s）→ 进程崩溃丢失更多数据
- 100ms → 批量合并减少系统调用，同时保证最多丢失 100ms 的消息

### 4.3 两个写入路径

| 路径 | 函数 | 时机 | 同步/异步 |
|------|------|------|----------|
| 正常写入 | `enqueueWrite` → `drainWriteQueue` | 对话进行中 | 异步，100ms 批量 |
| 退出写入 | `appendEntryToFile` | 进程退出清理 | **同步**，立即落盘 |

```typescript
// 同步路径 — 退出清理时使用
// src/utils/sessionStorage.ts:2573-2585
function appendEntryToFile(fullPath: string, entry: Record<string, unknown>): void {
  const fs = getFsImplementation()
  const line = jsonStringify(entry) + '\n'
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch {
    fs.mkdirSync(dirname(fullPath), { mode: 0o700 })
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  }
}
```

退出时的清理流程：

```typescript
// src/utils/sessionStorage.ts:448-463
registerCleanup(async () => {
  await project?.flush()              // 先排出队列中所有待写条目
  try {
    project?.reAppendSessionMetadata() // 重新追加会话元数据到文件末尾
  } catch { /* best-effort */ }
})
```

`reAppendSessionMetadata` 将 `customTitle`、`tag`、`agentName` 等元数据重新追加到文件末尾，确保它们始终在文件最后 64KB 的 tail window 内，方便 `readLiteMetadata` 快速读取。

## 五、消息格式与树状结构

### 5.1 JSONL 行格式

每行是一个独立的 JSON 对象。从本次研究的实际数据来看：

**User Message:**
```json
{
  "parentUuid": null,
  "isSidechain": false,
  "type": "user",
  "message": { "role": "user", "content": "请帮我写一个函数" },
  "uuid": "0ece779a-6370-4041-89ef-29a3128ed854",
  "timestamp": "2026-04-30T10:25:28.352Z",
  "sessionId": "5bebfd81-...",
  "cwd": "/Users/bigorange/nodecode/my-claude-code",
  "version": "2.1.87",
  "gitBranch": "main"
}
```

**Assistant Message（含 content blocks 数组）:**
```json
{
  "parentUuid": "...",
  "isSidechain": false,
  "type": "assistant",
  "message": {
    "id": "ab0b3847-...",
    "role": "assistant",
    "model": "deepseek-v4-pro",
    "content": [
      {"type": "thinking", "thinking": "...", "signature": "..."},
      {"type": "text", "text": "让我先探索代码库。"},
      {"type": "tool_use", "id": "call_00_xxx", "name": "Bash",
       "input": {"command": "ls -la", "description": "List files"}}
    ],
    "usage": {"input_tokens": 23618, "output_tokens": 0}
  },
  "uuid": "5e3368dd-...",
  "timestamp": "2026-04-30T10:25:34.688Z"
}
```

**内容为数组而非字符串。** 模型的一次回复可能包含 thinking → text → tool_use 的完整链条，通过数组保留原始顺序。这跟 Anthropic/OpenAI API 的 content block 模式一致。

**Tool Result（类型为 user！）:**
```json
{
  "parentUuid": "...",
  "isSidechain": false,
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "tool_use_id": "call_00_xxx",
      "type": "tool_result",
      "content": "total 112\n...",
      "is_error": false
    }]
  },
  "toolUseResult": {
    "stdout": "...", "stderr": "", "interrupted": false, "isImage": false
  },
  "sourceToolAssistantUUID": "5e3368dd-...",
}
```

工具结果被标记为 `"type": "user"`，因为它以 user role 注入回对话。附带 `toolUseResult`（结构化结果）和 `sourceToolAssistantUUID`（链接回触发工具调用的 assistant 消息）。

### 5.2 树状结构

每条消息有 `uuid` 和 `parentUuid`，形成 DAG：

```
user (uuid: aaa, parentUuid: null)              ← 对话起点
  └─ assistant (uuid: bbb, parentUuid: aaa)     ← 模型回复
       └─ tool_result (uuid: ccc, parentUuid: bbb) ← 工具结果，type: user
            └─ assistant (uuid: ddd, parentUuid: ccc) ← 继续回复
                 └─ user (uuid: eee, parentUuid: ddd)  ← 用户继续
```

`isSidechain: true` 标记分支对话（子代理、编辑重发），它们不参与主链上下文。

#### 5.2.5 Chain Walk 详解

**什么是 Chain Walk**

JSONL 文件里的消息不是按时间顺序排列的线性数组，而是通过 `parentUuid` 指针形成的一棵**树**（实际是 DAG）。Chain walk 就是从叶子节点出发，沿着 `parentUuid` 链一路回溯到根节点，重建出**一条特定的对话链**。

**为什么需要 Chain Walk — 分支场景分析**

考虑以下场景：用户发送消息后，模型正在回复，用户编辑了原始消息并重新发送。

JSONL 文件内容（按写入时间顺序）：

```
行1: {"type":"user","uuid":"U1","parentUuid":null,"content":"帮我写一个排序函数"}
行2: {"type":"assistant","uuid":"A1","parentUuid":"U1","content":"好的，这是代码..."}
行3: {"type":"user","uuid":"T1","parentUuid":"A1","content":"[tool result]"}
行4: {"type":"assistant","uuid":"A2","parentUuid":"T1","content":"测试通过了，这个函数..."}  ← 旧分支
行5: {"type":"user","uuid":"U2","parentUuid":"T1","content":"帮我写一个快速排序函数"}    ← 编辑重发
行6: {"type":"assistant","uuid":"A3","parentUuid":"U2","content":"好的，这是快排..."}    ← 当前链
```

此时的消息树：

```
U1 → A1 → T1 ─┬─ A2 (旧分支，被用户丢弃的回复)
              │
              └─ U2 → A3 (新链，编辑重发后的当前对话)
```

**关键问题：** 如果你按行号顺序读，会得到 `U1 → A1 → T1 → A2 → U2 → A3`，但 `A2` 是被用户丢弃的旧回复，不应该出现在当前对话上下文里！它会破坏 LLM 的对话连续性。

**Chain Walk 如何解决**

1. 找到所有**叶子节点**（没有其他消息的 parentUuid 指向它们）→ `A2`, `A3`
2. 排除 `isSidechain: true` 的侧链叶子
3. 从最新的非 sidechain 叶子开始 → `A3`
4. 沿 parentUuid 回溯：`A3 → U2 → T1 → A1 → U1`
5. 反转得到正确的对话链：`[U1, A1, T1, U2, A3]` ✓

这就是 chain walk。**被用户编辑丢弃的 `A2` 仍然保存在 JSONL 里**（追加模式下不能删除已写入的行），但 chain walk 不会把它选入当前对话链。

**三种场景总结**

| 场景 | 行为 | parentUuid 链 | sessionId |
|------|------|--------------|-----------|
| 正常对话 | 模型回复完成，用户继续提问 | 线性追加，无分叉 | 不变 |
| 打断/编辑重发 | 模型回复中，用户编辑消息重发 | T1 有 A2 和 U2 两个子节点，形成分支 | 不变 |
| 模型回复完成后继续 | 同场景 1 | 线性追加 | 不变 |

**关键纠正：打断/编辑重发不会创建新 sessionId**

整个过程在**同一个 session** 里。只是在同一个 parentUuid 下出现了两个子节点，形成了分支树。session 没变，sessionId 没变。被丢弃的旧分支仍然保存在 JSONL 里。

**线性对话 vs 树状对话**

- **线性对话：** 每条 parentUuid 最多只有一个子节点。对话只有一根筋，没有分支。按行号顺序读 JSONL 就是正确的对话链。
- **树状对话：** 同一个 parentUuid 可以有多个子节点（编辑重发、子代理并发）。必须通过 chain walk 确定当前链。

**什么时候需要 chain walk**

- 不支持打断模型回复 → 不需要
- 不支持编辑历史消息重新发送 → 不需要
- 不支持子代理 → 不需要

这三个功能都是可选的。如果暂时不需要，JSONL 保留 `parentUuid` 字段按线性对话处理即可，**将来加上这些功能时只需升级 `loadConversation` 的读取逻辑**，格式本身已支持。

### 5.3 transcript message 类型守卫

```typescript
// src/utils/sessionStorage.ts:139-146
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}
```

**关键注释（源码中的教训）：**

> "Progress messages are NOT transcript messages. They are ephemeral UI state and must not be persisted to the JSONL or participate in the parentUuid chain. Including them caused chain forks that orphaned real conversation messages on resume (see #14373, #23537)."

这是一个从 bug 中学到的教训：UI 进度条消息（如 "Running... 50%"）被误写入对话链后，导致恢复时 parentUuid 链断裂，真实对话消息变成孤儿。

### 5.4 消息去重

`recordTranscript` 在写入前进行去重：

```typescript
// src/utils/sessionStorage.ts:1409-1450
export async function recordTranscript(
  messages: Message[], teamInfo?, startingParentUuidHint?, allMessages?
): Promise<UUID | null> {
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages)
  const sessionId = getSessionId() as UUID
  const messageSet = await getSessionMessages(sessionId)  // 加载已有 UUID 集合
  const newMessages: typeof cleanedMessages = []

  for (const m of cleanedMessages) {
    if (messageSet.has(m.uuid as UUID)) {
      // 已存在 → 跳过，但更新 parentUuid 指针
      if (!seenNewMessage && isChainParticipant(m)) {
        startingParentUuid = m.uuid as UUID
      }
    } else {
      newMessages.push(m)
      seenNewMessage = true
    }
  }

  if (newMessages.length > 0) {
    await getProject().insertMessageChain(newMessages, ...)
  }
}
```

这确保了消息的幂等写入——在 compact/resume 场景中，部分消息可能已经存在。

## 六、消息读取与恢复

### 6.1 loadTranscriptFile

```typescript
// src/utils/sessionStorage.ts:3473
export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean },
): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  // ... 更多元数据 Map
  leafUuids: Set<UUID>
}>
```

返回值设计为多个 Map 而非数组：
- `messages: Map<UUID, TranscriptMessage>` — 按 UUID 索引，O(1) 查找
- `leafUuids: Set<UUID>` — 叶子节点集合（没有子消息），用于恢复链的末尾
- 各种元数据独立 Map — 避免遍历所有消息来查找标题/标签

### 6.2 大文件优化

对于大会话文件（可能达到 GB 级别），使用**分段读取**防止 OOM：

```typescript
// src/utils/sessionStoragePortable.ts
const SKIP_PRECOMPACT_THRESHOLD = ...  // 跳过已 compact 的前半部分

// src/utils/sessionStorage.ts:3522-3555
// 单次前向 chunked 读取：attribution-snapshot 行在 fd 级别跳过（不缓冲），
// compact 边界在流中截断累积器。峰值分配是 OUTPUT 大小，不是文件大小 —
// 一个 151 MB 的会话，84% 是过期的 attr-snaps，分配 ~32 MB 而非 159+64 MB。
```

上限保护：

```typescript
// src/utils/sessionStorage.ts:227-229
export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024  // 50 MB
export const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024  // 50 MB
```

### 6.3 恢复流程

`src/utils/sessionRestore.ts` — `processResumedConversation()`:

```
1. matchSessionMode()  →  匹配 coordinator/normal 模式
2. switchSession()     →  切换到恢复的 session ID
3. restoreSessionMetadata() → 恢复标题、标签、代理等元数据
4. restoreWorktreeForResume() → 恢复 worktree 目录
5. adoptResumedSessionFile()  → 指向恢复的 JSONL
6. restoreAgentFromSession()  → 恢复使用的 agent
7. saveMode()          →  保存当前模式
```

`--fork-session` 选项会复制消息到新会话而不是接管原会话。

## 七、Shell 命令历史

`src/history.ts` — `~/.claude/history.jsonl` 的管理：

```typescript
const MAX_HISTORY_ITEMS = 100
const MAX_PASTED_CONTENT_LENGTH = 1024
```

每条记录：
```json
{
  "display": "/model ",
  "pastedContents": {},
  "timestamp": 1772111390555,
  "project": "/Users/bigorange/nodecode/my-project",
  "sessionId": "cd1fd919-..."
}
```

历史限制在最近 100 条，粘贴内容通过 hash 引用到 paste store（避免重复存储大文本）。

## 八、关键设计决策

### 8.1 JSONL 的选择

| 特性 | JSONL | 单文件 JSON Array |
|------|-------|-------------------|
| 追加写入 | ✅ append 一行 | ❌ 需重写整个文件 |
| 崩溃安全 | ✅ 每行独立，最多丢最后一行 | ❌ 中断则整个文件损坏 |
| 流式读取 | ✅ 逐行，内存友好 | ❌ 必须全部加载到内存 |
| 写入性能 | ✅ 队列批量合并 100ms | ❌ 需序列化整个数组 |

### 8.2 100ms 批量窗口

这是最精妙的设计之一。不是每条消息立即 `fs.write`，也不是等到 1000 条消息才写。100ms 的批量合并：
- 正常对话中 100ms 内通常只有 1-3 条消息 → 合并为一次 write()
- 高频更新（如 Bash 进度）也能被合并
- 崩溃时最多丢失 100ms 的消息内容

### 8.3 同步 vs 异步两个路径

退出清理时用 `appendFileSync` — 此时 event loop 即将关闭，异步 I/O 不会被调度。正常写入时用异步队列 — 不阻塞主线程。

### 8.4 Pending Entries 延迟物化

Session file 不是启动时就创建，而是等到第一条真正的 user/assistant 消息才创建。这避免了创建「空文件 session」——用户启动后又立即退出的情况。

### 8.5 reAppendSessionMetadata

元数据（标题、标签、代理名）在会话中可能被修改多次。退出时统一重新追加到文件末尾 64KB 窗口内，确保：
- 下次 resume 时可以快速读取（只需读末尾 64KB）
- 不需要修改文件中间的旧元数据行

### 8.6 多级键设计

```
PID → SessionID → Message UUID
 ↑         ↑           ↑
进程崩溃   项目会话    消息树
检测      索引       链接
```

三层键解决不同问题，互不干扰。

## 九、与我们项目的差距

| 维度 | Claude Code | 我们的项目 | 实现建议 |
|------|------------|-----------|----------|
| 存储格式 | JSONL + 写入队列批处理 | 无 | 实现简单的 JSONL 追加 |
| 消息去重 | `messageSet.has(uuid)` | 无 | 保存时检查 UUID |
| 批量写入 | 100ms 窗口 + 100MB 分块 | 无 | 可简化为每条立即写，或简单批量 |
| 会话恢复 | `--continue` / `--resume` | 无 | 实现 `loadConversation()` |
| 元数据缓存 | Project.currentSessionXxx | 无 | 在 persistence 模块中缓存 |
| 大文件保护 | 50MB 读取上限，分段读取 | 不需要 | 我们的会话规模小 |
| 退出清理 | `registerCleanup` + `reAppendSessionMetadata` | 无 | 监听 exit 写入最终状态 |
| 子代理 | 独立 JSONL | 无 | 暂不需要 |
| 文件历史 | 快照 + 撤销 | 无 | 暂不需要 |
| Shell 历史 | history.jsonl | 无 | 可选 |

## 十、我们的简化实现方案

### 10.1 最小可行设计

```
~/.myclaude/projects/<sanitized-cwd>/
├── <session-id>.jsonl      # 对话记录（JSONL）
└── <session-id>.meta.json  # 会话元数据
```

### 10.2 简化消息格式

只持久化 LLM 上下文相关的消息（user + assistant + tool）：

```json
{"type":"user","content":"...","uuid":"...","timestamp":...}
{"type":"assistant","content":"...","thinking":"...","toolCalls":[...],"uuid":"...","timestamp":...}
{"type":"tool_result","toolName":"Bash","toolInput":{},"result":"...","uuid":"...","timestamp":...}
```

### 10.3 实现步骤

1. `src/services/persistence.ts` — `appendMessage()`, `loadConversation()`, `listSessions()`
2. Session UUID 生成 — 启动时创建或恢复
3. 在 `handleSend` 的 queryLoop 步骤中调用 `appendMessage()`
4. 退出时写入 session metadata
5. CLI 支持 `--continue` / `--list-sessions`

### 10.4 不做的事

- ❌ 100ms 批量写入队列 — 先用简单的每条立即写入
- ❌ 树状分支（parentUuid/isSidechain）— 线性对话足以
- ❌ 子代理持久化、文件历史、Shell 历史
- ❌ 大文件分段读取 — 等会话真的变大再说
