# agent-cli

Local Copilot-CLI/Claude-Code-style coding agent, backed by DeepSeek R1 via LM Studio.
Standalone tool — works against any project directory, including Preobuci.

## Setup

1. Start LM Studio, load a DeepSeek R1 model, and start the local server (Developer tab →
   Start Server). Note the port (default `1234`) and the exact model identifier shown in
   LM Studio.
2. Copy `.env.example` to `.env` and adjust `AI_MODEL_NAME` to match the model id LM Studio
   reports.
3. Install deps and build:
   ```bash
   npm install
   npm run build
   ```

## Usage

Run against the current directory:
```bash
npm run dev -- run "add a health check endpoint"
```

Run against another project (e.g. Preobuci), forcing a specific agent:
```bash
npm run dev -- run "add a GET /health endpoint" --project "/Users/mustafaosmanovic/testLocalMustafa/WEB PROJECT/PREOBUCI" --agent api
```

List available agents:
```bash
npm run dev -- agents
```

## How it works

1. **Router** picks a specialist agent (`dev`, `api`, `design`) for your task, unless you pass `--agent`.
2. **Executor** runs a plan→act loop: the agent can call `read_file`, `list_directory`,
   `find_files`, `grep` freely (read-only), but `write_file` and `run_command` always show
   you a diff/command and require a y/n confirmation before anything touches disk or runs.
3. Loop continues (feeding tool results back to the model) until the agent has no more
   actions to propose, or a 15-step safety cap is hit.

## Known limitation

Not all DeepSeek R1 builds in LM Studio support native OpenAI-style tool calling. The
executor also accepts a fallback \`\`\`action json code-block format if native tool_calls
don't come back — see `src/core/executor.ts`. If actions aren't being picked up at all with
your specific model/quant, tell me and I'll tune the fallback parsing or prompt format.

## Adding a new LLM backend later (e.g. real Claude)

Implement `LLMProvider` from `src/llm/types.ts` in a new file under `src/llm/providers/`,
then add a case in `src/llm/factory.ts`. Nothing in agents/executor/router needs to change.
