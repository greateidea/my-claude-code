# My Claude Code

A from-scratch implementation of [Claude Code](https://claude.ai/code) CLI, built as a learning vehicle to deeply understand how AI coding agents work under the hood.

**Stack:** Bun + Ink (React terminal UI) + NVIDIA API (Qwen3)

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Set your API key (get one from https://build.nvidia.com/)
cp .env_example .env
# Edit .env with your NVIDIA_API_KEY

# 3. Start the REPL
bun run dev

# Or send a one-shot message
bun run chat "explain this project structure"
```

Requirements: Bun >= 1.2.0

## What It Does

You type messages in a terminal. The LLM reasons, calls tools (bash, file read/write, glob search), sees results, and responds — in a loop until the task is done.

```
You: list all TypeScript files and count lines
┌─────────────────────────────────────────┐
│ ✶ Thinking...                           │
│ ∴ Thinking (T to expand)                │
└─────────────────────────────────────────┘
Assistant: Found 15 TypeScript files totaling 2,340 lines...
```

## Architecture

The system follows a three-layer prompt pipeline inspired by studying Claude Code's internals:

```
User message → handleSend()
  ├─ loadMemoryPrompt()     → dynamic section: memory usage guide + existing memories
  ├─ loadClaudeMdFiles()    → user context: project rules via <system-reminder>
  ├─ getGitContext()        → dynamic section: branch, status, recent commits
  └─ buildSystemPrompt()    → assembles string[] with static/dynamic boundary

createQueryLoop() — async generator
  └─ loop: LLM chat → extract tool calls → execute tools → feed results back
       └─ yields QueryStep { type: 'thinking' | 'message' | 'tool' | 'permission' }
```

**Key design decisions (all learned from Claude Code):**
- Static/dynamic prompt separation with `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`
- CLAUDE.md injected as `<system-reminder>` user context, not system prompt
- Memory system with index/content file separation and type taxonomy
- Tool orchestration with concurrent safety awareness and permission interleaving

More detail in [`learn/topics/`](learn/topics/).

## Commands

```bash
# Development
bun run dev                    # Start interactive REPL
bun run chat "msg"             # Send one message, get response
bun test                       # Run tests
bun run typecheck              # Type-check the project

# Session management
bun run dev -- --continue      # Resume the most recent session
bun run dev -- --resume <id>   # Resume a specific session by ID
bun run dev -- --list-sessions  # List all saved sessions
```

## Project Structure

```
src/
├── entrypoints/cli.tsx       # CLI args parsing (--continue, --resume, --list-sessions)
├── main.tsx                  # Calls launchRepl() with options
├── replLauncher.tsx          # App + handleSend: prompt assembly, streaming, per-turn persistence
├── components/
│   ├── screens/REPL.tsx      # Main layout: messages + prompt + status bar
│   ├── PromptInput.tsx       # Raw mode stdin handler (useReducer + IME fix)
│   ├── messages/Messages.tsx # Message list with tool call cleanup
│   ├── ThinkingMessage.tsx   # Collapsible thinking display
│   └── PermissionConfirm.tsx # Permission dialog with keyboard navigation
├── services/
│   ├── api/deepseek.ts       # DeepSeekClient wrapping OpenAI SDK → NVIDIA API
│   ├── queryLoop.ts          # Core: async generator LLM ↔ tool execution loop
│   ├── toolOrchestration.ts  # Parallel/serial tool execution with semaphore
│   ├── permissions.ts        # Permission rules, modes, readonly heuristics
│   ├── persistence.ts        # JSONL conversation storage (append-only, per-session)
│   ├── sessionManager.ts     # PID-based process registry for live session tracking
│   ├── paths.ts              # Shared path utilities (~/.myclaude/ namespace)
│   ├── memory.ts             # Persistent memory system (MEMORY.md index)
│   └── claudemd.ts           # CLAUDE.md discovery and loading
├── tools/index.ts            # Tool definitions: Bash, Read, Write, Glob, Grep, Calculate
├── state/
│   ├── store.ts              # Minimal external store (Zustand-like)
│   ├── AppStateStore.ts      # AppState + Message types
│   └── AppState.tsx          # React context + subscription hooks
├── bootstrap/state.ts        # Session initialization (UUID, resume, project root)
└── types/session.ts          # SessionKind type

tests/                        # Standalone test scripts (no mocking)
learn/topics/                 # Deep-dive learning documents
```

## Features

- **Session persistence** — conversations saved as append-only JSONL in `~/.myclaude/projects/<hash>/<sessionId>.jsonl`
- **Session resume** — `--continue` restores the most recent session, `--resume <id>` picks a specific one
- **PID process registry** — `~/.myclaude/sessions/<pid>.json` tracks live sessions, orphans auto-cleaned
- **Tool calls round-trip** — `tool_calls` and `tool_call_id` preserved in JSONL so resumed sessions feed the LLM correctly
- **Streaming reasoning** — `reasoning_content` from Qwen3 models displayed in real-time
- **Multi-turn tool loop** — LLM calls tools, sees results, calls more tools, up to 5 turns
- **Permission system** — auto-allow readonly tools, ask for destructive ones, remember choices per session
- **Static/dynamic prompt separation** — static rules (cacheable), dynamic context (per-session)
- **CLAUDE.md loading** — project-level instructions injected as user context
- **Git context** — branch, status, recent commits snapshotted at conversation start
- **Memory system** — type-based persistent memory (user/feedback/project/reference) with MEMORY.md indexing
- **IME-aware input** — CJK multi-character commit handled correctly via `useReducer`
- **Terminal animations** — bounce-glyph spinner, shimmer text sweep (setInterval-based, ~8fps)

## Design Philosophy

This project prioritizes **understanding over functionality**. Every feature is built from first principles after studying Claude Code's source. The goal isn't to clone Claude Code — it's to learn why certain architectural decisions were made and how they interact. The code favors clarity over cleverness, and the `learn/` directory captures design rationale that code alone can't convey.

## License

MIT
