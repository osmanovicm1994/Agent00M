# Agents, roles and routing

Reference for every agent the local worker model can become, the knowledge each one is given, how a task reaches it, and how to add or change one. Source of truth is the code: `src/agents/definitions.ts`, `src/agents/list/*.ts`, `src/agents/orchestration.ts`, `src/agents/router.ts`, `src/team/roles.ts`. If this file and the code disagree, the code wins; fix this file.

## 1. Agent catalog

`AgentDefinition` (in `definitions.ts`): `id`, `name`, `description`, `systemPrompt`, plus optional `thinkingBudget`, `autoDiagnostics`, `verifyFixes`, `readOnly`. The `name` and `description` are shown on the dashboard roster (the description is clamped to two lines) and are listed to the LLM router, so keep the description short and specific.

| id | Name | Job | Flags | Standards always injected (in order, cut from the end when over budget) |
| --- | --- | --- | --- | --- |
| `dev` | Development Agent | Features, bug fixes, refactors, unit tests, general code | - | tool-execution, **reasoning-core**, golden-rules, mcp-protocols, architecture-patterns |
| `api` | API Agent | REST endpoints, validation, errors, API security (NestJS, ASP.NET, FastAPI ...) | - | tool-execution, **reasoning-core**, mcp-protocols, 07-api/01..04 |
| `db` | Database Agent | Schema, migrations, SQL/PostgreSQL, indexes, integrity | - | tool-execution, **reasoning-core**, mcp-protocols, 06-database/01..04 |
| `design` | Frontend Developer Agent | Builds modern UI: components, pages, styling, forms, states, accessibility, responsive layout, performance | - | tool-execution, **reasoning-core**, design-standards, modern-frontend, css-and-tailwind, mcp-protocols |
| `logic` | Logical Architecture Agent | Planning, decomposition, edge cases, trade-offs. Answers in text, does not write files unless asked | - | tool-execution, architecture-patterns, 08-logic/01..05 |
| `kb-harvester` | Knowledge Base Harvester | Reads a project and writes Markdown documentation | - | tool-execution, mcp-protocols, kb-standards |
| `qa` | QA Automation Agent | Appium (C#/NUnit), Playwright, page objects, flaky tests | - | tool-execution, **reasoning-core**, mcp-protocols, appium-standards, appium-csharp, playwright-standards |
| `debug` | Debugging & Problem-Solving Agent | A command/build/server/test fails: reproduce, rank hypotheses, root-cause fix, re-run | `thinkingBudget: 14`, `autoDiagnostics`, `verifyFixes`; knowledge capped at 10000 chars | debugging-playbook, tool-execution, root-cause-debugging |
| `research` | Research & Web Discovery Agent | Answers from live web sources (docs, versions, errors), cites URLs | `thinkingBudget: 3` | tool-execution |
| `safety` | Safety Reviewer | Read-only review at the end of team mode. NOT in `AGENTS`: not routable, not lockable. Defined in `src/team/roles.ts` | `readOnly`, `autoDiagnostics`, `thinkingBudget: 2` | edge-case-analysis (appended to its prompt) |

`reasoning-core` is `08-logic/00-reasoning-core.md`: a compact (1.4 KB) version of the logic standards (restate the goal, blast radius, edge-case checklist, failure rules, "say what you did not verify"). It sits second so it survives a small `AGENT_SKILL_CHARS` budget.

On top of this list, two things are added per run by `executor.ts`:

1. `detectStackKnowledge(workspace, agentId)` adds the standards that match the target project (React/Next, .NET, FastAPI, SwiftUI, Compose, Appium, Playwright). For `design` on a mobile project it also adds `mobile-common` and the platform's `*-ui.md` (see `MOBILE_ROLE` in `helpers.ts`). Budget `AGENT_STACK_CHARS` (9000).
2. **Task-specific standards** from `selectTaskKnowledge(task, agentId)` (section 2). Budget `AGENT_TASK_CHARS` (6000), at most `AGENT_TASK_FILES` (4) files, injected under the heading "TASK-SPECIFIC STANDARDS". Files the agent already carries are skipped.

Budget: `AGENT_SKILL_CHARS` (default 9000; `.env.local` sets 19000 for a 32k-token window). With the default, the last files in an agent's list are cut first, which is why `mcp-protocols.md` comes last for `design`.

### Registry guarantees
`src/agents/registry.test.ts` fails when an agent file is not registered, a routing group has no agent behind it, an agent prompt points at a missing knowledge file, or a task rule points at a missing file. `router.ts` also prints a one-time warning if a signal group matches an unregistered agent instead of falling through silently.

## 2. How a task reaches an agent, and what it gets to read

1. A forced agent wins: `run -a <id>`, `/use <id>`, or the dashboard agent picker.
2. Otherwise, if the research stage is on, its `recommendedAgent` (from the plan, else from the research brief) is used when it is a registered id.
3. Otherwise `routeTask` in `router.ts`: keyword scoring (`rankDomains` in `orchestration.ts`), one strict winner routes instantly; a tie goes to one capped LLM call (24 tokens, temperature 0) that is also shown the signals found; then fallback to `dev`. `AGENT_ROUTER=keywords` never spends a model call.

### Routing signals (`DOMAIN_KEYWORDS` in `orchestration.ts`)
Rules: specific words only; generic words ("test", "fix", "page", "button", "component" alone) must fall through to the LLM router. Groups: `qa`, `db`, `api`, `design`, `kb-harvester`, `research`, `debug`, `logic`. Two context rules sit on top:

- A task that matches `research` but also contains a change verb (add, update, fix, implement ...) is a change task with a lookup inside it: the research signal is dropped, the working agent searches the web itself.
- In a test-automation project (Appium/Playwright detected from the workspace) generic test words ("write tests for ...") score for `qa`.

`design` matches: css/scss/sass, tailwind/shadcn/radix/styled-components/CSS modules, ui, ux, frontend, layout, responsive, accessibility/a11y/WCAG/aria-, design system/tokens, styling, dark mode, landing page/navbar/sidebar/modal/dropdown/hero section, "react|vue|svelte|angular|next component|page|form", jsx/tsx, Core Web Vitals/Lighthouse/LCP/CLS/layout shift.

### Task-specific standards (`KNOWLEDGE_RULES` in `orchestration.ts`)
This is how the logic standards reach every agent whose task needs them. Rules are applied to the task text, highest weight first, capped at the file limit:

| Rule | Trigger (examples) | Loads | Weight |
| --- | --- | --- | --- |
| edge-cases | payment, webhook, retry, timeout, concurrency, idempotency, UTC/DST, pagination, upload, cron | `08-logic/02-edge-case-analysis.md` | 5 |
| decomposition | implement/build/migrate/refactor/workflow/checkout, a task over 300 chars, a 3+ item list | `08-logic/01-problem-decomposition.md` | 4 |
| root-cause | flaky, intermittent, regression, "only in CI", why does ... | `08-logic/04-root-cause-debugging.md` | 4 |
| distributed | microservice, Kafka/RabbitMQ, queue, saga, outbox, worker | `08-logic/03-distributed-systems.md` | 4 |
| failure-playbook | fails, crash, exception, ENOENT ... (dev, api, db, design, qa, logic) | `08-logic/05-debugging-playbook.md` | 2 |
| database | migration, schema, table, ORM (not for `db`) | `06-database/02`, `04` | 3 |
| query-performance | slow query, N+1, index (not for `db`) | `06-database/03` | 3 |
| api-contract | endpoint, controller, DTO, validation (not for `api`) | `07-api/03`, `02` | 3 |
| security | auth, JWT, password, token, CORS, XSS (not for `api`) | `07-api/04` | 3 |
| frontend | component, CSS, Tailwind, responsive, form (dev, api, logic) | `10-design/design-standards`, `04-frontend/modern-frontend` | 3 |
| appium / playwright | named in the task (not for `qa`) | the matching `02-qa-automation` file | 3 |

`kb-harvester` and `research` never get task standards. The Project Manager (team mode) gets reasoning-core, decomposition and edge cases appended to its prompt (`PM_KNOWLEDGE`), the Safety Reviewer gets the edge-case standard.

### Cross-cutting tasks
`analyzeTask().crossCutting` is true when a change task touches 3+ build domains (api, db, design, qa), or 2 domains and more than 240 chars. The executor prints a hint to use `/team <task>`; it never switches modes by itself.

## 3. The frontend developer agent (`design`)

The id stays `design` because the router, the team roles, `MOBILE_ROLE` and the dashboard use it. It builds real UI instead of writing design advice.

- **Workflow in the prompt:** reconnaissance (tree, package.json, global styles/tokens, 2-3 similar components) -> plan with `sequentialthinking` for multi-file work -> build in the project's own conventions -> verify with the project's typecheck/lint/test/build scripts, then `inspect_page` when a dev-server URL or a static HTML file is available -> report (Built / Files / Verified by / Not verified / Notes).
- **Stack rules:** follow the project; React/Next gets the React + modern frontend standards; Vue/Svelte/Angular use their own idioms; plain HTML/CSS projects stay framework-free; native mobile uses the mobile standards. A brand-new app with no stack given defaults to Next.js App Router + TypeScript + Tailwind (sites/apps with routes) or Vite + React + TypeScript (single-page tool).
- **Inputs it understands:** a UX SPEC (team mode, from the UX Designer), a DESIGN BRIEF (from `/image` or `run --image`, a text estimate of a picture), and a TEAM ASSIGNMENT with acceptance criteria.
- **What it can check:** `inspect_page` (`src/tools/browser.tool.ts`, read-only, any agent can call it) renders a localhost page or a workspace `.html` file in headless Chromium and returns console errors, failed requests, horizontal overflow at 375 and 1280 px, structure and accessibility problems. It does not start servers (a dev server cannot outlive a `run_command`), so the agent asks the user for the URL. One-time setup: `npx playwright install chromium`.
- **Honesty rule:** it still cannot judge how the UI looks. It reports what typecheck/lint/tests/build/inspect_page proved and lists the rest (visual match, colours and spacing, real device, screen reader) under "Not verified".
- **Knowledge files:** `10-design/design-standards.md`, `04-frontend/modern-frontend.md`, `10-design/css-and-tailwind.md`. `uupm/` is still not injected.
- **Not set on purpose:** `verifyFixes` (its nudge says "re-run the failing command", which fits debugging, not building UI).

## 4. Team mode roles (`src/team/roles.ts`)

| Role id | Title | How it runs |
| --- | --- | --- |
| `pm` | Project Manager | One plain model call (Gemini when the research stage is on), JSON plan with at most 6 tasks, with `PM_KNOWLEDGE` appended. Also writes the delivery report from recorded facts |
| `ux` | UX Designer | One plain model call, writes a build spec (screens, components, states, layout, copy, accessibility). No code |
| `design`, `dev`, `api`, `db`, `debug`, `qa` | Engineers | Run through the Executor with the matching agent, each with a fresh small context; each task also gets task-specific standards from its own title and instructions |
| `safety` | Safety Reviewer | Executor with `safetyAgent` (`readOnly`), ends with `VERDICT: PASS|FAIL`; one fix round on FAIL |

`ROLE_TITLES` labels `design` as "Frontend/UI Engineer". The PM prompt describes `design` as the engineer who "builds components, styling and layout in the existing design system"; the UX role comes before it for any UI work.

## 5. Add or change an agent

1. Create `src/agents/list/<id>.ts` exporting a typed `AgentDefinition`. Put the role, workflow and output format in `systemPrompt`; reference knowledge with `loadKnowledge([...])` (paths relative to `src/knowledge`). Avoid backticks and `${` inside the prompt template string. Include `08-logic/00-reasoning-core.md` second if the agent writes code.
2. Import it and add it to `AGENTS` in `definitions.ts`. Not listed = not routable, not lockable, missing from the dashboard (`registry.test.ts` catches this).
3. Add routing signals in `orchestration.ts` (`DOMAIN_KEYWORDS`) only if they are specific. Otherwise the LLM router decides from `description`. Add a rule to `KNOWLEDGE_RULES` if tasks in its lane need extra standards.
4. If the role should get platform standards, add it to `MOBILE_ROLE` in `helpers.ts`.
5. If team mode should be able to assign it, add it to `ASSIGNABLE_ROLES`, `ROLE_TITLES` and the PM prompt in `team/roles.ts`.
6. Run `npm run typecheck && npm test`, then `npm run chat`, `/agents` to confirm it is listed, and `/use <id>` to try it.
