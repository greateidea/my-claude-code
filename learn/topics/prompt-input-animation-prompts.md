# PromptInput 重构、动画系统与提示词升级 — 实践总结

## 概述

本次工作涵盖三个相互关联的改进：输入框光标系统重构、终端动画效果实现、以及系统提示词工程化升级。每个部分都包含可复用的设计模式和踩坑经验。

---

## 一、PromptInput 重构：从 useState 到 useReducer

### 1.1 问题诊断

原始实现使用两个独立的 `useState`：

```typescript
const [input, setInput] = useState('')
const [cursorPos, setCursorPos] = useState(0)
```

这在中文 IME 输入时暴露出两个问题：

**问题 A — 状态不同步：** `input` 和 `cursorPos` 是两个独立的状态，React 批量更新时可能出现一个已更新而另一个未更新的情况，导致光标位置与实际文本不一致。

**问题 B — IME 多字符提交：** 中文输入法（如拼音）会将"你好"作为一个完整字符串一次性提交到 raw mode stdin。但光标的增量更新用的是 `cursor + 1`，所以光标只前进了 1 个位置，而不是 2 个。

### 1.2 解决方案：useReducer 原子化状态

将所有输入状态合并到一个对象中，用 reducer 保证每次更新都是原子的：

```typescript
export interface InputState {
  text: string
  cursor: number  // 字符位置，不是字节偏移
}

export function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case 'insert':
      return {
        text: text.slice(0, cursor) + action.char + text.slice(cursor),
        cursor: cursor + action.char.length,  // 关键：按字符数前进
      }
    // ...
  }
}
```

**关键洞察：** `cursor + action.char.length` 而非 `cursor + 1`。JavaScript 的 `.length` 正确计算 Unicode 字符数（包括 CJK 字符），所以 "你好".length === 2。

### 1.3 终端 Raw Mode 下的键盘输入处理

在 raw mode 下，`process.stdin` 发出的是原始字节序列。常见按键映射：

| 按键 | 转义序列 | 说明 |
|------|----------|------|
| Enter | `\r` 或 `\n` | 发送消息 |
| Backspace | `\x7f` (DEL) 或 `\x08` (BS) | 删除光标前字符 |
| Delete | `\x1b[3~` | 删除光标处字符 |
| ← | `\x1b[D` | 光标左移 |
| → | `\x1b[C` | 光标右移 |
| Home | `\x1b[H` / `\x1b[1~` / `\x1bOH` | 行首 (多种终端兼容) |
| End | `\x1b[F` / `\x1b[4~` / `\x1bOF` | 行尾 |
| Ctrl+A | `\x01` | 行首 (readline 风格) |
| Ctrl+E | `\x05` | 行尾 |
| Ctrl+K | `\x0b` | 删除到行尾 |
| Ctrl+U | `\x15` | 删除到行首 |
| Ctrl+C | `\x03` | 退出 / 清空 |
| Option+← | `\x1b[1;2D` / `\x1bb` | 按词左移 |
| Option+→ | `\x1b[1;2C` / `\x1bf` | 按词右移 |

### 1.4 块状光标的 Ink 渲染

不使用 `▌` 字符（在 CJK 文本中会错位），改用 Ink 的 `inverse` prop 反转光标所在字符的背景色：

```tsx
{/* 光标在字符上：反转该字符 */}
{cursor < text.length ? (
  <Text bold inverse color="white">{afterCursor[0]}</Text>
) : (
  <Text bold inverse> </Text>  // 光标在末尾：反转一个空格
)}
```

### 1.5 测试策略

reducer 是纯函数，测试非常直接——不需要模拟 DOM 或终端：

```typescript
// 辅助函数：批量 dispatch
function reduce(actions: InputAction[], initial?: InputState): InputState {
  return actions.reduce((state, action) => inputReducer(state, action), initial)
}

// IME 关键测试
it('inserts multi-character string (IME commit) and advances cursor by full length', () => {
  const state = reduce([{ type: 'insert', char: '你好' }])
  expect(state.text).toBe('你好')
  expect(state.cursor).toBe(2)  // 不是 1
})
```

共 19 个测试覆盖：单字符/多字符插入、光标位置插入、退格、删除、光标移动与边界裁剪、Home/End、按词跳转、Kill 行、清空、真实 IME 场景。

---

## 二、终端动画系统

### 2.1 Claude Code 动画架构的关键设计

探索 Claude Code 源码后发现其动画系统是**自建的**，没有使用第三方动画库：

- **共享时钟：** `setInterval` 驱动的 ClockContext，整个 React 树共享一个 interval，由 `focus` 事件自动启停
- **帧计数器：** 简单的 frame index 递增，组件通过 `useAnimationFrame(intervalMs)` 读取
- **视口检测：** 离屏时暂停动画（通过检测组件是否 mounted 到终端视口内）
- **动画模式：**
  - **SpinnerGlyph：** 弹跳式星形字符循环（前进 + 后退，120ms/帧）
  - **GlimmerMessage：** 3 字符宽的高亮带扫过文本
  - **Flash/Pulse：** sin 波透明度脉动

### 2.2 本项目的简化实现

#### useAnimationFrame hook

