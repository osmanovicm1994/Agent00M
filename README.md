```markdown
# agent-cli

Local Copilot-CLI / Claude-Code-style multi-agent coding system backed by DeepSeek R1 via LM Studio or cloud LLM providers (e.g., NVIDIA NIM). 

Built as a standalone CLI tool that operates safely against any target project directory with session workspace locking, fast local command interceptors, dynamic domain skill injection, and a modular registry architecture.

---

## Directory Layout

```text
agent-cli/
├── src/
│   ├── cli.ts                  # Main CLI entry point (Commander setup & chat loop)
│   ├── agents/
│   │   ├── helpers.ts          # Utility functions (e.g., loadSkill for prompt enrichment)
│   │   ├── definitions.ts      # Agent registry & lookup dispatcher
│   │   ├── router.ts           # Automatic task router selecting specialist agents
│   │   └── list/               # Individual agent definitions (Registry Pattern)
│   │       ├── dev.ts          # Development Agent
│   │       ├── api.ts          # API & Backend Agent
│   │       ├── db.ts           # Database Architect Agent
│   │       ├── design.ts       # UI/UX Design Agent
│   │       ├── logic.ts        # Logical Architecture Strategist
│   │       └── kb-harvester.ts # Knowledge Base Harvester Agent
│   ├── core/
│   │   ├── executor.ts         # Plan-act execution loop & safety guardrails
│   │   └── tools/              # File system & shell command tool execution
│   ├── knowledge/              # Markdown-based domain skill guidelines
│   │   ├── dev-standards/      # Standard coding rules loaded via loadSkill()
│   │   ├── api-standards/
│   │   ├── db-standards/
│   │   ├── logic-standards/
│   │   └── kb-standards/
│   └── llm/
│       ├── factory.ts          # LLM provider initialization
│       └── providers/          # Provider adapters (LM Studio, NVIDIA NIM, OpenAI)
├── .env.example
├── package.json
├── tsconfig.json
└── README.md

```

---

## Key Features

* **Session Workspace Locking:** Prompts for the target project path on startup and locks all file execution tools (`read_file`, `write_file`, `list_directory`, `grep`) strictly to that target workspace root.
* **Registry Pattern Architecture:** Specialist agents live in isolated files under `src/agents/list/`, keeping definitions clean, scalable, and independent.
* **Dynamic Skill Injection (`loadSkill`):** System prompts dynamically import markdown guidelines from `src/knowledge/` to inject domain expertise into agents without hardcoding large prompt strings.
* **Zero-Latency Local Interceptors:** System queries like listing agents, manual agent locking, clearing output, or displaying workspace paths bypass LLM API calls entirely.
* **Safety-First Execution:** Read-only operations proceed automatically, while state-changing disk writes (`write_file`) and shell executions (`run_command`) require explicit user confirmation.

---

## Setup

### 1. Configure Your LLM Provider

* **LM Studio (Local):** Start LM Studio, load your model (e.g., DeepSeek R1), and start the local server (default port `1234`). Note the exact model identifier.
* **NVIDIA NIM / Cloud APIs:** Set your provider base URL and API keys in your `.env` file.

### 2. Environment Configuration

Copy `.env.example` to `.env` and set your runtime options:

```bash
cp .env.example .env

```

Example `.env`:

```env
AI_PROVIDER=lmstudio
AI_MODEL_NAME=deepseek-r1-qwen-32b
LMSTUDIO_BASE_URL=http://localhost:1234/v1

```

### 3. Install & Build

```bash
npm install
npm run build

```

---

## Usage

### Interactive Multi-Agent Session (Recommended)

Launch the interactive chat interface:

```bash
npm run chat

```

On startup, lock your session to your target workspace path:

```text
🤖 Interactive Multi-Agent CLI Started.

Are you working on an existing project? (y/N): y
Enter the absolute path to the project: /Users/mustafaosmanovic/testLocalMustafa/WEB PROJECT/PREOBUCI

✅ Workspace locked to: /Users/mustafaosmanovic/testLocalMustafa/WEB PROJECT/PREOBUCI
Type 'help' or '/help' for options, your task, or 'exit' to quit.

[auto] User > 

```

### Local Commands Reference

Intercepted locally at zero cost without invoking LLM API calls:

| Command | Slash Alias | Description |
| --- | --- | --- |
| `show agents` | `/agents` | List all available specialist agents with descriptions |
| `use <agent_id>` | `/use <id>` | Lock session directly to a specific agent (e.g., `use kb-harvester`) |
| `auto` | `/auto` | Unlock agent and return to automatic task routing |
| `show project` | `/project` | Display the currently locked workspace path |
| `clean` / `clear` | `/clear` | Clear the terminal screen |
| `help` | `/help` | Print the command cheatsheet |
| `exit` / `quit` | `/exit` | Terminate the CLI session |

---

### Direct Task Execution

Run single, standalone tasks from the terminal:

```bash
# Auto-route task in the current workspace
npm run dev -- run "add a health check endpoint"

# Target a specific workspace and force an agent
npm run dev -- run "Scan project and build architecture docs" \
  --project "/Users/mustafaosmanovic/testLocalMustafa/WEB PROJECT/PREOBUCI" \
  --agent kb-harvester

```

List registered agents from the CLI:

```bash
npm run dev -- agents

```

---

## How It Works

1. **Workspace Binding:** The target directory is captured during launch and passed to the `Executor` instance. All tool file paths are validated and resolved against this target root.
2. **Task Routing & Agent Lock:**
* In **Auto Mode** (`[auto]`), `router.ts` evaluates the task description against registered agent capabilities and selects the appropriate specialist.
* In **Locked Mode** (`[agent-id]`), task routing is bypassed to eliminate latency.


3. **Dynamic Prompt Assembly:** The agent's base system prompt is loaded alongside domain-specific standards via `loadSkill()` from `src/knowledge/`.
4. **Plan-Act Loop:** The agent generates tool calls (`list_directory`, `read_file`, `write_file`, `run_command`). Read-only actions run immediately; write or shell operations require manual `y/n` approval.

---

## Adding a New Agent

1. Create a file under `src/agents/list/` (e.g., `src/agents/list/tester.ts`):
```typescript
import { AgentDefinition } from "../definitions";
import { loadSkill } from "../helpers";

export const testerAgent: AgentDefinition = {
  id: "tester",
  name: "Test Automation Agent",
  description: "Writes, refactors, and runs unit, integration, and E2E test suites.",
  systemPrompt: `You are a QA and test automation specialist...` + loadSkill("testing-standards"),
};

```


2. Register the agent in `src/agents/definitions.ts`:
```typescript
import { testerAgent } from "./list/tester";

export const AGENTS: AgentDefinition[] = [
  devAgent,
  apiAgent,
  dbAgent,
  designAgent,
  logicAgent,
  kbHarvesterAgent,
  testerAgent, // <-- Registered here
];

```



---

## Adding a New LLM Provider

To integrate a new model provider (e.g., Anthropic, Ollama, OpenAI):

1. Implement the `LLMProvider` interface in `src/llm/types.ts`.
2. Create the provider adapter under `src/llm/providers/` (e.g., `src/llm/providers/anthropic.ts`).
3. Add a creation case in `src/llm/factory.ts`.

No modifications to agent definitions, core tool execution, or routing logic are required.

```

```