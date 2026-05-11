# My Claude Code

A from-scratch implementation of [Claude Code](https://claude.ai/code) CLI, built as a learning vehicle to deeply understand how AI coding agents work under the hood.

**Stack:** Bun + Ink (React terminal UI) + DeepSeek API (NVIDIA also supported)

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

# Enter plan mode (or the model may call EnterPlanMode tool itself)
# In the REPL: type /plan "your task description"
```

Requirements: Bun >= 1.2.0

## What It Does

You type messages in a terminal. The LLM reasons, calls tools (bash, file read/write, web search, web fetch, glob/grep search, edit), sees results, and responds — in a loop until the task is done.

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
│   ├── PermissionConfirm.tsx # Permission dialog with keyboard navigation
│   └── PlanApprovalDialog.tsx # Plan review dialog with 3 options: proceed, clear context+auto, revise
├── services/
│   ├── api/deepseek.ts       # DeepSeekClient wrapping OpenAI SDK (DeepSeek/NVIDIA)
│   ├── plans.ts              # Plan file creation, approval handler, slug generation
│   ├── queryLoop.ts          # Core: async generator LLM ↔ tool execution loop
│   ├── toolOrchestration.ts  # Parallel/serial tool execution with semaphore
│   ├── permissions.ts        # Permission rules, modes, readonly heuristics
│   ├── persistence.ts        # JSONL conversation storage (append-only, per-session)
│   ├── sessionManager.ts     # PID-based process registry for live session tracking
│   ├── paths.ts              # Shared path utilities (~/.myclaude/ namespace)
│   ├── memory.ts             # Persistent memory system (MEMORY.md index)
│   └── claudemd.ts           # CLAUDE.md discovery and loading
├── tools/
│   ├── index.ts              # Tool registry (re-exports, AVAILABLE_TOOLS)
│   ├── types.ts              # Tool interface + helpers (readOnlyTool, writeTool)
│   ├── bash.ts / read.ts / write.ts / edit.ts  # Core file tools
│   ├── glob.ts / grep.ts     # File search tools
│   ├── calculate.ts          # Math expression evaluator
│   ├── enterPlanMode.ts / exitPlanMode.ts  # Plan mode lifecycle
│   ├── websearch/            # WebSearch: Bing scraping (no API key required)
│   │   ├── index.ts          # WebSearchTool definition
│   │   ├── bing.ts           # Bing HTML parser + redirect resolver
│   │   └── types.ts          # SearchResult, SearchOptions interfaces
│   └── webfetch/             # WebFetch: URL fetch + AI summarization
│       ├── index.ts          # WebFetchTool definition
│       ├── utils.ts          # HTTP fetch, turndown, cache, AI summarization
│       └── preapproved.ts    # ~80 preapproved developer domains
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
- **Plan mode** — `/plan` command or EnterPlanMode tool: read-only exploration phase, write plan to file, ExitPlanMode with approval dialog
- **Plan approval dialog** — interactive feedback input with cursor navigation, three approval options: proceed, clear context + auto mode, or revise
- **Clear context + auto mode** — wipes conversation history after plan approval, auto-sends a fresh `Implement the following plan:` message, switches to `acceptEdits` for unattended implementation
- **Streaming reasoning** — `reasoning_content` from DeepSeek thinking-mode models displayed in real-time
- **Multi-turn tool loop** — LLM calls tools, sees results, calls more tools, no hard turn limit
- **Permission system** — auto-allow readonly tools, ask for destructive ones, remember choices per session
- **Static/dynamic prompt separation** — static rules (cacheable), dynamic context (per-session)
- **CLAUDE.md loading** — project-level instructions injected as user context
- **Git context** — branch, status, recent commits snapshotted at conversation start
- **Web search** — scrapes Bing search results (no API key), resolves redirect URLs, client-side domain filtering
- **Web fetch** — fetches any URL, converts HTML to Markdown via turndown, AI-powered content summarization, 15-min TTL cache
- **Memory system** — type-based persistent memory (user/feedback/project/reference) with MEMORY.md indexing
- **IME-aware input** — CJK multi-character commit handled correctly via `useReducer`
- **Terminal animations** — bounce-glyph spinner, shimmer text sweep (setInterval-based, ~8fps)

## Design Philosophy

This project prioritizes **understanding over functionality**. Every feature is built from first principles after studying Claude Code's source. The goal isn't to clone Claude Code — it's to learn why certain architectural decisions were made and how they interact. The code favors clarity over cleverness, and the `learn/` directory captures design rationale that code alone can't convey.

## License

MIT
