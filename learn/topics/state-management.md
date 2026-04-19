# 状态管理学习笔记

## Phase 4 完成内容

实现了 Zustand-style 状态管理:

```
src/
├── state/
│   ├── store.ts         # 核心 store 实现
│   ├── AppStateStore.ts # 状态类型定义
│   └── AppState.tsx     # React Provider + hooks
└── bootstrap/
    └── state.ts         # 会话级单例状态
```

---

## Store 实现 (Zustand-style)

```typescript
// src/state/store.ts
export function createStore<T>(initialState: T) {
  let state = initialState
  const listeners = new Set<() => void>()

  return {
    getState: () => state,
    
    setState: (updater) => {
      const next = updater(state)
      if (Object.is(next, state)) return  // 没有变化则不触发
      state = next
      listeners.forEach(l => l())  // 通知所有订阅者
    },
    
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)  // 取消订阅
    }
  }
}
```

---

## AppState 结构

```typescript
interface AppState {
  messages: Message[]        // 对话消息
  inputText: string          // 用户输入
  isLoading: boolean         // 加载状态
  error: string | null       // 错误信息
  
  sessionId: string          // 会话 ID
  cwd: string                // 当前目录
  model: string              // 模型名称
  
  toolPermissions: ToolPermission[]  // 工具权限
  showSidebar: boolean       // 侧边栏显示
  selectedMessageId: string | null   // 选中的消息
}
```

---

## React 集成

```typescript
// src/state/AppState.tsx

// 1. 创建 Context
const AppStoreContext = React.createContext<Store | null>(null)

// 2. Provider 组件
function AppStateProvider({ children }) {
  const [store] = useState(() => createStore(defaultState))
  return (
    <AppStoreContext.Provider value={store}>
      {children}
    </AppStoreContext.Provider>
  )
}

// 3. 使用 hook (自动订阅更新)
function MyComponent() {
  const messages = useAppState(s => s.messages)
  const setState = useSetAppState()
  
  // 当 messages 变化时组件自动更新
}
```

---

## 关键概念

| 概念 | 说明 |
|------|------|
| `getState()` | 获取当前状态 |
| `setState()` | 更新状态 |
| `subscribe()` | 订阅状态变化 |
| `useSyncExternalStore` | React 18 外部状态订阅 |

---

## 下一步 (Phase 5)

- 实现完整的 REPL 交互界面
- 消息显示组件
- 用户输入处理