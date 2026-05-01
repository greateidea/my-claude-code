/**
 * Thinking 配置类型 — 对齐 Claude Code 的 ThinkingConfig 设计
 *
 * 当前项目使用 NVIDIA API (OpenAI 兼容接口)，thinking 通过以下两种方式实现：
 * 1. 流式 reasoning_content — 模型原生支持（如 qwen3-thinking 系列）
 * 2. Prompt 引导 <thinking> XML 标签 — 纯文本模型的兜底方案
 */
export type ThinkingConfig =
  | { type: 'enabled' }   // 启用 thinking 提取
  | { type: 'disabled' }  // 禁用（不提取也不显示）

/** 默认配置 */
export const DEFAULT_THINKING_CONFIG: ThinkingConfig = { type: 'enabled' }
