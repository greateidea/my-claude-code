# Claude Code 源码研究

## 项目架构发现

### 技术栈
- **运行时**: Bun (不是 Node.js)
- **构建**: Bun.build() with code splitting
- **UI 框架**: React + 自定义 Ink 渲染器 (forked internal)
- **模块系统**: ESM, TSX with react-jsx
- **Monorepo**: Bun workspaces

### 核心模块
1. **入口点** (`src/entrypoints/cli.tsx`): 处理快速路径 (--version 等)
2. **主 CLI** (`src/main.tsx`): Commander.js 定义，约 6600 行
3. **API 层** (`src/services/api/claude.ts`): Anthropic SDK 封装
4. **查询循环** (`src/query.ts`): 核心 API 调用逻辑
5. **查询引擎** (`src/QueryEngine.ts`): 高级编排器
6. **REPL 屏幕** (`src/screens/REPL.tsx`): 交互界面，约 7000+ 行
7. **Ink 框架** (`src/ink/`): 自定义 React 终端渲染器
8. **组件系统** (`src/components/`): 170+ React 组件
9. **状态管理** (`src/state/`): AppState + Zustand-style store
10. **工具系统** (`src/tools/`): 61 个工具目录

### 特性标志系统
- 通过 `import { feature } from 'bun:bundle'` 使用
- 环境变量 `FEATURE_<FLAG_NAME>=1` 启用
- Dev 模式默认启用: BUDDY, TRANSCRIPT_CLASSIFIER, BRIDGE_MODE, AGENT_TRIGGERS_REMOTE, CHICAGO_MCP, VOICE_MODE

### UI 渲染层次
1. `src/ink.ts` - Ink 渲染包装，注入 ThemeProvider
2. `src/ink/` - 自定义 reconciler, hooks, virtual list
3. `src/components/` - 业务组件 (Messages, PromptInput, permissions 等)
4. `src/components/design-system/` - 基础 UI 组件 (ThemedBox, Dialog 等)

### 关键类型文件
- `src/types/message.ts` - 消息类型层级
- `src/types/permissions.ts` - 权限类型
- `src/types/global.d.ts` - 全局声明 (MACRO, BUILD_TARGET)