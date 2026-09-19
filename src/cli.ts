#!/usr/bin/env node
import * as path from "path";
import * as dotenv from "dotenv";
import { Command } from "commander";
import pc from "picocolors";
import { createProvider } from "./llm/factory";
import { routeTask } from "./agents/router";
import { getAgent, AGENTS } from "./agents/definitions";
import { Executor } from "./core/executor";

dotenv.config();

const program = new Command();

program
  .name("agent")
  .description("Local Copilot-CLI-style coding agent, backed by DeepSeek R1 via LM Studio.")
  .version("0.1.0");

program
  .command("run")
  .description("Run a task. Auto-routes to a specialist agent unless --agent is given.")
  .argument("<task>", "Natural-language description of what you want done")
  .option("-a, --agent <id>", `Force a specific agent (${AGENTS.map((a) => a.id).join(", ")})`)
  .option("-p, --project <path>", "Path to the target project (workspace root)", process.cwd())
  .action(async (task: string, opts: { agent?: string; project: string }) => {
    const workspaceRoot = path.resolve(opts.project);
    console.log(pc.dim(`Workspace: ${workspaceRoot}`));

    const llm = createProvider("lmstudio");

    const agent = opts.agent ? getAgent(opts.agent) : undefined;
    const resolvedAgent = agent ?? (await routeTask(llm, task));

    if (!agent) {
      console.log(pc.dim(`Router selected agent: ${resolvedAgent.id} (${resolvedAgent.name})`));
    } else {
      console.log(pc.dim(`Using forced agent: ${resolvedAgent.id} (${resolvedAgent.name})`));
    }

    const executor = new Executor(llm, workspaceRoot);
    const result = await executor.run(resolvedAgent, task);

    console.log(pc.dim(`\n(${result.stepsTaken} step(s) taken)`));

    // Ground-truth summary — never trust the model's own prose about what it
    // "did", since it has been observed to narrate success with zero actual
    // write_file/run_command calls. This block is the source of truth.
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
  });

program
  .command("agents")
  .description("List available specialist agents")
  .action(() => {
    for (const a of AGENTS) {
      console.log(`${pc.bold(a.id)} — ${a.name}\n  ${pc.dim(a.description)}\n`);
    }
  });

program.parseAsync(process.argv);
