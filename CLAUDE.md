# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A custom implementation of Claude Code CLI in ~500 LOC, built with Bun + Ink (React for terminal UI) + NVIDIA API. The app is a terminal REPL that chats with an LLM and executes tools (bash, file read/write, glob) via an async generator query loop.

## Conventions

**Namespace isolation**: To avoid conflicts with the real Claude Code, use `myclaude` instead of `.claude` in all paths:
- `~/.myclaude/` instead of `~/.claude/`
- `myclaude/CLAUDE.md` instead of `.claude/CLAUDE.md`
- `~/.myclaude/projects/<project>/memory/` instead of `~/.claude/projects/<project>/memory/`

This applies to all file paths, directory names, and configuration references in source code and prompts.

## Commands

```bash
# Development (start REPL)
bun --env-file=.env run dev

# Send a one-shot message
bun --env-file=.env run chat "your message"

# Run all tests
bun test

# Type-check
bun run typecheck
```

## Architecture

```
src/
├── entrypoints/cli.tsx     # CLI entry point — parses args, routes to main()
├── main.tsx                # Calls launchRepl()
├── replLauncher.tsx        # App component + launchRepl(): renders Ink app, handles messages, streaming, permissions, tool calls
├── ink.ts                  # Re-exports from ink (Box, Text, useInput, etc.)
├── components/
│   ├── screens/REPL.tsx    # Main REPL layout (messages + prompt + status indicators)
│   ├── messages/Messages.tsx # Renders message list, strips XML tool tags
│   ├── PromptInput.tsx     # Raw stdin handler (raw mode, arrow key filtering)
│   └── PermissionConfirm.tsx # Permission dialog with ↑↓ navigation
├── services/
│   ├── api/deepseek.ts     # DeepSeekClient wrapping OpenAI SDK → NVIDIA API
│   ├── queryLoop.ts        # Core: async generator that loops LLM ↔ tool execution
│   ├── toolOrchestration.ts # Semaphore-based serial/concurrent tool execution
│   └── permissions.ts      # PermissionManager: rules, modes, readonly heuristics
├── state/
│   ├── store.ts            # Minimal Zustand-style store (getState/setState/subscribe)
│   ├── AppStateStore.ts    # AppState type + Message type
│   └── AppState.tsx        # React context provider + useAppState/useSetAppState hooks
├── tools/index.ts          # Tool definitions (Bash, Read, Write, Glob, Calculate) with zod schemas
└── bootstrap/state.ts      # Session initialization (UUID, project root stub)
```

## Key Patterns

**Query loop** (`services/queryLoop.ts`): The core is `createQueryLoop()`, an async generator. Each iteration sends messages to the LLM, extracts `<tool_call>` XML (or native tool_calls), executes tools, feeds results back as user messages, and yields `QueryStep` objects (`{ type: 'message' | 'tool' | 'thinking' | 'permission' | 'error' }`). Max turns configurable.

**Tool orchestration** (`services/toolOrchestration.ts`): `partitionToolCalls()` groups calls into batched by concurrency safety. Concurrently-safe tools execute in parallel via a `Semaphore` (max 10); write tools execute serially with permission checks interleaved.

**State management**: Custom `createStore()` implements a minimal external store (like Zustand). `useAppState(selector)` wraps `useSyncExternalStore` to subscribe React components.

**Permissions**: `PermissionManager` classifies tools as readonly (auto-allow), checks against allow/deny/ask rules, supports modes (`default`, `acceptEdits`, `plan`, `dontAsk`), and bash heuristic (known readonly commands auto-allowed).

**API client** (`services/api/deepseek.ts`): Wraps OpenAI SDK pointing at `https://integrate.api.nvidia.com/v1`. Default model: `nvidia/nemotron-3-super-120b-a12b`. Supports streaming with reasoning content extraction.

## Environment

Requires Bun >= 1.2.0. Set `NVIDIA_API_KEY` or `DEEPSEEK_API_KEY` in `.env` (copy from `.env_example`). Get keys from https://build.nvidia.com/.

## Testing

Tests live in `tests/` as standalone `.ts` scripts that import from `./src/...` (Bun resolves via `--env-file`). Each test instantiates `DeepSeekClient` and exercises `createQueryLoop()` directly — no mocking. Run individually with `bun run tests/test-chat.ts`.

## Claude Code Source Code Path
The 【Claude Code】 source code is stored in path: "~/nodecode/claude-code"。When it is necessary to research the Claude Code source code, go to that path to access the source code.


