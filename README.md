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

## Building a full-stack app with the agent (Next.js + NestJS)

A whole app does not fit in one prompt. The agent works reliably on one slice at a time: one prompt, one result you can check with a command. Run each prompt as its own task, in this order, on a folder that is a git repository (auto mode asks for that).

```bash
mkdir ~/my-app && cd ~/my-app && git init     # a new, empty project folder
cd /path/to/agent-cli
npx ts-node src/cli.ts run "<prompt 1>" -p ~/my-app -y --no-mcp
```

Or start `npm run chat`, answer the startup questions (existing project: yes, the folder; auto-write and auto-run: yes), and paste the prompts one after the other. Wait for each one to finish and read its summary (what ran, what passed, what was NOT verified) before sending the next.

**Do you have to name the stack in every prompt?** No, but one of two places must name it, because a small local model picks its stack from habit (often older or different from yours) and the matching standards are only loaded when the stack is recognised. Either put it in the project once: copy `docs/templates/AGENTS.fullstack.md` to the project root as `AGENTS.md` (the agent reads it on every task, so it builds in your stack) and edit it; or name it in the prompt. Standards are loaded from two things: the words of the task (a prompt that says Next.js or Prisma or Docker loads those standards) and the files already in the project (`package.json` with Next, Nest or Prisma, `.csproj`, `Package.swift`, `build.gradle` and similar). So a brand-new project gets the Nest/Prisma/Docker standards only if the prompt mentions them; once the app exists on disk, they load by themselves. Standards exist for Next.js, NestJS, Prisma, JWT, R2, Docker, CI, Playwright, Appium, C#, Python FastAPI, iOS (SwiftUI) and Android (Compose). A stack without a standard still works, but without the agent's own guidance for it.

**Prompt rules that matter**
1. Name the exact paths (`apps/web`, `apps/api`, `apps/api/src/health/health.controller.ts`). The agent stops guessing and your checks can find the files.
2. End every prompt with the command that must pass: `npm --prefix apps/api run build` must succeed, `npm --prefix apps/api test` must pass. The agent runs it, reads the failure and fixes it. Without that sentence it often stops after writing files.
3. One concern per prompt. Do not combine "auth and uploads and the login page".
4. Say what must NOT happen when it matters (no secrets in code, no tokens in localStorage, no `next/font/google`).

**First prompt: scaffold** (the agent loads a scaffolding standard with the exact commands: `mkdir -p apps`, `npx --yes create-next-app@latest apps/web ...`, `cd apps && npx --yes @nestjs/cli@latest new api ...`)

> Create a monorepo in this folder with two apps: apps/web (Next.js App Router, TypeScript, Tailwind CSS) and apps/api (NestJS, TypeScript). Add a root package.json WITHOUT npm workspaces (each app keeps its own package.json, node_modules and package-lock.json) whose scripts are dev:api, dev:web, build and test, each forwarding with `npm --prefix apps/<app> run ...`. Add a root .gitignore that ignores node_modules, .next, dist and .env files, and a short root README.md. Do not use next/font/google. Then run `npm --prefix apps/api run build` and `npm --prefix apps/web run build`; both must succeed.

**Next prompts**: use the `task` text of each slice in `bench/fullstack/spec.json`, in order (health endpoint, typed config, Prisma schema, users, JWT auth, refresh rotation, guard, tasks CRUD, ownership test, pagination, R2 upload, design system, login page, tasks page, API URL env, Docker, CI, Playwright, README). Every one of them already names its paths and its verify command. Read the file, copy the slice you want, change names to your app.

When something fails: paste the error into a new task (`run "npm --prefix apps/api test fails: <error>" -a debug`) or `/use debug` in chat. Do not ask for the next feature while the current slice is red: the next slice then builds on a broken one.

### How the agent tests what it builds

- After it changes code, it is asked once to run a check (typecheck, test or build) before it may finish (verify gate). If the last command failed and nothing changed since, it is asked once to fix it or say plainly that it still fails. After the same error three times in a row it is told to stop and report instead of looping.
- It only runs what exists: the check is the prompt's "X must pass" command or a `typecheck` / `test` / `build` script in `package.json`. A project with no tests gets none unless the prompt asks for them (slices ask for unit tests, the ownership test and Playwright tests).
- It cannot prove that the app looks right or works against a real database or R2. `inspect_page` reports console errors, failed requests and overflow for a page that is running; the rest is "Not verified" in its summary.

### Benchmark (optional)

`npm run bench:fullstack` is NOT needed to build an app. It runs the slices of `bench/fullstack/spec.json` through the agent automatically in a fresh folder and checks each with plain commands (files exist, build passes, tests pass), to measure how far the agent and model get and to compare before and after a change. Try it first without a model: `npm run bench:fullstack -- --baseline`. Details: `docs/FULLSTACK_READINESS.md`, Phase 0.

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
