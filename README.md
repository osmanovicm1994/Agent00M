# agent-cli

A local, Copilot-CLI-style coding agent. It runs a tool-using loop against a **local model served by LM Studio** (OpenAI-compatible API on `localhost:1234`), reads and writes files in a *target project*, routes each task to a specialist agent, and asks you to approve every file write and shell command (unless auto mode is on).

Everything runs locally by default. The only feature that sends data off the machine is the optional Gemini research stage (opt-in).

The current references are `CLAUDE.md` (architecture and conventions) and `docs/AGENTS.md` (agents, routing, knowledge). `docs/MODELS.md` covers models and LM Studio settings.

## Quick start

```bash
npm install
npm run web:install            # once, only if you want the live dashboard
cp .env.example .env           # API keys go here (GEMINI_API_KEY, BRAVE_API_KEY, ...), never in .env.local
npm run chat                   # interactive session with .env.local
npm run chat:ui                # chat + live web dashboard
```

In LM Studio: start the local server, load the model, and set its **context length** larger than prompt + `AI_MAX_TOKENS`.

One-shot tasks:

```bash
npx ts-node src/cli.ts run "add a health check endpoint" -p /path/to/project
npx ts-node src/cli.ts run "npm run dev:api fails" -p /path/to/project -a debug
npx ts-node src/cli.ts run "add checkout with API, DB and UI" -p /path/to/project --team
npx ts-node src/cli.ts agents
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` (run after every change) |
| `npm test` | Unit tests (vitest): tools, routing, knowledge selection, command safety, cache, registry |
| `npm run build` | `tsc` to `dist/` (tests excluded) |
| `npm run models` / `npm run bench` | List LM Studio models / measure speed and tool calling |
| `npm run search:test -- "query"` | Diagnose web search engines |

Chat slash commands: `/help` lists them (`/agents`, `/use <id>`, `/auto`, `/model`, `/auto-write`, `/auto-run`, `/research`, `/plan`, `/team`, `/image`, `/clear`, `/exit`).

## How a task is handled

1. **Routing** (`src/agents/router.ts`, signals in `src/agents/orchestration.ts`): forced agent (`-a`, `/use`) > research-stage recommendation > keyword score with one strict winner > one capped model call > `dev`.
2. **Standards** (`src/knowledge/`): each agent always carries its own standards, the project's stack standards are detected automatically, and **task-specific standards** (logic standards such as edge cases, decomposition, distributed work, root causes; cross-domain files such as migration safety) are added from the task text.
3. **Execution** (`src/core/executor.ts`): read-only tools run together, writes and commands run one per turn with approval. Safety gates stay on in every mode.
4. **Team mode** (`/team`, `--team`): a Project Manager plans, engineers build, a read-only Safety Reviewer checks.

Agents: `dev`, `api`, `db`, `design` (frontend developer), `logic`, `kb-harvester`, `qa`, `debug`, `research`.

## Safety

- File tools are scoped to the target project. Real `.env` files cannot be read.
- Every write shows a diff and asks, unless auto mode is on. Risky commands (rm, sudo, git push/reset, kill, publish, shell redirects and `sed -i` that bypass the write gates ...) ask even in auto mode.
- **There is no sandbox.** Auto mode runs model-chosen commands on your machine. Use it only on projects under git; the agent warns when it is not.

## Seeing the UI

The model cannot see pictures. The `inspect_page` tool renders a localhost dev server (or a static `.html` file) in headless Chromium and returns facts: console errors, failed requests, horizontal overflow at phone and desktop widths, structure and accessibility problems. Run `npx playwright install chromium` once. Visual design still needs a human look.

## Adding things

New agent, tool or knowledge file: see `docs/AGENTS.md` section 5 and the Conventions section of `CLAUDE.md`. In short: create `src/agents/list/<id>.ts`, **register it in `src/agents/definitions.ts`**, add routing signals in `src/agents/orchestration.ts` only if they are specific, and run `npm run typecheck && npm test`.
