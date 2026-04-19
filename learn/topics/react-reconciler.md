# React Reconciler 学习笔记

## 问题 1: react-reconciler 是什么？为什么需要它？

### 定义
`react-reconciler` 是 React 核心包之一，负责协调 (reconcile) 组件和真实 UI 之间的变化。

### 解决的问题
- **虚拟 DOM 到真实环境的映射**: 标准 React 用 react-dom 将虚拟 DOM 转成 HTML
- **非浏览器环境**: 终端没有 div/span，需要自定义渲染方式
- **细粒度控制**: 手写 reconciler 可以完全控制渲染逻辑

### 工作流程
```
React组件 → Reconciler → 虚拟DOM → 真实环境
```

---

## 问题 2: reconciler.ts 在做什么？

### 核心实现 (HostConfig)

```typescript
const hostConfig = {
  // 1. 创建元素 - 将 React 组件转为 JS 对象
  createInstance(type: string) {
    return { type, children: [], props: {} }
  },

  // 2. 添加子元素
  appendChild(parent, child) {
    parent.children.push(child)
  },

  // 3. 从容器删除子元素
  removeChildFromContainer(container, child) {
    container.children = container.children.filter(...)
  },

  // ... 还有 insertChild, removeChild, getChildHostContext 等方法
}
```

### 作用
Reconciler 调用这些方法构建一个**纯 JS 对象树**，而不是真实 DOM。

---

## 问题 3: 对象树如何转成终端文本？

### 渲染架构概览

```
React组件 → React.createElement → 虚拟DOM → Reconciler + HostConfig 
                                                      ↓
                                            JS 对象树
                                                      ↓
                                            序列化器
                                                      ↓
                                           终端文本输出
```

### 第一步: 组件如何变成对象树？

以 Box 组件为例:

```typescript
// Box.tsx - 组件定义
export function Box({ children, style, ...props }: BoxProps): ReactNode {
  return React.createElement('box', { style, ...props }, children)
}
```

使用 `<Box><Text>Hello</Text></Box>` 时:

1. **React.createElement** 创建:
```javascript
{
  type: 'box',
  props: { style: {}, children: [Text组件] },
  key: null,
  ref: null
}
```

2. **Reconciler 处理** - 调用 hostConfig 方法:
```typescript
// reconciler.ts 中
createInstance('box')  // → { type: 'box', children: [], props: {} }
createInstance('text') // → { type: 'text', children: [], props: {} }
appendChild(box, text) // → box.children.push(text)
```

3. **最终对象树**:
```javascript
{
  type: 'box',
  props: { style: { display: 'flex' }, padding: 2 },
  children: [
    { type: 'text', props: { style: { color: 'red' }, children: 'Hello' } }
  ]
}
```

### 第二步: 对象树如何转终端文本？

需要实现**序列化器**:

```typescript
// 颜色代码映射
const ANSI_COLORS = {
  black: '30', red: '31', green: '32', yellow: '33',
  blue: '34', magenta: '35', cyan: '36', white: '37',
  reset: '0',
}

// 样式代码映射
const ANSI_STYLES = {
  bold: '1', dim: '2', italic: '3', underline: '4',
  blink: '5', reverse: '7', hidden: '8',
}

function styleToAnsi(style: Record<string, unknown>): string {
  const codes: string[] = []
  if (style.color) codes.push(ANSI_COLORS[style.color as string] || '37')
  if (style.bold) codes.push(ANSI_STYLES.bold)
  return codes.length ? `\x1b[${codes.join(';')}m` : ''
}

function serializeNode(node: any): string {
  if (!node) return ''
  
  const { type, props, children } = node
  
  // 文本节点 - 应用样式
  if (type === 'text') {
    const style = props?.style || {}
    const prefix = styleToAnsi(style)
    const suffix = prefix ? '\x1b[0m' : ''
    const content = props?.children?.toString() || ''
    return prefix + content + suffix
  }
  
  // Box 容器 - 递归处理子节点
  if (type === 'box') {
    return (children || []).map(serializeNode).join('')
  }
  
  return ''
}
```

### 第三步: 写入终端

```typescript
export async function render(node: any, options?: RenderOptions) {
  const stdout = options?.stdout || process.stdout
  
  // 1. 生成文本
  const text = serializeNode(node)
  
  // 2. 光标控制序列
  stdout.write('\x1b[2J')  // 清屏
  stdout.write('\x1b[H')   // 移动到左上角
  stdout.write(text)       // 写入内容
  stdout.write('\x1b[?25l') // 隐藏光标
  
  return { unmount: () => stdout.write('\x1b[?25h') }
}
```

### 实际输出示例

输入:
```jsx
<Box>
  <Text bold color="red">Hello</Text>
  <Text>World</Text>
</Box>
```

输出 (终端):
```
HelloWorld
```
(其中 "Hello" 是粗体红色)

---

## 问题 4: Ink 组件如何与 Reconciler 配合？

### 配合流程图

```
┌──────────────────────────────────────────────────────────────┐
│  开发者编写 React 组件                                        │
│  <Box flexDirection="column">                                  │
│    <Text bold>Title</Text>                                    │
│    <Text>Content</Text>                                       │
│  </Box>                                                        │
└──────────────────────┬───────────────────────────────────────┘
                       │ 
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  React.createElement (JSX 转换)                                │
│  → { type: 'box', props: {...}, children: [...] }            │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Reconciler + HostConfig                                      │
│  → { type: 'box', children: [text, text] }                   │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  序列化器 (renderToString)                                     │
│  → "\x1b[1mTitle\x1b[0m\nContent"                            │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  写入 stdout                                                  │
│  → 终端显示带格式的文本                                        │
└──────────────────────────────────────────────────────────────┘
```

### 各层职责

| 层级 | 职责 |
|------|------|
| **组件层** (Box/Text) | 定义 UI 结构和样式属性 |
| **Reconciler 层** | 构建/更新对象树 |
| **HostConfig** | 定义如何创建/组合节点 |
| **序列化层** | 将对象树转终端文本 |
| **输出层** | 写入终端，处理光标 |

### 关键理解

- **组件只是声明**: Box/Text 只是返回 React.createElement()
- **Reconciler 是引擎**: 负责执行更新逻辑
- **HostConfig 是适配器**: 决定如何构建对象
- **序列化是渲染**: 把对象变成可见输出

---

## 扩展: 为什么不用现成的 Ink 包?

Claude Code 选择手写 reconciler 的原因:
1. 需要完整控制终端 I/O (输入/输出/光标/颜色)
2. 需要与 ANSI 序列深度集成
3. 性能优化 - 避免额外抽象层
4. 功能定制 - 高级特性 (选择/鼠标/链接等)

---

## 实际文件位置对应

| 文件 | 作用 |
|------|------|
| `src/ink/core/reconciler.ts` | HostConfig 定义 - 创建/更新/删除节点 |
| `src/ink/core/root.ts` | 根容器创建 - reconciler.createContainer |
| `src/ink/components/Box.tsx` | UI 组件 - 返回 React.createElement |
| `src/ink/components/Text.tsx` | UI 组件 |
| `src/ink.ts` | 统一导出 |

---

## 下一步学习
- 如何实现完整的 renderToString
- ANSI 颜色和格式系统
- 终端输入事件处理