# Orchestra: parallel agents and automatic debugging

Status: modules, executor hooks, CLI flags and team-mode wiring are written, with unit tests. **Nothing has been run yet** (run `npm run typecheck && npm test`). Both features are opt-in: without `AGENT_AUTO_DEBUG=1` / `--auto-debug` and `--parallel` / `/parallel` the agent behaves as before.

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
| `debug-interceptor.ts` | `DebugInterceptor.handle(event)` runs after each shell command. If the failure is fixable, it calls the injected `debug()` with the exact output, optionally `rerun()`s the command, and returns a note appended to the tool result. Single-flight per failure key, at most `AGENT_AUTO_DEBUG_ATTEMPTS` (default 5) attempts per command, then it stops and hands over a triage report; `AGENT_AUTO_DEBUG_MAX` (default 10) debug runs per session; never throws. |
| `triage.ts` | `describeProject(root)` (stack and folders, names only) and `buildTriageReport(input)`: the "🚨 Project Failure & Triage Report" with the four sections (System Telemetry & Architecture, Execution Log & Blockers, Root Cause Analysis, Required User Intervention). Pure, no model calls. |
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
5. The interceptor re-runs the command. Exit 0 → note "FIXED and verified". Otherwise the new output is returned, and the attempt is counted for this command.
6. The note is appended to the original tool result; the primary agent continues with it.
7. **The 5-try gate.** When the count for the same command reaches `AGENT_AUTO_DEBUG_ATTEMPTS` (default 5) and it still fails, there is no sixth attempt: the interceptor builds the triage report (`triage.ts`), `wire.ts` passes it on as `InterceptResult.halt`, and the executor ends the run at once with it as the final message (`unresolvedFailure: true`, so a team run does not report "done"). The report names the failing command, the exact error, every attempt and at most two direct questions for the user.

Safety: the nested run uses the same approval rules (`escapesWorkspace`, `isDangerousCommand`), so it cannot run risky commands unattended; the budget stops loops; Prisma notes tell it never to reset a database without the user.

### Parallel agents without collisions

- Every task declares `scope` (directories it may write). `validate` rejects plans where two tasks that may run at the same time overlap.
- At runtime `WorkspaceLocks` enforces it: a write outside the scope, in another agent's scope, or on a shared file (root `package.json`, lockfiles) is refused with a message telling the agent to put the request in its summary.
- Agents learn about each other through the blackboard digest (short lines, only new events) and through contracts (full text, versioned), not by reading each other's prompts.

## Wiring (done)

| Piece | Where |
| --- | --- |
| Optional hooks `writeGuard`, `onFileWritten`, `commandInterceptor`, `teamUpdates`, `unattended`, plus `maxSteps` | `src/core/executor-hooks.ts`, used in `src/core/executor.ts` (all default to nothing) |
| `createExecutor()` (adds the debug interceptor when `AGENT_AUTO_DEBUG=1`), `makeTaskRunner()`, `makeParallelOptions()` | `src/orchestra/wire.ts` |
| PM plan fields `scope` and `dependsOn`, `PM_PARALLEL_ADDENDUM` | `src/team/roles.ts` |
| Plan to task graph, with the default order (db before api, all before qa) and every reason a plan cannot run in parallel | `src/team/parallel.ts` |
| Parallel branch of team mode, falling back to one-after-another | `src/team/orchestrator.ts` |
| `--auto-debug`, `--parallel` (with `--team`, needs `-y`), chat `/parallel` | `src/cli.ts` |

### How to use it

```
# reactive debugging only (works with a single agent)
npm run chat            # put AGENT_AUTO_DEBUG=1 in .env.local, or:
npx ts-node src/cli.ts run "<task>" -p <project> -y --auto-debug

# parallel team
npx ts-node src/cli.ts run "<task>" -p <project> -y --team --parallel
# in chat: /team then /parallel (auto-write and auto-run must be ON)
```

Auto-debug needs auto-write and auto-run, because a debug run that stops to ask for approval defeats the purpose. Parallel runs decline any command that would need approval (nobody can answer two prompts at once).

### Known limits

- The attempt count is per command text (whitespace-normalised). A different command that fails for the same reason has its own count, and `AGENT_AUTO_DEBUG_MAX` caps the session as a whole.
- The debug run is a nested, sequential `Executor.run` of the Debug Agent with at most `AGENT_AUTO_DEBUG_STEPS` (25) steps. It uses the same model and the same knowledge as everything else, so it fixes what the agent could fix with a clear error message in front of it, not gaps in what the model knows (see the Prisma 7 example in `04-prisma-drizzle.md`).
- Parallel tasks are limited to `AGENT_TASK_MAX_STEPS` (60) steps each and are reported as incomplete when they hit it.
- The root `package.json` and lockfiles are shared files: parallel tasks cannot edit them. Refused writes are listed after the run and in the delivery report.
- The blackboard digest is injected as a user message before a model step. It is only used in parallel runs.
- The PM must produce `scope` and `dependsOn` for every task; if it does not, the plan runs one task at a time and the reasons are printed.

## Verify

```
npm run typecheck && npm test
npm run bench:fullstack -- --workspace ~/bench-app-4 --max 6               # without
AGENT_AUTO_DEBUG=1 npm run bench:fullstack -- --workspace ~/bench-app-5 --max 6   # with
```

Keep the change only if the second run passes more slices, or the same number in fewer steps.
