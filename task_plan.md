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

### Phase 8: 集成 REPL ✅ IN_PROGRESS
- [x] 循环集成到 replLauncher
- [ ] 流式内容到 UI
- [ ] 工具结果显示

---

### Phase 9: 基础工具集
- [ ] BashTool (执行命令)
- [ ] FileReadTool (读取文件)
- [ ] FileWriteTool (写入文件)
- [ ] GlobTool (文件搜索)

### Phase 10: 工具权限机制
- [ ] 工具权限确认 UI
- [ ] 权限状态管理

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

## 当前状态 (2024-04-19)

### 已完成
- CLI 框架 + Ink UI
- 状态管理
- REPL 界面 (带闪烁光标)
- API 对话 (qwen 模型)
- 核心循环 queryLoop (async generator)
- 工具系统 (zod schema)
- 部分工具调用完成

### 进行中
- 循环集成到 REPL

### 待完成
- 工具: Bash, FileRead, FileWrite
- 权限 UI
- 上下文压缩
- 文档完善

---

## 下一步
Phase 8: 完成 REPL 循环集成，添加更多工具