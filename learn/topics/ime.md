# IME (Input Method Editor) 详解

## 什么是 IME？

**IME (Input Method Editor)** 是操作系统的**输入法编辑器**，用于输入非 ASCII 字符：

| 语言 | IME 例子 |
|------|---------|
| 中文 | 搜狗输入法、微软拼音、rime |
| 日语 | MS-IME、Google 日本語入力 |
| 韩语 | Hangul |

## IME 工作原理

```
用户按键 → IME 拦截 → 转换 → 候选窗口 → 最终文字
```

1. 用户输入 `n` `i` `h` `a` `o`
2. IME 显示候选: "你好", "倪好", "泥浩"...
3. 用户选择 "你好"
4. 文字发送到应用程序

## 候选窗口位置问题

### 问题根源

```
┌──────────────────────────────────────┐
│  应用程序 (Raw Mode)                 │
│  - 只接收最终文字，不接收原始按键    │
│  - 光标位置由应用程序控制          │
│                                     │
│  候选窗口 (由 IME/终端控制)         │
│  - 位置由操作系统/IME 控制         │
│  - 不受应用程序控制                │
└──────────────────────────────────────┘
```

### 为什么错位？

- **应用程序** 不知道 IME 何时显示候选窗口
- **IME** 不知道应用程序的光标位置
- 两者之间没有通信机制

## Claude Code 的解决方案

Claude Code 使用 **Ink** 框架，它有几个处理方式：

### 1. 检测 IME 状态

```typescript
// Ink 源码中检测组合文字
function hasInputMethodActive(): boolean {
  // 检查是否有未提交的组合文字
}
```

### 2. 切换模式

当检测到 IME 活跃时：
- 暂时切换到 canonical mode（行模式）
- 等待用户完成输入（按回车或空格确认）
- 然后切回 raw mode

### 3. 使用终端 API

某些终端提供 API 来获取/设置光标位置：
- `iTerm2` - 提供 escape sequence 查询光标
- `Windows Terminal` - 更好的 IME 集成
- `Kitty` - 先进的终端支持

## 实际代码示例

```typescript
// 简化逻辑
function handleInput(char: string) {
  if (isIMERecomposing()) {
    // IME 正在组字，暂时不处理
    return
  }
  
  // 正常处理
  processChar(char)
}

function isIMERecomposing(): boolean {
  // 检查是否有未确认的组合文字
  return inputBuffer.length > 0
}
```

## 总结

| 问题 | 说明 |
|------|------|
| IME 是什么 | 输入法编辑器，用于输入中文/日文等 |
| 为什么错位 | IME 候选框由系统控制，与应用无关 |
| Claude Code 解法 | 检测 IME 状态，必要时切换到行模式 |

## 学习资源

- [IME on Wikipedia](https://en.wikipedia.org/wiki/Input_method)
- [Ink GitHub - IME issues](https://github.com/vadimdemedes/ink/issues?q=ime)