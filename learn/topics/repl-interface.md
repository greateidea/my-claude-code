# REPL 界面学习笔记

## Phase 5 完成内容

```
src/
├── replLauncher.tsx      # REPL 启动器
└── components/
    ├── screens/
    │   └── REPL.tsx     # REPL 屏幕组件
    └── messages/
        └── Messages.tsx # 消息列表组件
```

---

## REPL 组件结构

### REPL 主组件

```typescript
// src/components/screens/REPL.tsx
function REPL({ onSendMessage }) {
  const messages = useAppState(s => s.messages)
  
  return (
    <Box flexDirection="column">
      <Box borderStyle="bold" borderColor="cyan">
        <Text bold color="cyan">My Claude Code v0.1.0</Text>
      </Box>
      
      <Messages messages={messages} />
      
      <PromptInput onSubmit={handleSubmit} />
    </Box>
  )
}
```

### Messages 组件

```typescript
// src/components/messages/Messages.tsx
function Messages({ messages }) {
  return (
    <Box flexDirection="column">
      {messages.map(msg => (
        <Box key={msg.id}>
          <Text color={msg.type === 'user' ? 'green' : 'cyan'}>
            {msg.type === 'user' ? '> ' : '█ '}
          </Text>
          <Text>{msg.content}</Text>
        </Box>
      ))}
    </Box>
  )
}
```

### PromptInput 组件

```typescript
// src/components/PromptInput.tsx
function PromptInput({ onSubmit }) {
  const [input, setInput] = useState('')
  
  useInput((key) => {
    if (key.return) onSubmit(input)
    if (key.backspace) setInput(prev => prev.slice(0, -1))
  })
  
  return <Text>{input}_</Text>
}
```

---

## 使用方式

```bash
# 交互模式
my-claude-code chat

# 非交互模式 (传入 prompt)
my-claude-code chat -p "Hello world"
```

---

## 下一步 (Phase 6)

- 实现 Claude API 客户端
- 调用 AI 模型
- 处理响应和工具调用