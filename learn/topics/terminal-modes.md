# 终端交互模式详解

## 问题 1: 什么是 TTY？

### TTY 的定义

**TTY** 是 "Teletype" 的缩写 originally，指终端设备。在现代 computing 中：

| 术语 | 含义 |
|------|------|
| **TTY** | 终端的统称，可以理解为 "屏幕 + 键盘" |
| **PTY** | Pseudo TTY - 伪终端 (如 iTerm2, Terminal.app) |
| **stdout** | 标准输出 - 屏幕显示 |
| **stdin** | 标准输入 - 键盘输入 |

### 我们的情况

```
process.stdin.isTTY  // 在 iTerm2/Terminal 中是 true
                   // 在管道/CI 中是 undefined/false
```

**当你在 iTerm2 中运行程序时**:
- 可以看到屏幕输出
- 可以输入文字
- TTY 模式 = 交互模式

---

## 问题 2: 什么是 Raw Mode？

### 对比：Canonical Mode vs Raw Mode

#### Canonical Mode (默认，行模式)

```
用户输入: h e l l o CR
         ↓
系统缓冲区: "hello\n" (直到 CR 才提交)
```

特点:
- 按回车才发送到程序
- 可以使用 Ctrl+C, Ctrl+Z 等控制键
- 行编辑 (backspace 删除单个字符)

#### Raw Mode (原始模式)

```
用户输入: h e l l o
         ↓
系统立即: "hello" (每个字符立即发送)
```

特点:
- 字符立即发送到程序
- 需要自己处理 CR, backspace, ctrl+C
- 可以实现实时输入 (如密码不显示、游戏)

### 代码示例

```typescript
// Canonical Mode (默认)
process.stdin.setRawMode(false)

// Raw Mode
process.stdin.setRawMode(true)
```

---

## 问题 3: 什么是 CI/管道环境？

### 交互模式 vs 非交互模式

| 环境 | 模式 | stdin | 用途 |
|------|------|------|------|
| **iTerm2/Terminal** | 交互 | TTY | 人工使用 |
| **管道 `echo "x" \| cmd`** | 非交互 | pipe | 自动化 |
| **CI (GitHub Actions)** | 非交互 | null | 自动化测试 |
| **cron 定时任务** | 非交互 | null | 后台运行 |

### 实际效果

```bash
# 交互环境 - 有 TTY
$ my-claude-code chat
> Hello world    # 可以输入

# 管道环境 - 无 TTY
$ echo "Hello" | my-claude-code chat
# stdin = pipe, process.stdin.isTTY = undefined
# 不能输入，只能通过管道输入

# CI 环境
$ my-claude-code chat
# stdin = null, process.stdin.isTTY = undefined
# 完全不能交互
```

---

## 问题 4: 造成的实际问题

### Ink 的 useInput 问题

Ink 库依赖 `useInput` hook，它需要:

```typescript
useInput((input, key) => {
  // 处理输入
})
```

但是 `useInput` 内部：

```javascript
// ink 源码简化
if (!process.stdin.isTTY) {
  throw new Error('Raw mode is not supported')
}
```

**我们的错误信息:**
```
ERROR Raw mode is not supported on the current process.stdin
```

### 为什么？

1. Ink 假设在终端环境中运行
2. 它需要 raw mode 来实现实时按键响应
3. 管道环境没有终端，所以报错

### 我们做了什么？

```typescript
// PromptInput.tsx 中检测
useEffect(() => {
  if (!process.stdin.isTTY) {
    setIsTTY(false)
    return  // 不使用 raw mode
  }
  
  // 只有在 TTY 环境下才启用输入
  process.stdin.setRawMode(true)
}, [])
```

---

## 问题 5: setRawMode 详解

### setRawMode(true)

```typescript
process.stdin.setRawMode(true)

// 效果：
// - 字符立即发送到程序 (不用等回车)
// - 不显示输入的字符 (密码场景)
// - 终端不处理 Ctrl+C 等控制键，直接发送字符编码
```

### setRawMode(false) - 恢复默认

```typescript
process.stdin.setRawMode(false)

// 效果：
// - 需要按回车提交
// - 终端处理控制键
// - 可以使用 backspace 删除整行
```

### 用 ?. 的原因

```typescript
// 兼容性处理
(process.stdin as any).setRawMode?.(true)
//                ^^ 可选链

// 因为在某些环境下可能不存在这个方法
```

---

## 问题 6: 交互模式 vs 非交互模式

### 交互模式 (Interactive)

```
$ my-claude-code chat
═══ My Claude Code v0.1.0 ═══
> _           ← 光标等待输入
Hello world   ← 输入显示
> Hello world ← 按 Enter 提交
```

- 可以实时输入
- 可以看到光标闪烁
- 可以使用方向键

### 非交互模式 (Non-interactive)

```
$ echo "Hello" | my-claude-code chat
═══ My Claude Code v0.1.0 ═══
(No messages)
(Non-interactive - use -p flag)
```

- 不能实时输入
- 使用 `-p` 参数传入 prompt
- 或者通过管道输入

---

## 问题 7: 为什么输入后没显示？

### 根本原因

1. **Ink 渲染是同步的** - 渲染完成就结束了
2. **状态更新是异步的** - `setState` 后状态更新
3. **没有重新渲染** - 状态更新了但 UI 没有刷新

### 流程分析

```
1. 输入 "Hello" + Enter
2. handleSubmit("Hello") 被调用
3. setState(...) 更新状态
4. 但是 Ink 已经完成渲染
5. 状态更新后没有触发重新渲染
6. 消息没有显示在界面
```

### 解决方案

Claude Code 原项目使用更复杂的方法：
- 使用 `useSyncExternalStore` 订阅状态
- 持续运行的事件循环
- 自己管理输入循环

---

## 总结图

```
┌─────────────────────────────────────────────┐
│           运行环境检测                       │
├─────────────────────────────────────────────┤
│  process.stdin.isTTY                       │
│        ↓                               │
│   true          false                     │
│    ↓             ↓                    │
│ 交互模式      非交互模式              │
│    ↓             ↓                    │
│ useInput     readline/手动处理          │
│ setRawMode      不需要              │
│ 可以实时输入   -p 参数输入          │
└─────────────────────────────────────────────┘
```

---

## 下一步

这个问题会在 Phase 6+ 解决，届时会实现：
- 完整的 API 调用
- 响应式状态更新
- 消息正确显示