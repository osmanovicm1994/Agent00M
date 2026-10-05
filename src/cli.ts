#!/usr/bin/env node
// src/cli.ts
import "dotenv/config"; // must run first: some modules read AGENT_* settings when they are imported
import * as path from "path";
import * as dotenv from "dotenv";
import * as readline from "readline";
import { Command } from "commander";
import pc from "picocolors";
import { createProvider } from "./llm/factory";
import { LMStudioProvider } from "./llm/providers/lmstudio";
import { getProfile } from "./llm/models";
import type { LLMProvider } from "./llm/types";
import { routeTask } from "./agents/router";
import { getAgent, AGENTS } from "./agents/definitions";
import { Executor } from "./core/executor";
import { McpManager } from "./mcp/client";

dotenv.config();

// Starts the MCP servers from mcp.config.json (e.g. sequential-thinking).
// Never fatal: if a server can't start the agent simply runs without it.
async function setupMcp(disabled: boolean): Promise<McpManager | undefined> {
  if (disabled) return undefined;
  const mcp = new McpManager();
  try {
    await mcp.start();
  } catch (err: any) {
    console.log(pc.yellow(`⚠ MCP setup failed: ${err?.message ?? err}`));
  }
  process.on("exit", () => mcp.close());
  return mcp;
}

function describeModel(llm: LLMProvider): string {
  return `${llm.model ?? "unknown"} · ${llm.nativeTools === false ? "fenced-block tools" : "native tool calls"}`;
}

function makeProvider(model?: string): LLMProvider {
  const providerName = (process.env.AI_PROVIDER || "lmstudio") as any;
  return createProvider(providerName, model ? { model } : undefined);
}

function printModelList(ids: string[], current?: string): void {
  for (const id of ids) {
    const profile = getProfile(id);
    const mark = id === current ? pc.green("✓") : " ";
    const tools = profile.nativeTools ? "native tools" : pc.yellow("fenced tools");
    console.log(` ${mark} ${id}  ${pc.dim(`(${tools})`)}`);
  }
}

const FENCE = "`".repeat(3);

// Checks how the loaded model really handles tools, instead of trusting the name-based
// profile in llm/models.ts. Both protocols are tried; the verdict says which one to use.
async function probeToolCalling(model?: string): Promise<void> {
  const readFile = {
    name: "read_file",
    description: "Read a file relative to the project root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"],
    },
  };
  const base = { model, printStats: false, maxTokens: 160, maxContinuations: 0 };
  console.log(pc.bold("\nTool calling"));

  let nativeOk = false;
  try {
    const res = await new LMStudioProvider({ ...base, nativeTools: true }).chat(
      [
        { role: "system", content: "You are a coding agent. Use the provided tools instead of answering in text." },
        { role: "user", content: "Read the file package.json using the read_file tool." },
      ],
      [readFile],
      { temperature: 0 },
    );
    nativeOk = Boolean(res.toolCalls?.some((c) => c.name === "read_file"));
  } catch (err: any) {
    console.log(pc.dim(`  (native probe failed: ${String(err?.message ?? err).split("\n")[0]})`));
  }

  let fencedOk = false;
  try {
    const res = await new LMStudioProvider({ ...base, nativeTools: false }).chat(
      [
        {
          role: "system",
          content:
            "You are a coding agent with one tool, read_file(path). To call it, reply with ONLY this block and nothing else:\n" +
            `${FENCE}action\n{"name": "read_file", "arguments": {"path": "<file>"}}\n${FENCE}`,
        },
        { role: "user", content: "Read the file package.json." },
      ],
      undefined,
      { temperature: 0 },
    );
    fencedOk = /"name"\s*:\s*"read_file"/.test(res.content) && /package\.json/.test(res.content);
  } catch (err: any) {
    console.log(pc.dim(`  (fenced probe failed: ${String(err?.message ?? err).split("\n")[0]})`));
  }

  const mark = (ok: boolean) => (ok ? pc.green("works") : pc.yellow("does not work"));
  console.log(`  native tool calls:    ${mark(nativeOk)}`);
  console.log(`  fenced action blocks: ${mark(fencedOk)}`);

  const profileNative = new LMStudioProvider({ model }).nativeTools;
  const using = profileNative ? "native tool calls" : "fenced action blocks";
  if (!nativeOk && !fencedOk) {
    console.log(pc.red("  Verdict: neither protocol worked. This model is not usable for the agent (or the server rejected the request)."));
  } else if (profileNative && !nativeOk) {
    console.log(pc.yellow(`  Verdict: the agent will use ${using}, but that does not work here. Set AI_NATIVE_TOOLS=off.`));
  } else if (!profileNative && nativeOk) {
    console.log(
      pc.yellow(`  Verdict: the agent will use ${using}, but native tool calls work too. AI_NATIVE_TOOLS=on saves prompt tokens and is usually more reliable.`),
    );
  } else {
    console.log(pc.green(`  Verdict: the agent will use ${using}, and that works.`));
  }
}

