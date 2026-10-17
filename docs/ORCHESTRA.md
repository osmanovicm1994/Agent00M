# Orchestra: parallel agents and automatic debugging

Status: modules and unit tests written; **not yet run** (run `npm run typecheck && npm test`). The executor hooks and the team-mode wiring are described in "Wiring" below and are not applied yet unless the checklist says so.

## The two problems

1. **Silos.** Team mode runs the PM's tasks one after another through one executor. Dev, API and DB never overlap and only see each other through files.
2. **Idle Debug Agent.** When `npm install` returns E404 or a Prisma migration fails, the agent that hit it retries or gives up. The Debug Agent is only used if the PM planned a "debug" task.

## Honest limits

- A local model server (LM Studio) normally answers **one request at a time**. Three agents calling it at once do not get three times faster; their requests queue. What parallelism really buys is overlapping one agent's **shell time** (installs, builds, tests) with another agent's **model time**. `AGENT_LLM_CONCURRENCY` (default 2) gates model calls. LM Studio's "Max Concurrent Predictions" (4 by default) is the ceiling; set the variable to 1 if your server handles one request at a time. Check that the context length per slot is still large enough.
- Parallel agents can build **inconsistent interfaces** (API returns `userId`, web expects `id`). The design is therefore "contract first, then parallel": the DB/API task publishes a contract on the blackboard, the tasks that depend on it start afterwards.
- Automatic debugging is the higher-value part. It is a nested sequential run, needs no parallelism, and is switched off by default (`AGENT_AUTO_DEBUG=1`).

## Modules (`src/orchestra/`)

| File | Role |
| --- | --- |
| `error-classifier.ts` | `classifyFailure(command, output, exitCode)` → `{kind, key, immediate, fixable, evidence, hint}` or `null`. Pure. Immediate: npm E404, ETARGET, ERESOLVE, Prisma schema/migration/client, module not found. Escalated (after 2 repeats): tests, build, TypeScript. Not fixable by a patch: network, permission, port in use, missing tool. |
| `debug-interceptor.ts` | `DebugInterceptor.handle(event)` runs after each shell command. If the failure is fixable, it calls the injected `debug()` with the exact output, optionally `rerun()`s the command, and returns a note appended to the tool result. Single-flight per failure key, budget `AGENT_AUTO_DEBUG_MAX` (default 3), 1 run per distinct failure, never throws. |
| `workspace-locks.ts` | Path-scope write leases. `tryAcquire(owner, scopes)`, `canWrite(owner, path)`. Root manifests and lockfiles are shared and refused for parallel agents. |
| `blackboard.ts` | Append-only event log plus versioned contracts. `digestFor(agent)` returns only what the others did since the last call. |
| `llm-gate.ts` | `Semaphore` and `gateProvider(provider, sem)`: limits concurrent `chat()` calls. |
| `orchestra-master.ts` | `OrchestraMaster.validate(tasks)` (cycles, unknown deps, overlapping parallel scopes) and `run(tasks)` (dependency-aware scheduler, concurrency limit, skip on failed dependency, optional `failFast`). The agent loop is an injected `TaskRunner`. |

## How the pieces connect

```
PM plan (tasks + scope + dependsOn)
        │
        ▼
OrchestraMaster.validate ──► refuses plans where parallel tasks overlap
        │
        ▼
scheduler: ready tasks (deps done, scope lease free, < concurrency)
        │ one TaskRunner per task = one Executor.run
        ▼
 ┌─────────────────────────── Executor hooks ───────────────────────────┐
 │ writeGuard(path)        → WorkspaceLocks.canWrite(agent, path)       │
 │ commandInterceptor(cmd) → DebugInterceptor.handle(...)  (pauses)     │
 │ teamUpdates()           → Blackboard.digestFor(agent) before a step  │
 └───────────────────────────────────────────────────────────────────────┘
        │ model calls pass through gateProvider (Semaphore)
        ▼
 outcomes + contracts → Blackboard → next ready tasks
```

### Automatic debugging flow

1. The primary agent runs `npm install`; it fails with E404.
2. The executor awaits `commandInterceptor`. The agent is paused because its tool call has not returned.
3. `classifyFailure` says `npm-404`, immediate, fixable. The interceptor calls the Debug Agent (a nested `Executor.run("debug", ...)`) with the command, the tail of the exact output and the hint.
4. The Debug Agent edits `package.json` (version/name), as any agent would, through the same write guard.
5. The interceptor re-runs the command. Exit 0 → note "FIXED and verified". Otherwise the new output is returned.
6. The note is appended to the original tool result; the primary agent continues with it.

Safety: the nested run uses the same approval rules (`escapesWorkspace`, `isDangerousCommand`), so it cannot run risky commands unattended; the budget stops loops; Prisma notes tell it never to reset a database without the user.

### Parallel agents without collisions

- Every task declares `scope` (directories it may write). `validate` rejects plans where two tasks that may run at the same time overlap.
- At runtime `WorkspaceLocks` enforces it: a write outside the scope, in another agent's scope, or on a shared file (root `package.json`, lockfiles) is refused with a message telling the agent to put the request in its summary.
- Agents learn about each other through the blackboard digest (short lines, only new events) and through contracts (full text, versioned), not by reading each other's prompts.

## Wiring (what is still to apply)

1. `executor.ts`: add optional hooks to the executor options: `writeGuard?(agentId, path) => {allowed, reason?}`, `commandInterceptor?(ctx) => Promise<string|null>` (append the returned text to the `run_command` result), `teamUpdates?(agentId) => string` (inject as a system note before each step). All default to no-ops, so existing behaviour is unchanged.
2. A small `src/orchestra/wire.ts` building the `TaskRunner` (Executor + gated provider + hooks) and the `debug` function (`executor.run(debugAgent, ...)` with `filesWritten` as `filesChanged`).
3. `team/roles.ts`: extend the PM schema with optional `scope: string[]` and `dependsOn: string[]` per task; `team/orchestrator.ts`: use `OrchestraMaster` when `--parallel` is given and the plan validates, else run sequentially as today.
4. Bench: `--auto-debug` flag that sets `AGENT_AUTO_DEBUG=1`, so the two benchmark runs can be compared with `--compare`.

## Verify

```
npm run typecheck && npm test
npm run bench:fullstack -- --workspace ~/bench-app-4 --max 6               # without
AGENT_AUTO_DEBUG=1 npm run bench:fullstack -- --workspace ~/bench-app-5 --max 6   # with
```

Keep the change only if the second run passes more slices, or the same number in fewer steps.
