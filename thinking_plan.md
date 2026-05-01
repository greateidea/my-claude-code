# Thinking 机制对齐 Claude Code — 实施计划

## Context

当前项目的 thinking 实现依赖 prompt 引导模型输出 `<thinking>` XML 标签，而 qwen3-thinking 模型原生支持流式 `reasoning_content`。需要逐步缩小与 Claude Code thinking 架构的差距，核心是：启用流式获取原生 reasoning、将 ThinkingConfig 真正接入控制链路、UI 交互对齐。

## 4 个阶段（按依赖排序）

### Phase 1: 修复 `streamChat()` 支持 tool_calls 累积

**文件：** `src/services/api/deepseek.ts`

- **ChatResponse 接口**：增加 `reasoning?: string` 字段
- **streamChat() 重写**：
  - 用 `Map<index, {id, name, arguments}>` 增量累积流式 tool_calls 片段
  - 累积 `fullReasoning` 到返回值
  - 捕获最后一个 chunk 的 usage 数据
- **chat() 增强**：非流式响应也提取 `reasoning_content`

### Phase 2: 启用流式 + 原生 reasoning

**文件：** `src/services/queryLoop.ts`

- 导入 `ThinkingConfig`，扩展 `QueryLoopConfig` 增加 `thinkingConfig` 和 `onThinkingChunk` 字段
- 当 `thinkingConfig.type === 'enabled'` 时，调用 `client.chat()` 时传 `stream: true`
- 用 `onThinkingChunk` 回调实时推送 reasoning 到 UI
- 优先使用 `response.reasoning`（原生），回退到 XML `<thinking>` 正则
- 流式返回的 tool_calls 走现有处理逻辑（Phase 1 确保返回完整）

### Phase 3: Wiring — ThinkingConfig 接入组件树

**文件：** `src/replLauncher.tsx`

- `handleSend()` 中向 `createQueryLoop` 传入 `thinkingConfig: { type: 'enabled' }` 和 `onThinkingChunk` 回调
- `onThinkingChunk` 实时调用 `setThinkingContent` 实现流式显示

### Phase 4: UI 交互对齐

**文件：** `src/components/ThinkingMessage.tsx`、`src/components/messages/Messages.tsx`、`src/components/PromptInput.tsx`、`src/components/screens/REPL.tsx`

- **默认折叠**：`ThinkingMessage` 的 `defaultExpanded` 改为 `false`，初始只显示 "∴ Thinking (T to expand)"
- **hidePastThinking**：Messages 组件增加 `hidePastThinking` prop，开启时只渲染最新一条 assistant 消息的 thinking
- **Keyboard toggle**：
  - PromptInput 增加 `onToggleThinking` prop，空输入时按 `T` 触发
  - ThinkingMessage 改为支持受控模式（`expanded` + `onToggle` props）
  - App → REPL → PromptInput 链传递 toggle 回调

## 验证方式

1. 每个 Phase 完成后运行 `bun run typecheck` 确保编译通过
2. Phase 2 完成后 `bun run dev`，发送需要工具的问题验证 tool calls + 流式 thinking
3. Phase 4 完成后验证：默认折叠、按 T 展开/折叠、只有最新消息显示 thinking

## 进度

| Phase | 状态 | 完成时间 |
|-------|------|---------|
| Phase 1 | ✅ 已完成 | - |
| Phase 2 | ✅ 已完成 | - |
| Phase 3 | ✅ 已完成 | - |
| Phase 4 | ✅ 已完成 | - |