```typescript
export function useAnimationFrame(intervalMs = 120, active = true): number {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setFrame(f => f + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, active])
  return frame
}
```

**设计要点：**
- `setInterval` 而非 `requestAnimationFrame`（终端不需要 60fps）
- `active` 参数允许外部冻结动画
- 自动 cleanup 防止内存泄漏
- 默认 120ms ≈ 8fps，与 Claude Code 一致

#### SpinnerGlyph — 弹跳星形字符

```typescript
const GLYPHS = ['✶', '✷', '✸', '✹', '✺', '✻', '✼', '✽', '✾', '✿']

function bounceGlyph(frame: number): string {
  const cycle = GLYPHS.length * 2 - 2  // 前进 + 后退，不重复两端
  const idx = frame % cycle
  if (idx < GLYPHS.length) return GLYPHS[idx]
  return GLYPHS[cycle - idx]
}
```

**为什么弹跳式？** 单向循环（0→9→0→9…）在跳变处有视觉割裂感。弹跳式（0→9→8→…→1→0→…）更平滑。

#### ShimmerText — 微光扫过效果

```typescript
// 计算每个字符到"扫光中心"的距离（环形）
const pos = frame % text.length
const dist = Math.min(
  Math.abs(i - pos),
  Math.abs(i - pos - text.length),   // 左环绕
  Math.abs(i - pos + text.length),   // 右环绕
)
const highlighted = dist < width  // 在 3 字符宽的高亮带内
```

**配色改进：** 纯白色 `inverse` 在终端中刺眼。改用 `bold + yellow`（高亮）和 `dimColor`（非高亮）的渐变带，更适合终端 UI 的暖色调。

---

## 三、系统提示词工程

### 3.1 Claude Code 提示词架构的关键发现

通过深入探索 Claude Code 源码（`src/constants/prompts.ts`），其提示词系统是一个**三段式流水线**：

```
getSystemPrompt()           → 组装 string[]
buildEffectiveSystemPrompt() → 优先级路由（override > agent > custom > default）
buildSystemPromptBlocks()   → 分块 + cache_control 标记
```

**静态/动态分离策略：** 提示词分为两个区域，用 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 分隔：
- **静态区：** 行为规则、工具指南、语气风格 → 可跨组织全局缓存
- **动态区：** 环境信息、MCP 服务器、记忆内容 → 每次重新计算

CLAUDE.md 通过 **User Context** 通道注入（而非系统提示词），以 `<system-reminder>` 标签包裹在第一条用户消息中。

### 3.2 本项目的提示词升级

**升级前的 BASE_PROMPT（仅 8 行）：**
```
You are a CLI assistant. Use the tools provided.
Tools: bash, Glob, Read, Write
RULES: IMMEDIATELY call a tool, don't explain
```

**升级后（6 节结构化提示词）：**

```
# 角色定位     → 交互式 CLI 智能体 + 安全边界
# 任务执行     → 先读代码再修改、不画蛇添足、安全编码
# 谨慎操作     → 破坏性操作先确认、诊断根因而非走捷径
# 工具使用     → 专用工具优先于 Bash、无依赖时并行调用
# 语气风格     → 简洁直接、file_path:line_number、无 emoji
# 记忆/CLAUDE  → 持久化记忆系统 + CLAUDE.md 优先规则
```

**新增环境信息注入：** `buildSystemPrompt()` 现在接受 `env` 参数，将工作目录、平台、日期注入系统提示词。这使模型能感知上下文（如知道自己在 macOS 上、当前在哪个项目目录下）。

### 3.3 提示词设计原则总结

| 原则 | 说明 |
|------|------|
| **身份先行** | 第一句话定义智能体角色和能力边界 |
| **正向指令** | 用"应该做 X"而非"不要做 Y"（负向指令容易被忽略） |
| **具体优于抽象** | `Read(file_path)` 而非 "使用文件读取工具" |
| **分组 + 标签** | 用 `# Section` 分组，模型更容易按类别检索规则 |
| **动态上下文** | 环境信息（cwd, platform, date）注入提示词而非依赖模型记忆 |
| **渐进增强** | 先写好基础规则，再逐步添加约束，一次加太多会互相干扰 |

---

## 变更文件清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/components/PromptInput.tsx` | 重写 | useState → useReducer, 完整键盘支持, 块状光标, IME 修复 |
| `src/components/SpinnerGlyph.tsx` | 新建 | 弹跳星形旋转动画 |
| `src/components/ShimmerText.tsx` | 新建 | 微光扫过文本效果 |
| `src/hooks/useAnimation.ts` | 新建 | useAnimationFrame + usePulse hooks |
| `src/components/screens/REPL.tsx` | 修改 | 集成动画组件替换静态文本 |
| `src/replLauncher.tsx` | 修改 | 升级 BASE_PROMPT, 注入 env info |
| `src/services/queryLoop.ts` | 修改 | buildSystemPrompt 支持 env 参数 |
| `tests/test-prompt-input.test.ts` | 新建 | 19 个 inputReducer 单元测试 |

## 测试

```bash
bun test          # 19 tests, 0 fail
bun run typecheck # clean
bun run dev       # 启动验证：光标移动、动画效果、模型行为
```
