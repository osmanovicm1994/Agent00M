#!/usr/bin/env node
// src/cli.ts
import * as path from "path";
import * as dotenv from "dotenv";
import * as readline from "readline";
import { Command } from "commander";
import pc from "picocolors";
import { createProvider } from "./llm/factory";
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

const program = new Command();

program
  .name("agent")
  .description("Local Copilot-CLI-style coding agent, backed by a local Qwen model via LM Studio.")
  .version("0.1.0");

program
  .command("run")
  .description("Run a task. Auto-routes to a specialist agent unless --agent is given.")
  .argument("<task>", "Natural-language description of what you want done")
  .option("-a, --agent <id>", `Force a specific agent (${AGENTS.map((a) => a.id).join(", ")})`)
  .option("-p, --project <path>", "Path to the target project (workspace root)", process.cwd())
  .option("--no-mcp", "Do not start MCP servers (e.g. sequential-thinking)")
  .action(async (task: string, opts: { agent?: string; project: string; mcp: boolean }) => {
    const workspaceRoot = path.resolve(opts.project);
    console.log(pc.dim(`Workspace: ${workspaceRoot}`));

    const llm = createProvider((process.env.AI_PROVIDER || "lmstudio") as any);
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

      const executor = new Executor(llm, workspaceRoot, mcp);
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
  });

program
  .command("agents")
  .description("List available specialist agents")
  .action(() => {
    for (const a of AGENTS) {
      console.log(`${pc.bold(a.id)} — ${a.name}\n  ${pc.dim(a.description)}\n`);
    }
  });

program
  .command("chat")
  .description("Start an interactive multi-agent chat session")
  .option("-p, --project <path>", "Path to the target project (workspace root)", process.cwd())
  .option("--no-mcp", "Do not start MCP servers (e.g. sequential-thinking)")
  .action(async (opts: { project: string; mcp: boolean }) => {
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

    const providerName = (process.env.AI_PROVIDER || "lmstudio") as any;
    const llm = createProvider(providerName);
    const mcp = await setupMcp(!opts.mcp);
    const executor = new Executor(llm, workspaceRoot, mcp);

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
      const promptPrefix = lockedAgentId ? pc.magenta(`[${lockedAgentId}]`) : pc.gray("[auto]");

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
  ${pc.cyan("clean")}         | ${pc.cyan("clear")}       - Clear terminal screen
  ${pc.cyan("exit")}                        - End session
          `);
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
