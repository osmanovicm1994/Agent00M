# Agent review, 5 Nov 2026 (barberv3.0 run, qwen3-coder-30b-a3b, LM Studio, 32k context)

Sources: the terminal log (16,850 lines) and the LM Studio developer log (33 requests).

## What the logs show

| # | Finding | Evidence |
| --- | --- | --- |
| 1 | The model writes code from memory, not from the schema or the component files | `weekday/opensAt/closesAt` vs schema `dayOfWeek/startTime/endTime`; `isActive` not in `select`; `Select` used with Radix props on a native select; lucide `Calendar` icon used as the date picker; `cookies().get` without `await`; imports of `@/components/ui/label` that was never created |
| 2 | Enums written on one line: P1012 "not an enum value definition" | `enum UserRole { CUSTOMER ADMIN }`, fixed only after a debug run |
| 3 | The "known problem" matcher fired on the WHOLE typecheck output and offered a Prisma-seed fix | "seed-schema-mismatch" shown 3 times, run stopped with 22 items unbuilt. The other error classes had no fix at all |
| 4 | Knowledge was dropped by the budget | Warnings for `05-debugging-playbook.md`, `tool-execution.md` (debug agent: 7000 chars, the file was cut), `roadmap`, `ios/android-build-debug`, `02-edge-case-analysis.md`, `prisma-drizzle`, `playwright-standards` |
| 5 | The prompt always fills the window | "Prompt trimmed ... 28266 -> 28159 tokens" on every first request. 44 tool schemas are part of it (11 browser tools, design and deploy tools for every agent) |
| 6 | Prompt reading is the main cost | LM Studio: 33 requests, 163,843 prompt tokens, 817 s (13.6 min) of prompt processing at about 200 tok/s; slowest request 156 s; cache similarity fell to 0.16 to 0.26 on switches between agents. `first token 353.9s` and "predict stream timed out after 600000ms" followed a "Socket timeout" (LM Studio was probably still working on the abandoned request) |
| 7 | Searches walk node_modules and stray scaffold folders | `find . -name "*.ts"` listed `temp_next/` and `temp_clean/` inside the project |
| 8 | Tool use: 402 run_command, 277 read_file, 200 write_file, only 8 append_file | Many commands are looks and checks, not progress. The stall guard fired repeatedly |
| 9 | There is no edit tool | Only `write_file` / `append_file`: every one-line fix rewrites a whole file |

## What was changed (files under `WEB PROJECT/AGENT`)

Knowledge (new folder `src/knowledge/14-coding/`): `00-write-code-protocol`, `01-fix-loop`, `02-ts-error-codes`, `03-nextjs-ui-pitfalls`, `04-prisma-contract`, `05-dependency-updates`, `06-ask-the-user`, `07-language-bosnian`. Task-matched by new rules at the end of `KNOWLEDGE_RULES` (`src/agents/orchestration.ts`), highest weights first. `00-agent-core/tool-execution.md` is now a slim core (5.3 KB to 3.7 KB); the deploy/MCP/browser notes moved to `tool-execution-extras.md`.

Code:
- `src/core/known-fixes.ts`: 4 new zero-token fixes (async `cookies()`/`params`, missing root layout, missing `@/components/ui/*`, component props/icon mismatch); the schema-mismatch fix now covers every file in the typecheck and mentions `select`; up to 3 fixes are shown instead of 2.
- `src/agents/list/debug.ts`: budget 12,000 chars, order: tool rules, fix loop, known fixes, TS codes; it can end with a NEEDS INPUT block.
- `src/core/language.ts` (new) + `orchestration.ts` + `team/orchestrator.ts`: Bosnian support. `AGENT_LANGUAGE=auto|bs|en`. The planner writes goal, assumptions, risks and questions in Bosnian; task titles, instructions and acceptance criteria stay English because the gates match them.
- `src/team/orchestrator.ts`: plan review. `AGENT_PLAN_REVIEW=1` (set in `.env.local`): after the Project Manager's plan is printed you answer y (start), e (save the task files in `tasks/` and stop, edit them, then `/tasks resume`) or n (cancel). It works in auto mode and from the dashboard.
- `scripts/deps-check.sh` and `scripts/deps-update.sh` (`npm run deps:check`, `npm run deps:update`): read-only report for npm, Gradle, Maven, pip, .NET and Pods; one-package-at-a-time npm updates with checks, commit on green, rollback on red.
- Tests added: `src/core/language.test.ts`, `src/core/known-fixes-nextjs.test.ts`, three cases in `src/agents/orchestration.test.ts`.

## Run this first

```
npm run typecheck && npm test
```
I could not run the repo's own typecheck or full test suite from here. Possible failures: an older test that expects exactly 2 known fixes, or an exact list of task-knowledge files. Both are expected effects of the changes above, fix the expectation.

## Done on 2026-11-06 / 2026-11-07 (second round)

- Test fixes: `fullstack-build` weight 10 (build protocol stays first); debug agent budget 10,800 without `02-ts-error-codes.md`, prompt limit in `delivery-knowledge.test.ts` 13,500; per-agent knowledge budgets in `src/agents/list/` (api 14,000, db 13,500, qa 13,800, design 16,800, dev 9,800, logic 12,800 with tool rules first). In real runs `AGENT_SKILL_CHARS=19000` already covered those lists; the warnings were test-only.
- `edit_file` tool: `src/core/edit-apply.ts` (+ test), handler `handleEdit` in `src/core/executor.ts` (goes through the same write gates as `write_file`), schema in `src/tools/fs.tool.ts`, counted as a write in `stall-guard.ts`, knowledge and debug prompt updated.
- `ask_user` tool: `src/core/ask-user.ts` (+ test). Terminal and dashboard race (`control.ask`), 3 questions per run (`AGENT_MAX_QUESTIONS`), `AGENT_ASK=0` off, unattended runs take the default.
- Tool payload per agent: `src/core/tool-select.ts` (+ test). Web, browser, deploy and process tools only for roles and tasks that need them; `AGENT_TOOL_TRIM=0` sends all.
- LM Studio client: `AGENT_LLM_CONCURRENCY=1` in `.env.local`, `maxRetries` 0 (`AI_MAX_RETRIES`), timeout 900 s (`AI_TIMEOUT_MS`).

## Still open

1. Same system-prompt prefix for every agent. Low value: LM Studio renders the tool list before the system prompt, and within one run the prefix is already stable.
2. Delete `temp_next/` and `temp_clean/` inside `TESTPROJECTS/barberv3.0` (leftover scaffold folders).
3. Measure again after a real run: prompt tokens per request, time to first token, and how many `edit_file` / `ask_user` calls the model makes. Tune `tool-select.ts` and the knowledge budgets from that.
