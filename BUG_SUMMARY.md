# Bug 修复总结

## 问题 1: 工具调用标签直接显示在 UI 上

### 现象
模型返回 `<tool_call>...` XML 标签，用户看到原始标签而不是清理后的内容

### 原因
- 模型输出包含 tool_call 格式的调用
- Messages 组件直接显示原始内容

### 解决方案
```typescript
// 定义 cleanContent 函数过滤 XML 标签
function cleanContent(content: string): string {
  return content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool name="[^"]*">[\s\S]*?<\/tool>/g, '')
    .replace(/<param name="([^"]+)">([^<]+)<\/param>/g, '$2 ')
    .trim()
}
```

### 避免方法
- 在显示层统一处理：所有 assistant 消息都经过 cleanContent
- 保存前也清理：确保存储的是干净内容

---

## 问题 2: 消息状态不更新 (闭包陷阱)

### 现象
输入内容后没有回复，或回复为空

### 原因
```typescript
// ❌ 错误的写法 - ref 在闭包中是旧值
const conversationHistory = messagesRef.current.map(...) // 永远是空

// ❌ 另一个问题：在 setState 回调之后立即使用内部变量
setState((prev) => {...})
const newMessages = prev.messages // 闭包陷阱
```

### 解决方案
```typescript
// ✅ 正确：在 setState 之前获取最新值
const currentMessages = messagesRef.current  // 通过 useEffect 同步
const allMessages = [...currentMessages, userMessage]
setState((prev) => ({
  ...prev,
  messages: allMessages,
}))
```

### 避免方法
- 始终使用 ref 配合 useEffect 同步
- 使用 useCallback 时避免依赖变化的变量
- 避免在 setTimeout 中调用 hooks

---

## 问题 3: React Hooks 规则违反

### 现象
`Error: Invalid hook call. Hooks can only be called inside of the body of a function component`

### 原因
```typescript
// ❌ 错误：在 setTimeout 回调中使用 useAppState
setTimeout(() => {
  const msgs = useAppState(s => s.messages) // 违反规则！
}, 0)
```

### 解决方案
```typescript
// ✅ 在组件同步获取，存储到变量
const messages = useAppState(s => s.messages)
// 在 handleSend 中使用变量而不是再次调用 hook
const allMessages = [...messages, newMsg]
```

### 避免方法
- hooks 只能在 React 组件主体或自定义 hook 中调用
- 不能在 setTimeout、Promise.then、事件回调中调用 hooks
- 需要异步访问 state 时，使用 ref 代替

---

## 问题 4: 方向键导致程序退出

### 现象
按上/下/左/右方向键时程序退出

### 原因
```typescript
// ❌ 过于简单的 escape 处理 - 任何 escape 都退出
if (char.startsWith('\x1b')) {
  process.exit(0)
}
```

### 解决方案
```typescript
// ✅ 忽略方向键等 escape 序列
if (char.startsWith('\x1b')) {
  return // 忽略方向键
}
```

### 避免方法
- 区分不同类型的 escape 序列
- 只处理明确知道的热键（如 Ctrl+C）

---

## 核心经验

### 状态管理原则
1. **单一数据源** - 使用 Zustand-style store 而不是多个 state
2. **同步更新** - 通过 useEffect 同步到 ref
3. **避免闭包** - 使用 useCallback 时注意依赖

### Hooks 使用原则
1. **只能在组件主体** - 不能在回调中调用
2. **固定顺序** - 每次 render 顺序一致
3. **不条件调用** - 不能在 if 中调用

### 调试技巧
1. **日志调试** - 在状态变化点添加 console.log
2. **逐步验证** - 先用独立脚本测试核心逻辑
3. **分离问题** - 确认是 API 问题还是 UI 问题

---

## 测试流程推荐

```
1. 独立脚本测试 API/核心逻辑
   → test.ts 直接调用 createQueryLoop

2. 单元测试组件
   → 单独测试 Messages 渲染

3. 集成测试
   → 完整流程从输入到显示
```

这样可以快速定位问题所在层次。