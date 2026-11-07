# Agent CLI system graph

This graph maps the runtime, responsibilities, and key implementation files. In VS Code, open this file and run **Markdown: Open Preview** (or use the Markdown Preview Mermaid Support extension if your Markdown preview does not render Mermaid diagrams).

```mermaid
flowchart LR
  User([User / CLI command]) --> CLI["CLI composition<br/>src/cli.ts"]

  subgraph Single[Single-agent runtime]
    Route["Agent routing<br/>src/agents/router.ts<br/>src/agents/orchestration.ts"] --> Registry["Agent registry<br/>src/agents/definitions.ts"]
    Registry --> Prompt["Specialist prompts<br/>src/agents/list/*.ts"]
    Prompt --> Exec["Executor loop<br/>src/core/executor.ts"]
    Exec --> Tools["Tools<br/>src/tools/index.ts<br/>src/tools/*.tool.ts"]
    Safe["Safety / approvals<br/>src/core/command-safety.ts<br/>src/core/control.ts"] -. guards .-> Exec
    Safe -. guards .-> Tools
  end

  CLI --> Route
  CLI --> Exec

  subgraph Team[Team and orchestra]
    TeamFlow["Team lifecycle<br/>src/team/orchestrator.ts"] --> PM["PM / engineer / reviewer roles<br/>src/team/roles.ts"]
    PM --> Plan["Task graph<br/>src/team/parallel.ts"]
    Plan --> Scheduler["Scheduler<br/>src/orchestra/orchestra-master.ts"]
    Scheduler --> Locks["Write scopes<br/>src/orchestra/workspace-locks.ts"]
    Scheduler --> Board["Shared contracts<br/>src/orchestra/blackboard.ts"]
    Scheduler --> Debug["Auto-debug / triage<br/>src/orchestra/debug-interceptor.ts<br/>error-classifier.ts<br/>triage.ts"]
  end
  CLI -->|--team| TeamFlow
  TeamFlow --> Exec
  Locks -. authorizes writes .-> Exec
  Debug -. command result hook .-> Exec

  subgraph Knowledge[Prompt context]
    AgentKB["Role knowledge<br/>src/agents/list/*.ts"] --> Loader["Knowledge loader<br/>src/agents/helpers.ts"]
    Rules["Task / stack selection<br/>src/agents/orchestration.ts<br/>src/agents/helpers.ts"] --> Loader
    Files["Standards<br/>src/knowledge/**/*.md"] --> Loader
    Project["Project rules<br/>AGENTS.md / CLAUDE.md"] --> Loader
  end
  Loader -->|injected into prompt| Prompt

  subgraph LLM[Model layer]
    Factory["Provider factory<br/>src/llm/factory.ts"] --> Providers["Providers<br/>src/llm/providers/*"]
    Profiles["Model profiles<br/>src/llm/models.ts"] --> Factory
  end
  CLI --> Factory
  Exec <--> Providers
  Route -. optional tie-break .-> Providers
  Scheduler -. concurrency gate<br/>src/orchestra/llm-gate.ts .-> Providers

  subgraph Dashboard[Monitor web UI]
    Events["Event bus<br/>src/core/events.ts"] --> Server["WebSocket server<br/>src/server.ts"]
    Control["Session control<br/>src/core/control.ts"] <--> Server
    Server <--> Protocol["Client protocol<br/>web/src/protocol.ts"]
    Protocol --> State["UI state<br/>web/src/state.ts"]
    State --> View["React dashboard<br/>web/src/Dashboard.tsx"]
    Vite["Vite / dev proxy<br/>web/vite.config.ts"] <--> Protocol
    Launcher["UI launcher<br/>src/ui-launcher.ts"] --> Vite
  end
  CLI -->|--serve| Server
  CLI --> Launcher
  Exec -->|events| Events
  TeamFlow -->|events| Events
  Registry -->|agent roster| Server
  View -->|task / approval / settings| Control

  subgraph Integrations[Optional integrations]
    Research["Research pipeline<br/>src/research/"]
    Search["Web search tool<br/>src/tools/web-search.tool.ts"]
    MCP["MCP manager<br/>src/mcp/client.ts<br/>mcp.config.json"]
    Notify["Notifications<br/>src/notify.ts"]
  end
  CLI --> Research
  Research --> Search
  CLI --> MCP
  Events --> Notify
  Research -. findings .-> Route
  MCP --> Tools

  classDef entry fill:#e8f1ff,stroke:#426a9b,color:#172b4d;
  classDef runtime fill:#edf7ed,stroke:#5a8e5a,color:#173817;
  classDef safety fill:#fff3e6,stroke:#b57935,color:#4b2c0a;
  classDef ui fill:#f3edff,stroke:#8063ad,color:#2e1d48;
  class CLI,Route,Registry,Prompt,Exec,TeamFlow,PM,Plan,Scheduler,Factory,Providers,Loader,Server,Protocol,State,View entry;
  class Tools,Files,Project,AgentKB,Rules,Events,Control,Research,Search,MCP,Notify runtime;
  class Safe,Locks,Debug safety;
  class Vite,Launcher ui;
```

## Subsystem ownership

| Area | Main files | Responsibility |
| --- | --- | --- |
| CLI | `src/cli.ts`, `package.json` | Commands, startup, composition, feature flags |
| Specialist agents | `src/agents/list/*.ts`, `src/agents/definitions.ts` | Prompts, roster, registry |
| Routing | `src/agents/router.ts`, `src/agents/orchestration.ts` | Forced/keyword/model route and task classification |
| Prompt context | `src/agents/helpers.ts`, `src/knowledge/` | Knowledge injection and project context |
| Executor | `src/core/executor.ts`, `src/core/executor-hooks.ts` | Model/tool loop and extension hooks |
| Tools and safety | `src/tools/`, `src/core/command-safety.ts`, `src/core/control.ts` | Workspace operations, approvals, command gating |
| Team | `src/team/` | Planning, roles, assignments, delivery/review |
| Orchestra | `src/orchestra/` | Scheduling, locks, blackboard, debug recovery |
| Models | `src/llm/`, `docs/MODELS.md` | Provider selection, profiles, caching |
| Dashboard | `src/server.ts`, `src/ui-launcher.ts`, `web/src/` | Live events and user controls |
| Integrations | `src/research/`, `src/mcp/`, `src/notify.ts` | Research, MCP tools, notifications |

## Change impact shortcuts

- **One agent's behavior:** edit its `src/agents/list/<id>.ts`; update `src/agents/definitions.ts` only when adding/removing a specialist.
- **Who receives a task:** routing rules in `src/agents/orchestration.ts` and `src/agents/router.ts`.
- **How every agent reads/writes/runs commands:** executor, tools, and safety modules; changes affect every specialist.
- **Team planning or parallel behavior:** `src/team/` and `src/orchestra/`; start with `docs/ORCHESTRA.md`.
- **Dashboard display or message contract:** `web/src/` plus `src/server.ts`; update both client and server protocol handling.
- **Agent standards:** `src/knowledge/` plus its wiring in `src/agents/helpers.ts` or `src/agents/orchestration.ts`.
- **Provider behavior:** `src/llm/` and `docs/MODELS.md`.
