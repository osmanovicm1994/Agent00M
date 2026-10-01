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
| `03-mobile/` | SwiftUI, Jetpack Compose | auto when an Xcode / Gradle project is detected |
| `04-frontend/` | React / Next.js | auto when react / next is detected |
| `05-backend/` | C# / .NET, Python / FastAPI | auto when a .csproj / FastAPI project is detected |
| `06-database/` | Schema, migrations, query performance, integrity | db agent |
| `07-api/` | Endpoint design, validation, errors, security | api agent |
| `08-logic/` | Decomposition, edge cases, distributed systems, debugging | logic agent |
| `09-ai-agents/` | Grounding and fallback-parsing rules | every agent |
| `10-design/` | UI/UX and accessibility rules | design agent |
| `11-kb/` | Documentation standards | kb-harvester agent |
| `uupm/` | Vendored UI/UX Pro Max skill pack (not injected; see CLAUDE.md) | nothing yet |

## Adding knowledge
1. Add a short, imperative Markdown file (aim for under 1.5 KB; the prompt budget is `AGENT_SKILL_CHARS`, default 9000 chars per agent).
2. Reference it in the agent's `loadKnowledge([...])` list, or in `STACK_PRIORITY` / `inspectDir` in `helpers.ts` for stack-based injection.
3. A missing file path prints a one-time warning at startup, so typos are visible.

## The Golden Rules
1. **Never Mix Paradigms:** Write idiomatic code. Do not write Java-style OOP in React, and do not write nested functional closures in C# where LINQ is expected.
2. **Design for Testability First:** UI code is incomplete if it cannot be targeted by Playwright or Appium. All business logic must be isolated from frameworks to allow for fast unit testing.
3. **Fail Fast & Explicitly:** Return explicit `Result` types or throw well-typed, domain-specific exceptions. Never swallow exceptions or return generic `null` states without explanation.
