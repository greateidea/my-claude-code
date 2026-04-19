# My Claude Code 工程规范

## 核心原则

### 1. 模块化与解耦
- 每个功能模块单独文件，不做超长文件
- 相似功能归类到同一目录
- 目录结构反映代码架构

### 2. 单入口原则
- 避免模块被多次加载导致重复执行
- 顶层入口只负责路由，不直接执行业务逻辑
- 使用 guard 确保 main() 只执行一次

### 3. 优先使用成熟库
- 终端 UI: 使用 `ink` 库而非手写
- 颜色: 使用 `chalk` 库
- 只在需要深度定制时才手写

### 4. 单一职责
- 每个文件/函数只负责一件事
- 复杂逻辑拆分为多个函数/模块

### 4. 依赖明确
- 导入路径清晰，避免循环依赖
- 入口文件只做导入和路由

## 目录结构规范

```
src/
├── entrypoints/       # 入口点 (cli.tsx, main.tsx)
├── commands/          # 命令定义
├── services/          # 业务服务 (api, mcp, auth)
├── components/       # UI 组件
│   ├── design-system/ # 基础 UI 组件
│   └── screens/       # 屏幕组件
├── hooks/            # 自定义 Hooks
├── state/            # 状态管理
├── utils/            # 工具函数
├── types/            # 类型定义
└── ink/              # Ink 渲染器核心
```

## 代码规范

### 文件命名
- 组件: PascalCase (App.tsx, Button.tsx)
- 工具: camelCase (format.ts, logger.ts)
- 类型: camelCase.types.ts 或 Types.ts

### 函数设计
- 单一职责
- 命名清晰表达意图
- 避免副作用 (除明确标记的 side-effect 文件)

### 错误处理
- 业务错误返回 Result 类型或抛出明确异常
- 不吞掉原始错误

## 禁止事项

- 不创建超 500 行的单一文件
- 不在入口文件直接执行业务逻辑
- 不在模块顶层执行副作用 (除 init/hook 文件)
- 不跳过 lint 检查