const program = new Command();

program
  .name("agent")
  .description("Local Copilot-CLI-style coding agent, backed by a local model via LM Studio.")
  .version("0.1.0");

program
  .command("run")
  .description("Run a task. Auto-routes to a specialist agent unless --agent is given.")
  .argument("<task>", "Natural-language description of what you want done")
  .option("-a, --agent <id>", `Force a specific agent (${AGENTS.map((a) => a.id).join(", ")})`)
  .option("-p, --project <path>", "Path to the target project (workspace root)", process.cwd())
  .option("-m, --model <id>", "Model id to use (default: AI_MODEL_NAME)")
  .option("--no-mcp", "Do not start MCP servers (e.g. sequential-thinking)")
  .option("-y, --auto-write", "Write files without asking for approval (logs each write instead)")
  .action(
    async (
      task: string,
      opts: { agent?: string; project: string; model?: string; mcp: boolean; autoWrite?: boolean },
    ) => {
      const workspaceRoot = path.resolve(opts.project);
      console.log(pc.dim(`Workspace: ${workspaceRoot}`));

      const llm = makeProvider(opts.model);
      const mcp = await setupMcp(!opts.mcp);

      try {
        const agent = opts.agent ? getAgent(opts.agent) : undefined;
        if (opts.agent && !agent) {
          console.log(pc.red(`Agent '${opts.agent}' not found. Valid agents: ${AGENTS.map((a) => a.id).join(", ")}`));
          return;
        }
        const resolvedAgent = agent ?? (await routeTask(llm, task));

        if (!agent) {
          console.log(pc.dim(`Router selected agent: ${resolvedAgent.id} (${resolvedAgent.name})`));
        } else {
          console.log(pc.dim(`Using forced agent: ${resolvedAgent.id} (${resolvedAgent.name})`));
        }

        const executor = new Executor(llm, workspaceRoot, mcp, { autoWrite: Boolean(opts.autoWrite) });
        if (executor.isAutoWrite()) {
          console.log(pc.yellow("Auto-write is ON: files are written without asking (commands still need approval)."));
        }
        const result = await executor.run(resolvedAgent, task);

        console.log(pc.dim(`\n(${result.stepsTaken} step(s) taken)`));

        // Ground-truth summary
        console.log(pc.bold("\nSummary:"));
        if (result.filesWritten.length === 0 && result.commandsRun.length === 0) {
          console.log(pc.yellow("  No files were written and no commands were run this session."));
        } else {
          if (result.filesWritten.length) {
            console.log(pc.green(`  Files written (${result.filesWritten.length}):`));
            result.filesWritten.forEach((f) => console.log(`    - ${f}`));
          }
          if (result.commandsRun.length) {
            console.log(pc.green(`  Commands run (${result.commandsRun.length}):`));
            result.commandsRun.forEach((c) => console.log(`    - ${c}`));
          }
        }
      } finally {
        mcp?.close();
      }
    },
  );

program
  .command("agents")
  .description("List available specialist agents")
  .action(() => {
    for (const a of AGENTS) {
      console.log(`${pc.bold(a.id)} — ${a.name}\n  ${pc.dim(a.description)}\n`);
    }
  });

