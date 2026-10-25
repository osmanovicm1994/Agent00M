---
name: polyglot-senior-dev-standards
description: Master index of the agent's knowledge base. Enforces clean architecture, type safety, native declarative UI patterns, and robust test automation.
---

# Senior Polyglot Engineering Standards

This folder is the agent's knowledge base. It is NOT read by the agent at runtime through its file tools (those are scoped to the target project). Instead `src/agents/helpers.ts` injects selected files into each agent's system prompt (`loadKnowledge`) and auto-adds language standards by detecting the target project's stack (`detectStackKnowledge`).

## Folders

| Folder | Content | Injected for |
| --- | --- | --- |
| `00-agent-core/` | Tool usage, chunked writing, grounding rules | every agent |
| `01-architecture/` | Clean architecture, DI, immutability | dev, logic |
| `02-qa-automation/` | Appium (general + C#), Playwright POM | qa agent; auto when Appium/Playwright is detected |
| `03-mobile/` | iOS: `ios-swiftui.md` (entry) + `ios-architecture`, `ios-swiftui-ui`, `ios-data-networking`, `ios-testing`, `ios-build-debug`; Android: `android-compose.md` (entry); shared: `mobile-common`, `mobile-project-analysis`, `mobile-code-review` | auto when an Xcode / Gradle project is detected; the entry file always, shared + detail files by agent role (see `MOBILE_ROLE` in `helpers.ts`) |
| `04-frontend/` | `react-nextjs.md` (React / Next.js), `modern-frontend.md` (components, React 19, forms, performance, TypeScript, security) | `react-nextjs.md` auto when react / next is detected; `modern-frontend.md` for the design (frontend developer) agent |
| `05-backend/` | C# / .NET, Python / FastAPI | auto when a .csproj / FastAPI project is detected |
| `06-database/` | Schema, migrations, query performance, integrity | db agent |
| `07-api/` | Endpoint design, validation, errors, security, `05-owasp-checklist.md` | api agent; OWASP checklist also for the Safety Reviewer and security-review tasks |
| `08-logic/` | `00-reasoning-core.md` (short universal standard), decomposition, edge cases, distributed systems, root-cause debugging, `05-debugging-playbook.md` | reasoning core: dev, api, db, design, qa (always); logic agent: all; debug agent: playbook + root cause; every other agent: the matching file when the task needs it (see below); PM and Safety Reviewer in team mode |
| `09-ai-agents/` | Grounding and fallback-parsing rules | every agent |
| `10-design/` | `design-standards.md` (UI quality bar: accessibility, layout, states), `css-and-tailwind.md` (modern CSS, Tailwind v3/v4) | design (frontend developer) agent |
| `10-design/design-system-workflow.md` | How to use `design_search` and the project's `design-system/MASTER.md` | task-matched for design and dev (rule `design-system`) |
| `11-kb/` | Documentation standards | kb-harvester agent |
| `12-fullstack/` | Build protocol for new projects, Next.js, NestJS, custom JWT auth, Prisma/Drizzle, Neon, Cloudflare R2, Docker/VPS deploy, CI and test strategy | task-matched for dev, api, db, design, qa, logic (rules in `orchestration.ts`); not in any agent's fixed list |
| `13-delivery/` | How to deliver a project: `00-roadmap.md` (phases with gates), `01-git-versioning.md` (git, branches, conventional commits, SemVer, changelog, lockfiles, Node pinning), `02-versions-2026.md` (checked versions, pins and the exact scaffold/install commands), `03-recipe-nextjs-prisma-auth.md` (working Next 16 + Prisma 7 + session + zod/RHF code), `04-local-infra-ci.md` (env files, Docker Postgres, Dockerfile, GitHub Actions), `05-known-fixes.md` (error -> exact fix), `06-recipe-auth-rbac-nextauth.md` (NextAuth v4 + ADMIN/USER + per-user data, checked on Next 16.4.3), `07-recipe-ui-pages.md` (login, list, wizard, print view, admin pages), `08-recipe-monorepo-db-package.md` (only when the request names `packages/db`; NOT built end to end), `09-records-and-legal-documents.md` (owner column, snapshots, no cascade delete, seed from env), `10-plan-template.md` (the PM's verifiable-slice template) | task-matched for dev, api, db, design, qa, logic, infra (`fullstack-build`, `scaffolding`, `docker-deploy`, `delivery-recipe`, `rbac-auth`, `ui-pages`, `monorepo-db-package`, `legal-records`, `git-versioning` rules; `10-plan-template.md` is loaded into the Project Manager's prompt); `05-known-fixes.md` is fixed for the debug and infra agents |
| `uupm/` | Vendored UI/UX Pro Max skill pack (not injected as text). Its CSV catalogs are searched by the `design_search` tool; see CLAUDE.md | tool, not prompt |

## Task-specific injection
Besides each agent's own list and the detected stack standards, `src/agents/orchestration.ts` (`KNOWLEDGE_RULES`, `selectTaskKnowledge`) reads the task text and adds up to `AGENT_TASK_FILES` (5) extra files within `AGENT_TASK_CHARS` (16000), under "TASK-SPECIFIC STANDARDS". Logic standards weigh highest (edge cases for payments/retries/concurrency, decomposition for big changes, root cause for flaky bugs, distributed systems for queues/services); database, API, security, frontend and QA standards are added when the task touches them. Files an agent already carries are skipped. A rule that points at a missing file fails `registry.test.ts`.

## Keep versions honest
The numbers in `13-delivery/02-versions-2026.md` and the recipe were checked with `npm view` and a real scaffold in October 2026. Re-check them (`npm view <pkg> version engines.node peerDependencies`, then scaffold into a scratch folder and build) when a major ships, and update the matcher in `src/core/known-fixes.ts` and its test with every new recurring failure.

## Adding knowledge
1. Add a short, imperative Markdown file (aim for under 1.5 KB; the prompt budget is `AGENT_SKILL_CHARS`, default 9000 chars per agent).
2. Reference it in the agent's `loadKnowledge([...])` list, in `STACK_PRIORITY` / `inspectDir` in `helpers.ts` for stack-based injection, or as a rule in `KNOWLEDGE_RULES` (`orchestration.ts`) for task-based injection.
3. A missing file path prints a one-time warning at startup, so typos are visible.

## The Golden Rules
1. **Never Mix Paradigms:** Write idiomatic code. Do not write Java-style OOP in React, and do not write nested functional closures in C# where LINQ is expected.
2. **Design for Testability First:** UI code is incomplete if it cannot be targeted by Playwright or Appium. All business logic must be isolated from frameworks to allow for fast unit testing.
3. **Fail Fast & Explicitly:** Return explicit `Result` types or throw well-typed, domain-specific exceptions. Never swallow exceptions or return generic `null` states without explanation.
