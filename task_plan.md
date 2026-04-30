# My Claude Code 实现计划 (调整版)

## 核心理念
采用方案 A：先完成基础功能，逐步深入学习核心机制

---

## 阶段规划

### Phase 1: 环境搭建 ✅ COMPLETED
- [x] package.json, tsconfig.json
- [x] 依赖安装 (ink, react, chalk, commander)
- [x] 项目结构

### Phase 2: CLI 框架 ✅ COMPLETED
- [x] 入口点 (cli.tsx)
- [x] Commander 定义
- [x] 子命令 (chat, mcp, doctor)

### Phase 3: Ink UI ✅ COMPLETED
- [x] 使用 ink 库
- [x] 基础组件 (Box, Text)
- [x] hooks

### Phase 4: 状态管理 ✅ COMPLETED
- [x] Zustand-style store
- [x] AppState 类型
- [x] bootstrap/state

### Phase 5: REPL 界面 ✅ COMPLETED
- [x] REPL 屏幕组件
- [x] Messages 组件
- [x] PromptInput 组件 (带闪烁光标)

### Phase 6: 基础 API 对话 ✅ COMPLETED
- [x] DeepSeek/NVIDIA 客户端
- [x] 多轮上下文传递
- [x] 流式输出 (streaming)
- 注意: 使用 qwen 模型 (glm5 模型未启用)

---

### Phase 7: 工具调用循环 ✅ COMPLETED
- [x] queryLoop.ts 核心循环
- [x] zod 工具 schema 定义
- [x] findToolCalls 解析
- [x] 工具执行器
- [x] system prompt 构建

### Phase 8: 集成 REPL ✅ COMPLETED
- [x] 循环集成到 replLauncher
- [x] 流式内容到 UI
- [x] Thinking 内容显示
- [x] 工具结果显示

---

### Phase 9: 基础工具集 ✅ COMPLETED
- [x] BashTool (执行命令)
- [x] FileReadTool (读取文件)
- [x] FileWriteTool (写入文件)
- [x] GlobTool (文件搜索)

### Phase 10: 工具权限机制 ✅ COMPLETED
- [x] 工具权限确认 UI (PermissionConfirm 组件, 方向键选择, Enter 确认, Esc 拒绝)
- [x] 权限状态管理 (PermissionManager: 规则系统, 模式切换, 会话记忆)
- [x] 只读工具自动允许 (Read, Glob, Grep — 无需确认)
- [x] 只读 bash 命令自动允许 (ls, cat, grep, find, git status/log/diff 等)
- [x] 权限规则匹配 (支持 Bash(命令), Write(路径), Edit(路径), WebFetch(domain:域名) 等模式)
- [x] 权限模式支持 (default, acceptEdits, plan, dontAsk, bypassPermissions)
- [x] 会话级权限记忆 (addSessionRule — 同一 session 内相同工具+参数不再重复询问)
- [x] 工具并行执行时的权限串行检查 (避免并发权限对话框)
- [x] 与 queryLoop 和 replLauncher 的完整集成

---

### Phase 11+: 高级功能 (后续深入)

#### 上下文管理
- [ ] CLAUDE.md 加载
- [ ] 项目上下文构建
- [ ] 对话压缩

#### MCP 集成
- [ ] MCP 客户端
- [ ] 工具注册

#### 代理系统
- [ ] Agent tool
- [ ] 子进程管理

---

## 决策记录

| 决策 | 原因 |
|------|------|
| 使用 NVIDIA API | 无需申请 Anthropic 账号 |
| 使用 qwen 模型 | glm5 模型账户未启用 |
| 使用 ink 库 | 减少工作量 |
| 使用 zod 定义工具 | 更可靠的 schema |
| 方案 A 分阶段 | 学习曲线更平缓 |

---

## 当前状态 (2026-04-30)

### 已完成 (Phase 1-10)
- CLI 框架 + Ink UI + REPL 界面
- Zustand-style 状态管理 (useSyncExternalStore)
- NVIDIA API 对话 (qwen/qwen3-next-80b-a3b-thinking)
- 核心循环 queryLoop (async generator, 含 thinking 提取和流式输出)
- 工具系统 (Bash, Read, Write, Glob, Calculate + zod schema + 并发安全标记)
- 工具编排 (Semaphore 控制, 串行/并发自动分区, max 10 并发)
- 完整权限机制 (PermissionManager + PermissionConfirm UI)
- 会话权限记忆 (避免同一操作重复弹窗)
- Native tool calling 支持 (正确发送 tool_calls 和 tool result 消息)
- 进程生命周期管理 (Ctrl+C 退出, setInterval 保持活跃)

### 当前焦点
Phase 11: 上下文管理与高级功能

### 待完成
- CLAUDE.md 项目上下文加载
- 对话历史压缩 (context window 管理)
- MCP 客户端集成
- Agent tool (子进程管理)