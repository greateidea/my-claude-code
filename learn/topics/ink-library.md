# Ink 库学习笔记

## 决策变更

**原来**: 手写 Ink 渲染器 (react-reconciler + 自定义组件)
**现在**: 使用 npm 上的 `ink` 库

### 原因
- 手写终端 UI 框架工作量巨大
- ink 库已经实现了完整的终端 UI 框架
- 可以专注业务逻辑而非基础设施

---

## ink 库简介

### 什么是 ink？

`ink` 是 React 在终端的渲染器，类似于 `react-dom` 但是用于终端。

```typescript
import { Box, Text, render } from 'ink'
import React from 'react'

const App = () => (
  <Box flexDirection="column">
    <Text bold color="green">Hello World</Text>
  </Box>
)

render(<App />)
```

### 核心组件

| 组件 | 作用 |
|------|------|
| `<Box>` | 容器，支持 flex 布局 |
| `<Text>` | 文本，支持颜色/样式 |
| `<Spacer>` | 空白间距 |
| `<Newline>` | 换行 |

### 核心 Hooks

| Hook | 作用 |
|------|------|
| `useInput` | 处理用户输入 |
| `useApp` | 获取应用实例 |
| `useStdin` | 获取 stdin |
| `useStdout` | 获取 stdout |
| `useFocus` | 焦点管理 |

---

## 与手写版本的对比

### 手写版本 (已废弃)

```
src/ink/
├── core/
│   ├── types.ts
│   ├── reconciler.ts   // 200+ 行
│   └── root.ts
├── components/
│   ├── Box.tsx
│   ├── Text.tsx
│   └── Button.tsx
└── hooks/
    ├── useInput.ts
    ├── useTerminalSize.ts
    └── useStdin.ts
```

### ink 版本 (当前)

```
src/
└── ink.ts   // 重新导出 ink 库
```

**减少**: ~500 行基础设施代码

---

## 使用示例

### 基本布局

```typescript
import { Box, Text, render } from 'ink'
import React from 'react'

function MyApp() {
  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="cyan">
        <Text bold color="cyan">My App</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Content goes here</Text>
      </Box>
    </Box>
  )
}

render(<MyApp />)
```

### 处理输入

```typescript
import { useInput } from 'ink'

function MyComponent() {
  useInput((input, key) => {
    if (key.return) {
      console.log('Enter pressed!')
    }
    if (key.escape) {
      process.exit(0)
    }
  })
  
  return <Text>Press Enter or Escape</Text>
}
```

---

## 下一步

结合 Phase 4-5，学习如何:
- 管理应用状态 (AppState)
- 实现完整的 REPL 交互界面
- 调用 Claude API