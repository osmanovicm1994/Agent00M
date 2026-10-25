# Maintaining the Agent CLI

This guide maps the agent CLI, its specialist agents, team orchestration, and the monitoring web UI. It is an operational index; the linked architecture documents remain the detailed design references.

For a visual overview of the full runtime and subsystem connections, see [`AGENT_SYSTEM_GRAPH.md`](AGENT_SYSTEM_GRAPH.md).

## Start here

| If you want to… | Read / inspect |
| --- | --- |
| Understand user commands and end-to-end flow | `README.md`, `src/cli.ts` |
| Change one specialist | `docs/AGENTS.md`, `src/agents/list/`, `src/agents/definitions.ts` |
| Change routing or knowledge selection | `src/agents/router.ts`, `src/agents/orchestration.ts`, `src/agents/helpers.ts` |
| Change team planning or execution | `src/team/`, especially `orchestrator.ts`, `parallel.ts`, `roles.ts` |
| Change parallel scheduling or automatic debugging | `docs/ORCHESTRA.md`, `src/orchestra/`, `src/orchestra/wire.ts` |
| Change dashboard presentation | `web/src/Dashboard.tsx`, `web/src/state.ts`, `web/src/protocol.ts` |
| Change dashboard server/events/control | `src/server.ts`, `src/core/events.ts`, `src/core/control.ts`, `src/core/event-types.ts` |
| Change LLM providers/models | `src/llm/`, `docs/MODELS.md`, `.env.example` |
| Change prompt writing guidance | `docs/PROMPTING.md` (also loaded by dashboard through `src/core/guide.ts`) |
| Change engineering knowledge | `src/knowledge/README.md`, `src/knowledge/` |

## System map

```text
src/cli.ts
  ├─ src/agents/router.ts + orchestration.ts ── selects one specialist
  ├─ src/core/executor.ts + tools/ ──────────── executes guarded tool loop
  ├─ src/team/orchestrator.ts ───────────────── optional PM/engineer/reviewer flow
  │    └─ src/orchestra/ ────────────────────── parallel scheduler, locks, debug hooks
  └─ src/server.ts + src/ui-launcher.ts ─────── optional local WebSocket server + Vite UI
       └─ web/src/ ──────────────────────────── dashboard client
```

`src/cli.ts` is the composition root: commands and interactive chat are wired there. The executor owns the model/tool loop; tools are in `src/tools/`; provider setup is in `src/llm/`. Keep changes in the relevant module and update the composition/wiring only where a new feature needs it.

### Dashboard and monitor UI

The dashboard is a separate Vite React app in `web/`, served on port 5173 by default. The CLI starts a local Fastify WebSocket server on port 3001 by default. `src/server.ts` exposes `/ws` and `/health`, publishes the event history and live events, and accepts task/approval/settings commands from a controller connection. `web/src/protocol.ts` defines the client/server message contract; `web/src/state.ts` manages client state; `web/src/Dashboard.tsx` renders the screens. Shared event types and event history live in `src/core/event-types.ts` and `src/core/events.ts`.

Run `npm run chat:ui` for local chat plus dashboard. `npm run web` runs only Vite for UI work. `npm run web:install` installs its dependencies. LAN and remote modes are opt-in; see `docs/REMOTE.md`. The control token grants access to an agent that can write files and run commands, so treat the printed control URL as a secret.

When changing the WebSocket protocol, update both the server and `web/src/protocol.ts`/client handlers together. Preserve read-only dashboard behavior and origin/token checks in `src/server.ts`.

### Orchestra vs. a single agent

“Single agent” means one selected `AgentDefinition` plus the same shared executor and tools. Agent-specific behavior is primarily its system prompt and settings in `src/agents/list/<id>.ts`; every routable agent must also be registered in `src/agents/definitions.ts`. Routing signals and task-specific knowledge rules are in `src/agents/orchestration.ts`.

Team mode is a higher-level workflow in `src/team/`: the PM creates assignments, engineers run through the executor, and the safety reviewer is read-only. `src/orchestra/` supplies optional mechanics used by team mode and auto-debug: task scheduling, dependency validation, write-scope locks, blackboard, LLM concurrency gate, failure classification, debug interception, and triage reporting. Read `docs/ORCHESTRA.md` before changing those mechanics. Ordinary single-agent tasks do not need the team scheduler.

## Common maintenance tasks

### Update the CLI or dependencies

