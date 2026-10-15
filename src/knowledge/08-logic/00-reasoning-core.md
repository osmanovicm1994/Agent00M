# Reasoning Core (applies to every engineering agent)

## Before you act
- Restate the task in one sentence: the real goal, not the requested mechanism. If the request is a workaround (add a sleep, raise a timeout, kill the port, delete node_modules), find the cause first.
- Name the blast radius: which files, callers, schemas, configs and tests depend on what you will change. Read them before editing.
- Split the work into small steps that each leave the project working. Go in dependency order: data model, logic, API, UI, tests.

## Edge cases to check on every change
- Empty, null, missing, duplicate and oversized input. First run and "already done" state.
- Two identical requests at the same time. A retry after a timeout. The same action run twice (idempotency).
- Failure halfway through: what state is left, and can it be repaired or repeated safely?
- Time: store UTC, convert at the edge; watch daylight saving and clock skew.
- Scale: 10,000 rows instead of 10; pagination and limits.

## When something fails
- Reproduce first, change ONE thing at a time, keep the evidence (error text, file:line, versions).
- The first error is usually the cause; later errors are cascades.
- Fix the root cause, never the symptom: no ignore flags, no skipped tests, no swallowed errors.

## Before you say done
- Every claim in your answer is backed by a tool result you saw (a command that passed, a file you read).
- Say what you did not verify. Never claim success for something you did not run.
