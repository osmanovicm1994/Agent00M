---
name: logic-standards-advanced
description: Problem decomposition, edge-case analysis, distributed system failure modes, root-cause debugging and a per-ecosystem debugging playbook.
---

# Logical Reasoning & Architecture Planning Standards

Consult these protocols before outlining or writing an implementation. Most are injected automatically: the short core is always loaded for code-writing agents, the others are added when the task text matches (`KNOWLEDGE_RULES` in `src/agents/orchestration.ts`).

- **`00-reasoning-core.md`**: short universal standard (restate the goal, blast radius, edge-case checklist, failure rules, say what you did not verify). Loaded for dev, api, db, design, qa and the PM.
- **`01-problem-decomposition.md`**: breaking epics into atomic phases, state machines, execution ordering.
- **`02-edge-case-analysis.md`**: concurrency, race conditions, partial failures, idempotency. Also read by the Safety Reviewer.
- **`03-distributed-systems.md`**: microservices, CAP theorem, eventual consistency, sagas.
- **`04-root-cause-debugging.md`**: isolating variables, reading stack traces, scientific-method debugging.
- **`05-debugging-playbook.md`**: triage order and failure patterns per ecosystem (Node/TS, NestJS, Next.js, Python, .NET, JVM, monorepos). Used by the debug agent and added for failure-style tasks.

The logic agent reads all of them; it analyses and plans in text and does not write files unless asked.