program
  .command("models")
  .description("List the models the LM Studio server offers and how the agent talks to each")
  .action(async () => {
    const llm = makeProvider();
    try {
      const ids = (await llm.listModels?.()) ?? [];
      console.log(pc.bold(`Models at ${process.env.AI_BASE_URL ?? "http://localhost:1234/v1"}`));
      if (!ids.length) {
        console.log(pc.yellow("  The server reported no models. Download one in LM Studio and start the local server."));
        return;
      }
      printModelList(ids, llm.model);
      console.log(
        pc.dim(
          "\n'fenced tools' = the model has no tool-calling template, so the agent uses ```action blocks instead.\n" +
            "Select a model with AI_MODEL_NAME, `--model <id>`, or `/model <id>` inside `npm run chat`.",
        ),
      );
    } catch (err: any) {
      console.log(pc.red(err?.message ?? String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("bench")
  .description("Measure prompt-processing and generation speed, then check how the model handles tool calls (no cache)")
  .option("-m, --model <id>", "Model id to test (default: AI_MODEL_NAME)")
  .option("-c, --ctx <chars>", "Size of the filler prompt in characters", "6000")
  .option("-n, --tokens <n>", "Tokens to generate", "300")
  .action(async (opts: { model?: string; ctx: string; tokens: string }) => {
    const chars = Math.max(0, Number(opts.ctx) || 6000);
    const maxTokens = Math.max(32, Number(opts.tokens) || 300);
    const base = { model: opts.model, printStats: false };

    const warm = new LMStudioProvider({ ...base, maxTokens: 8, maxContinuations: 0 });
    console.log(pc.bold(`Benchmark: ${describeModel(warm)}`));

    try {
      console.log(pc.dim("Warming up (LM Studio loads the model on first use; this is not measured)…"));
      await warm.chat([{ role: "user", content: "Reply with the single word: ready" }]);

      // Realistic code-shaped filler so the prompt-processing (prefill) cost is measured too.
      let filler = "";
      for (let i = 0; filler.length < chars; i++) {
        filler += `export function helper${i}(x: number): number {\n  return x * ${i + 1} + ${i % 7};\n}\n\n`;
      }
      filler = filler.slice(0, chars);

      const bench = new LMStudioProvider({ ...base, maxTokens, maxContinuations: 0 });
      console.log(pc.dim(`Measuring (prompt ≈ ${Math.round((chars + 220) / 3.5)} tokens, generating up to ${maxTokens})…`));
      const res = await bench.chat([
        { role: "system", content: "You are a precise coding assistant." },
        {
          role: "user",
          content:
            `Here is some existing code:\n\n${filler}\n\n` +
            "Task: write a complete TypeScript module with an LRU cache class (get, set, delete, has, size, clear), " +
            "a debounce helper and a retryWithBackoff helper. Include doc comments. Output only code.",
        },
      ]);

      const s = res.stats;
      if (!s) {
        console.log(pc.red("No timing data was returned."));
        return;
      }
      const promptTokens = Math.round((chars + 330) / 3.5);
      const prefill = s.ttftMs > 0 ? promptTokens / (s.ttftMs / 1000) : 0;
      console.log("");
      console.log(`  First token:  ${(s.ttftMs / 1000).toFixed(2)} s   ${pc.dim(`(≈ ${Math.round(prefill)} tok/s prompt processing)`)}`);
      console.log(
        `  Generation:   ${pc.bold(s.tokPerSec.toFixed(1) + " tok/s")}   ${pc.dim(`(${s.estimated ? "~" : ""}${s.outTokens} tokens in ${(s.totalMs / 1000).toFixed(1)} s)`)}`,
      );
      console.log(
        pc.dim(
          "\nRule of thumb for an agent: 25+ tok/s generation feels responsive; first-token time grows with context, " +
            "so a slow first token on a 6000-char prompt means long tasks will stall on prompt processing.",
        ),
      );

      await probeToolCalling(opts.model);
    } catch (err: any) {
      console.log(pc.red(err?.message ?? String(err)));
      process.exitCode = 1;
    }
  });

program
  .command("chat")
  .description("Start an interactive multi-agent chat session")
  .option("-p, --project <path>", "Path to the target project (workspace root)", process.cwd())
  .option("-m, --model <id>", "Model id to use (default: AI_MODEL_NAME)")
  .option("--no-mcp", "Do not start MCP servers (e.g. sequential-thinking)")
  .action(async (opts: { project: string; model?: string; mcp: boolean }) => {
    console.log(pc.bold("🤖 Interactive Multi-Agent CLI Started.\n"));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const questionAsync = (query: string): Promise<string> => {
      return new Promise((resolve) => rl.question(query, resolve));
    };

    let workspaceRoot = path.resolve(opts.project);

    // 1. Initial Questionnaire
    const isExisting = await questionAsync(pc.cyan("Are you working on an existing project? (y/N): "));

    if (isExisting.trim().toLowerCase() === "y" || isExisting.trim().toLowerCase() === "yes") {
      const projectPath = await questionAsync(pc.cyan("Enter the absolute path to the project: "));
      if (projectPath.trim()) {
        workspaceRoot = path.resolve(projectPath.trim());
      }
    }

    console.log(pc.dim(`\n✅ Workspace locked to: ${workspaceRoot}`));

    const llm = makeProvider(opts.model);
    console.log(pc.dim(`Model: ${describeModel(llm)}   (type /model to list or switch)`));

    const autoAnswer = (
      await questionAsync(pc.cyan("Let the agent write files automatically, without asking each time? (y/N): "))
    )
      .trim()
      .toLowerCase();
    const autoWrite = autoAnswer === "y" || autoAnswer === "yes";
    console.log(
      autoWrite
        ? pc.yellow("✎ Auto-write ON: files are written without asking (a log line is shown for each). Commands still need approval.")
        : pc.dim("Auto-write OFF: you approve every file write. Type '/auto-write' any time to switch."),
    );

    const mcp = await setupMcp(!opts.mcp);
    const executor = new Executor(llm, workspaceRoot, mcp, { autoWrite });

    console.log(pc.bold("Type 'help' or '/help' for options, your task, or 'exit' to quit.\n"));

    const shutdown = () => {
      mcp?.close();
      rl.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);

    // State for manual agent locking
    let lockedAgentId: string | undefined = undefined;

    // 3. Main Chat Loop
    const askQuestion = () => {
      const agentTag = lockedAgentId ? pc.magenta(`[${lockedAgentId}]`) : pc.gray("[auto]");
      const promptPrefix = executor.isAutoWrite() ? `${agentTag}${pc.yellow("[✎ auto-write]")}` : agentTag;

      rl.question(`${promptPrefix} ${pc.cyan("User > ")}`, async (taskInput) => {
        const task = taskInput.trim();
        const normalizedInput = task.toLowerCase();

        // --- LOCAL INTERCEPTORS ---
        if (["exit", "quit", "/exit"].includes(normalizedInput)) {
          console.log(pc.dim("Goodbye!"));
          shutdown();
          return;
        }

        if (["help", "/help", "?"].includes(normalizedInput)) {
          console.log(`
💡 ${pc.bold("Available Local Commands:")}
  ${pc.cyan("show agents")}  | ${pc.cyan("/agents")}     - List available specialist agents
  ${pc.cyan("use <agent>")}   | ${pc.cyan("/use <id>")}   - Lock session to a specific agent
  ${pc.cyan("auto")}          | ${pc.cyan("/auto")}       - Return to automatic router
  ${pc.cyan("show project")} | ${pc.cyan("/project")}    - Display current workspace path
  ${pc.cyan("/model")}                       - List models on the server; ${pc.cyan("/model <id>")} switches
  ${pc.cyan("auto-write")}    | ${pc.cyan("/auto-write")} - Toggle writing files without asking
  ${pc.cyan("clean")}         | ${pc.cyan("clear")}       - Clear terminal screen
  ${pc.cyan("exit")}                        - End session
          `);
          askQuestion();
          return;
        }

        if (normalizedInput === "/model" || normalizedInput.startsWith("/model ")) {
          const arg = task.replace(/^\/model\s*/i, "").trim();
          try {
            const ids = (await llm.listModels?.()) ?? [];
            if (!arg) {
              console.log(pc.bold(`\nCurrent model: ${describeModel(llm)}`));
              if (ids.length) printModelList(ids, llm.model);
              console.log(pc.dim("\nSwitch with: /model <id or part of the id>\n"));
            } else {
              const needle = arg.toLowerCase();
              const exact = ids.find((id) => id.toLowerCase() === needle);
              const partial = ids.filter((id) => id.toLowerCase().includes(needle));
              const chosen = exact ?? (partial.length === 1 ? partial[0] : ids.length === 0 ? arg : undefined);

              if (!chosen) {
                console.log(
                  pc.red(
                    partial.length > 1
                      ? `\n❌ '${arg}' matches several models: ${partial.join(", ")}\n`
                      : `\n❌ No model matches '${arg}'. Type /model to list them.\n`,
                  ),
                );
              } else {
                llm.setModel?.(chosen);
                console.log(pc.green(`\n✅ Model: ${describeModel(llm)}`));
                console.log(pc.dim("LM Studio loads it on first use, so the next reply is slower. History is kept.\n"));
              }
            }
          } catch (err: any) {
            console.log(pc.red(`\n${err?.message ?? err}\n`));
          }
          askQuestion();
          return;
        }

        if (["show agents", "agents", "/agents"].includes(normalizedInput)) {
          console.log("\n🤖 Available Specialist Agents:");
          for (const a of AGENTS) {
            console.log(`  - ${pc.bold(a.id)}: ${a.name}\n    ${pc.dim(a.description)}`);
          }
          console.log("");
          askQuestion();
          return;
        }

        if (["show project", "show projects", "project", "/project"].includes(normalizedInput)) {
          console.log(`\n📁 Current Locked Project: ${workspaceRoot}\n`);
          askQuestion();
          return;
        }

        if (["auto-write", "/auto-write", "autowrite", "/autowrite"].includes(normalizedInput)) {
          executor.setAutoWrite(!executor.isAutoWrite());
          console.log(
            executor.isAutoWrite()
              ? pc.yellow("\n✎ Auto-write ON: files are written without asking.\n")
              : pc.green("\n✔ Auto-write OFF: you approve every file write.\n"),
          );
          askQuestion();
          return;
        }

        if (["clear", "clean", "/clear"].includes(normalizedInput)) {
          console.clear();
          askQuestion();
          return;
        }

        if (normalizedInput.startsWith("use ") || normalizedInput.startsWith("/use ")) {
          const targetId = task.replace(/^\/?use\s+/i, "").trim();
          const found = getAgent(targetId);
          if (found) {
            lockedAgentId = found.id;
            console.log(pc.green(`\n✅ Session locked to agent: ${found.id} (${found.name})\n`));
          } else {
            console.log(pc.red(`\n❌ Agent '${targetId}' not found. Type 'show agents' to list valid IDs.\n`));
          }
          askQuestion();
          return;
        }

        if (["auto", "/auto"].includes(normalizedInput)) {
          lockedAgentId = undefined;
          console.log(pc.green(`\n✅ Returned to automatic agent routing.\n`));
          askQuestion();
          return;
        }

        if (!task) {
          askQuestion();
          return;
        }

        // --- LLM EXECUTION ---
        // Pause our readline while the executor asks y/n questions through
        // `prompts`, so two readers never fight over stdin.
        rl.pause();
        try {
          let resolvedAgent;

          if (lockedAgentId) {
            resolvedAgent = getAgent(lockedAgentId)!;
          } else {
            console.log(pc.dim("... Routing task & analyzing ..."));
            resolvedAgent = await routeTask(llm, task);
            console.log(pc.dim(`Router selected agent: ${resolvedAgent.id} (${resolvedAgent.name})`));
          }

          console.log(pc.gray("🤖 Agent is thinking and executing steps...\n"));

          const result = await executor.run(resolvedAgent, task);

          console.log(pc.green(`\n✔ Task completed successfully (${result.stepsTaken} step(s) taken)`));

          if (result.filesWritten.length > 0) {
            console.log(pc.cyan("Files written this session:"));
            result.filesWritten.forEach((f) => console.log(`  - ${f}`));
          }
        } catch (err: any) {
          console.error(pc.red("\nExecution error:"), err?.message ?? err);
        } finally {
          rl.resume();
        }

        askQuestion();
      });
    };

    askQuestion();
  });

program.parseAsync(process.argv);