1. Work on a branch and inspect `git status` before editing.
2. For code changes, use the checks in the validation section below. For dependency updates, review the package's supported Node version, breaking changes, and lockfile diff.
3. Update `package.json` and the matching lockfile together. Root runtime is Node/TypeScript; dashboard dependencies and lockfile are under `web/`.
4. Run `npm install` for root dependency changes; run `npm --prefix web install` for dashboard dependency changes. Avoid updating the vendored `src/knowledge/uupm/` package dependencies unless working on that vendored project.
5. Update this guide or the relevant detailed docs when commands, defaults, module ownership, environment settings, or protocols change.
6. Build/typecheck and run relevant tests before considering an upgrade complete. `npm run build` verifies the distributable `dist/`; `npm run typecheck` checks the project TypeScript configuration.

This repository is private and `package.json` currently has no release/publish script. A local build is `npm run build`, then `npm start` (or install/link the package locally if you need the `agent` bin). Do not assume an npm registry upgrade path exists; define a release process separately if distribution is added.

### Add or update one specialist agent

1. Edit or create `src/agents/list/<id>.ts` and export an `AgentDefinition` with a clear role, workflow, and response format. Reuse `loadKnowledge([...])` for curated standards.
2. Import and register the definition in `src/agents/definitions.ts`. This registry drives routing availability and dashboard roster.
3. Add specific routing terms or task knowledge rules in `src/agents/orchestration.ts` only when needed; the model router can use the registered agent description as a fallback.
4. If team assignment should use it, update role allowlists/titles and PM guidance in `src/team/roles.ts`. Check any specialist-specific behavior in `src/agents/helpers.ts`.
5. Update/add focused tests and the agent catalog in `docs/AGENTS.md`.

### Change shared execution or safety

The executor and tools are shared by all agents. Tool definitions/registration are in `src/tools/`; the approval, command safety, and workspace boundaries are in `src/core/` and tool modules. Treat changes here as cross-agent changes: inspect the default path, auto modes, team mode, and dashboard control path. Do not weaken write/command safety while changing an unrelated workflow.

### Change knowledge

Knowledge files live under `src/knowledge/`. `src/agents/helpers.ts` loads explicitly selected notes and injects them into system prompts; `src/agents/orchestration.ts` chooses task-specific notes; `src/knowledge/README.md` documents the catalog. Merely adding a Markdown file does not make the model read it. Wire it into an agent's `loadKnowledge`, stack detection, or `KNOWLEDGE_RULES` as appropriate. Keep notes concise because prompt budgets cap injected content.

## Configuration and local data

- `.env.example` is the tracked template; local `.env.local` and provider-specific `.env.*` files can contain secrets and must remain untracked.
- `mcp.config.json` configures optional MCP servers.
- `AGENT_UI_PORT`, `AGENT_UI_WEB_PORT`, and `AGENT_UI_URL` configure dashboard addresses; `AGENT_UI_LAN` and `AGENT_UI_REMOTE` opt into network access.
- `AGENT_AUTO_DEBUG_*`, `AGENT_TASK_MAX_STEPS`, and `AGENT_LLM_CONCURRENCY` configure orchestration behavior. See `docs/ORCHESTRA.md` for defaults and semantics.
- `src/llm/models.ts` holds model profiles; `docs/MODELS.md` has setup notes.

Check `.gitignore` before adding any generated data or local configuration. Never commit API keys, control tokens, local logs, or private vault content.

## Validation and troubleshooting

Run only the checks relevant to the change, and report failures honestly:

```bash
npm run typecheck
npm test
npm run build
npm run web:install   # first dashboard setup only
npm run chat:ui
```

The project README currently recommends `npm run typecheck && npm test` after code changes. Dashboard changes should also be exercised with `npm run chat:ui` and checked in a browser. CLI packaging changes should include `npm run build`. Team/orchestra changes should be checked in both ordinary single-agent and team paths where practical. No check can establish model quality by itself; use a small representative task after structural changes.

Common symptoms:

| Symptom | First places to check |
| --- | --- |
| Agent is missing from `/agents` or dashboard | `src/agents/definitions.ts`, `src/agents/registry.test.ts` |
| Task routes to the wrong specialist | `src/agents/orchestration.ts`, `src/agents/router.ts` |
| Knowledge is not appearing in the prompt | `loadKnowledge` usage, `KNOWLEDGE_RULES`, `src/agents/helpers.ts`, missing-file warning |
| Dashboard does not connect | UI and WebSocket ports, `src/server.ts`, `web/vite.config.ts`, `web/src/protocol.ts`, token/origin settings |
| Team task does not run in parallel | assignment scopes/dependencies, `src/team/parallel.ts`, `src/orchestra/orchestra-master.ts`, `docs/ORCHESTRA.md` |
| CLI works in source but not built output | `tsconfig.build.json`, package `bin`/`main`, `npm run build` |

## Keeping this guide current

When moving or renaming a module, update the system map and relevant row above in the same change. When a change introduces a new subsystem, add its entry point, source folder, runtime command, configuration, and validation path here. Keep detailed behavior in the existing focused docs and link to them instead of copying long sections.
