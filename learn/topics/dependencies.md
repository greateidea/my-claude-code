# Claude Code 依赖详解

## 依赖分类

Claude Code 使用了很多依赖，按功能分类：

---

## 1. AI/LLM API 客户端

| 依赖 | 用途 |
|------|------|
| `@anthropic-ai/sdk` | Anthropic Claude API (主要) |
| `@anthropic-ai/bedrock-sdk` | AWS Bedrock (Claude on AWS) |
| `@anthropic-ai/vertex-sdk` | Google Vertex AI |
| `@aws-sdk/client-bedrock` | AWS Bedrock 运行时 |
| `@aws-sdk/client-sts` | AWS 身份验证 (STS) |
| `@aws-sdk/credential-providers` | AWS 凭证管理 |

**作用**: 连接各种 AI 服务提供商

---

## 2. MCP (Model Context Protocol)

| 依赖 | 用途 |
|------|------|
| `@anthropic-ai/mcpb` | MCP 引导程序 |
| `@modelcontextprotocol/sdk` | MCP SDK |

**作用**: MCP 服务器，允许 Claude 调用外部工具

---

## 3. 终端 UI

| 依赖 | 用途 |
|------|------|
| `react` | UI 框架 |
| `react-reconciler` | 自定义渲染器 |
| `chalk` | 终端颜色 |

---

## 4. 系统集成

| 依赖 | 用途 |
|------|------|
| `chokidar` | 文件监听 |
| `execa` | 执行命令 |
| `tree-kill` | 终止进程 |
| `ws` | WebSocket |
| `signal-exit` | 退出处理 |

---

## 5. 数据处理

| 依赖 | 用途 |
|------|------|
| `zod` | TypeScript 验证 |
| `yaml` | YAML 解析 |
| `diff` | 文本差异 |
| `lodash-es` | 工具函数 |

---

## 我们的选择

对于学习项目，我们不需要全部：

| 依赖 | 我们用 | 原因 |
|------|------|------|
| Anthropic SDK | ✅ | 核心 API 调用 |
| react | ✅ | UI 框架 |
| ink | ✅ | 终端 UI |
| chalk | ✅ | 颜色输出 |
| 其他 | ❌/后续 | 暂不需要 |

---

## 最少依赖列表

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.80.0",
    "react": "^19.2.0",
    "ink": "^7.0.0",
    "chalk": "^5.6.0",
    "commander": "^14.0.0"
  }
}
```