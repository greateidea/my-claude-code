# 权限 UI 实现问题复盘

## 问题描述

在实现工具权限确认 UI 时，遇到两个阶段的问题：
1. 程序直接退出
2. 权限对话框显示但无法交互，选择后程序退出

## 问题 1：程序直接退出

### 现象
运行 `bun run chat` 后，输入请求文件操作的命令，程序在 "Thinking..." 后立即退出。

### 排查过程
1. 确认测试脚本 (test-api-tools.ts) 正常工作
2. 确认 queryLoop 本身逻辑正确
3. 检查 Ink 渲染逻辑

### 结论
未找到根本原因，临时解决方案：简化权限处理，直接自动允许所有请求。

---

## 问题 2：权限对话框无法交互

### 现象
恢复权限确认 UI 后，对话框正确显示，但：
- 按 ↑↓ 键无法选择
- 按 Enter 无法确认
- 选择后程序继续执行，但显示重复的权限对话框

### 根本原因

**PermissionConfirm 组件没有处理键盘输入！**

组件只是静态显示选项和提示，但没有绑定任何键盘事件处理函数。

```tsx
// ❌ 错误的实现 - 没有键盘输入处理
export const PermissionConfirm = ({ request, onResponse }) => {
  const [selected, setSelected] = useState(0)
  // 缺少 useInput hook!

  return (
    // ... 显示界面 ...
    <Text>[↑↓] Select [Enter] Confirm [Esc] Deny</Text>
  )
}
```

### 解决方案

添加 `useInput` hook 来处理键盘事件：

```tsx
// ✅ 正确的实现
export const PermissionConfirm = ({ request, onResponse }) => {
  const [selected, setSelected] = useState(0)
  const options = [
    { label: 'Allow once', value: 'allow_once' as const },
    { label: 'Deny once', value: 'reject_once' as const },
  ]

  // 添加键盘事件处理
  useInput((input, key) => {
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1))
    } else if (key.downArrow) {
      setSelected((s) => Math.min(options.length - 1, s + 1))
    } else if (key.return) {
      const option = options[selected]
      onResponse({
        allowed: option.value === 'allow_once',
        option: option.value,
      })
    } else if (key.escape) {
      onResponse({ allowed: false, option: 'reject_once' })
    }
  })

  return (
    // ... 显示界面 ...
  )
}
```

---

## 经验总结

### 1. Ink 组件必须处理输入

在 Ink 中创建可交互组件（如菜单、对话框）时，必须使用 `useInput` hook 来绑定键盘事件。

常见模式：
```tsx
useInput((input, key) => {
  if (key.return) handleEnter()
  if (key.escape) handleEscape()
  if (key.upArrow) handleUp()
  if (key.downArrow) handleDown()
  // 其他按键处理...
})
```

### 2. 不要假设 UI 组件"应该能工作"

即使组件看起来正确（显示了文字和选项），如果没有绑定事件处理，它就是静态的、不可交互的。

### 3. 调试技巧

添加调试日志来追踪问题：
```tsx
for await (const step of queryLoop) {
  console.error(`[DEBUG] Step: ${step.type}`)
  // ...
}
```

### 4. 分离问题

- 先用测试脚本验证核心逻辑 (queryLoop)
- 再排查 UI 集成问题 (replLauncher)

---

## 相关文件

- `src/components/PermissionConfirm.tsx` - 权限确认组件
- `src/services/permissions.ts` - 权限检查逻辑
- `src/services/queryLoop.ts` - 工具调用循环
- `src/replLauncher.tsx` - REPL 入口集成