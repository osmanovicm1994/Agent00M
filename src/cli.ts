#!/usr/bin/env node
// src/cli.ts
import "dotenv/config"; // must run first: some modules read AGENT_* settings when they are imported
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as dotenv from "dotenv";
import * as readline from "readline";
import { Command } from "commander";
import pc from "picocolors";
import { createProvider } from "./llm/factory";
import { LMStudioProvider } from "./llm/providers/lmstudio";
import { getProfile } from "./llm/models";
import type { LLMProvider } from "./llm/types";
import { routeTask, announceForcedAgent, announceTriageAgent } from "./agents/router";
import { getAgent, AGENTS } from "./agents/definitions";
import { Executor } from "./core/executor";
import { McpManager } from "./mcp/client";
import { bus } from "./core/events";
import { control } from "./core/control";
import { startServer, type DashboardServer } from "./server";
import { interruptRunningCommands } from "./tools/shell.tool";
import { launchDashboard, stopDashboard } from "./ui-launcher";
import { TriageGateway, GeminiTriageClient, confirmPlan, resolveModels } from "./gateway";
import { runTeam } from "./team/orchestrator";
import { describeImage, renderBriefForAgents, type DesignBrief } from "./vision/describe";

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

// Starts the live dashboard socket (--serve). Never fatal, like MCP: the CLI works without it.
async function setupUi(enabled?: boolean): Promise<DashboardServer | undefined> {
  if (!enabled) return undefined;
  try {
    const server = await startServer();
    // Starts the web app and opens the browser in the background (AGENT_UI_WEB=0 / AGENT_UI_OPEN=0 turn it off).
    void launchDashboard(server.url);
    return server;
  } catch (err: any) {
    console.log(pc.yellow(`⚠ Dashboard server failed to start: ${err?.message ?? err}`));
    return undefined;
  }
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Where the agent works when you answer "no" to "existing project?" (AGENT_DEFAULT_WORKSPACE).
// Falls back to --project / the current folder, with a warning if the configured folder is missing.
function resolveDefaultWorkspace(fallback: string): string {
  const configured = (process.env.AGENT_DEFAULT_WORKSPACE ?? "").trim();
  if (!configured) return path.resolve(fallback);
  const resolved = path.resolve(expandHome(configured));
  if (isDirectory(resolved)) return resolved;
  console.log(pc.yellow(`⚠ AGENT_DEFAULT_WORKSPACE (${resolved}) is not a folder. Using ${path.resolve(fallback)} instead.`));
  return path.resolve(fallback);
}

// Triage (Gemini) is opt-in because it is the only feature that sends data off the machine.
function triageEnv(): "on" | "off" | undefined {
  const v = (process.env.AGENT_TRIAGE ?? "").trim().toLowerCase();
  if (["on", "1", "true", "yes"].includes(v)) return "on";
  if (["off", "0", "false", "no"].includes(v)) return "off";
  return undefined;
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
  .option("-y, --auto-write", "Auto mode: write files and run commands without asking (each action is logged; risky commands still ask)")
  .option("-t, --triage", "First let Gemini analyse the task and write a plan for the local agent (sends the query + a file-name overview to Google)")
  .option("--team", "Team mode: Project Manager plans, engineers build, Safety Reviewer checks the result")
  .option("-i, --image <path>", "A picture of what you want (png/jpg/webp); it is read into a design brief the agents build from")
  .option("--serve", "Stream live agent state to the web dashboard (ws://127.0.0.1:3001/ws)")
  .action(
    async (
      task: string,
      opts: {
        agent?: string;
        project: string;
        model?: string;
        mcp: boolean;
        autoWrite?: boolean;
        serve?: boolean;
        triage?: boolean;
        team?: boolean;
        image?: string;
      },
    ) => {
      const workspaceRoot = path.resolve(opts.project);
      console.log(pc.dim(`Workspace: ${workspaceRoot}`));

      const llm = makeProvider(opts.model);
      const mcp = await setupMcp(!opts.mcp);
      const ui = await setupUi(opts.serve);

      // Ctrl+C stops a running command; with nothing running it exits.
      process.on("SIGINT", () => {
        if (interruptRunningCommands() > 0) {
          console.log(pc.yellow("\n⏹ Stopping the running command."));
          return;
        }
        mcp?.close();
        process.exit(130);
      });

      try {
        const agent = opts.agent ? getAgent(opts.agent) : undefined;
        if (opts.agent && !agent) {
          console.log(pc.red(`Agent '${opts.agent}' not found. Valid agents: ${AGENTS.map((a) => a.id).join(", ")}`));
          return;
        }
        // A reference picture is read once into text; every agent then builds from the same brief.
        let briefText = "";
        if (opts.image) {
          try {
            const b = await describeImage(opts.image);
            briefText = renderBriefForAgents(b);
            console.log(pc.green(`✔ Design brief ready (${b.source}).`));
          } catch (err: any) {
            console.log(pc.red(`${err?.message ?? err}`));
            return;
          }
        }

        // One observable run: routing + execution share a runId on the event bus.
        const result = await bus.withRun({ task, workspace: workspaceRoot }, async () => {
          const executor = new Executor(llm, workspaceRoot, mcp, { autoWrite: Boolean(opts.autoWrite) });

          // Optional Gemini triage: a plan for the local agent, plus a suggested agent.
          let planContext: string | undefined;
          let suggested: string | undefined;
          const triage = new TriageGateway();
          const useTriage = Boolean(opts.triage) || triageEnv() === "on";
          if (useTriage) {
            if (!triage.hasApiKey()) {
              console.log(pc.yellow("⚠ Triage requested but GEMINI_API_KEY is not set (put it in .env). Continuing without it."));
            } else {
              const out = await triage.run(task, workspaceRoot, executor.toolNames());
              if (out && (process.env.AGENT_TRIAGE_CONFIRM !== "1" || (await confirmPlan()))) {
                planContext = out.agentContext;
                suggested = out.recommendedAgent;
              }
            }
          }

          const combinedContext = [planContext, briefText].filter(Boolean).join("\n\n") || undefined;

          if (opts.team) {
            const team = await runTeam({
              llm,
              executor,
              task,
              workspaceRoot,
              context: combinedContext,
              approvePlan: !executor.isAutoWrite(),
              // Gemini leads (PM + UX) when you opted into Gemini; the local model is the worker.
              think: useTriage && triage.hasApiKey() ? (s, u, m, j) => triage.think(s, u, m, j) : undefined,
            });
            if (team) {
              return {
                finalMessage: team.report,
                stepsTaken: team.tasks.length,
                filesWritten: team.filesWritten,
                commandsRun: team.commandsRun,
              };
            }
            console.log(pc.dim("Continuing with a single agent.\n"));
          }

          const resolvedAgent = agent ?? (suggested ? getAgent(suggested) : undefined) ?? (await routeTask(llm, task));

          if (agent) {
            announceForcedAgent(resolvedAgent);
            console.log(pc.dim(`Using forced agent: ${resolvedAgent.id} (${resolvedAgent.name})`));
          } else if (suggested && resolvedAgent.id === suggested) {
            announceTriageAgent(resolvedAgent);
            console.log(pc.dim(`Triage selected agent: ${resolvedAgent.id} (${resolvedAgent.name})`));
          } else {
            console.log(pc.dim(`Router selected agent: ${resolvedAgent.id} (${resolvedAgent.name})`));
          }
          if (executor.isAutoWrite()) {
            console.log(
              pc.yellow("Auto mode is ON: files are written and commands are run without asking (risky commands still ask)."),
            );
          }
          return executor.run(resolvedAgent, task, combinedContext);
        });

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
        await ui?.close();
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
  .command("triage-models")
  .description("List the Gemini models your API key can use, and the order the triage gateway tries them")
  .option("--test", "Also send a tiny real request to each model in the chain and report latency")
  .action(async (opts: { test?: boolean }) => {
    try {
      console.log(pc.bold("Triage model order: ") + resolveModels().join(" → "));
      const client = new GeminiTriageClient();
      const ids = await client.listModels();
      if (!ids.length) {
        console.log(pc.yellow("The API returned no models that support generateContent."));
        return;
      }
      console.log(pc.bold("\nAvailable to your key:"));
      ids.forEach((id) => console.log(`  ${id}`));
      console.log(pc.dim("\nPick one with GEMINI_MODEL=<id> (and optionally GEMINI_FALLBACK_MODELS=a,b) in .env."));

      if (opts.test) {
        console.log(pc.bold("\nLive test (tiny request per model):"));
        for (const m of resolveModels()) {
          const r = await client.ping(m);
          console.log(`  ${r.ok ? pc.green("ok  ") : pc.red("FAIL")} ${m}  ${(r.ms / 1000).toFixed(1)}s  ${pc.dim(r.detail)}`);
        }
      }
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
  .option("--serve", "Stream live agent state to the web dashboard (ws://127.0.0.1:3001/ws)")
  .action(async (opts: { project: string; model?: string; mcp: boolean; serve?: boolean }) => {
    console.log(pc.bold("🤖 Interactive Multi-Agent CLI Started.\n"));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Dashboard first, so every startup question below can be answered there as well.
    const ui = await setupUi(opts.serve);

    // Asks in the terminal AND in the dashboard. The first answer wins and cancels the other prompt.
    const ask = async (kind: "confirm" | "text", question: string, terminalPrompt: string, defaultValue?: string): Promise<string> => {
      const { answer, via } = await control.ask({ kind, question, defaultValue }, (signal) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("answered elsewhere")), { once: true });
          rl.question(terminalPrompt, { signal }, resolve);
        }),
      );
      if (via === "dashboard") console.log(pc.dim(`\n   ↳ answered in the dashboard: ${answer || "(default)"}`));
      return answer;
    };
    const askYesNo = async (question: string, terminalPrompt: string, defaultYes = false): Promise<boolean> => {
      const answer = (await ask("confirm", question, terminalPrompt, defaultYes ? "yes" : "no")).trim().toLowerCase();
      if (answer === "") return defaultYes;
      return ["y", "yes", "j", "ja", "true", "1"].includes(answer);
    };

    // 1. Initial questionnaire. Answering "no" uses the default workspace (AGENT_DEFAULT_WORKSPACE).
    const defaultWorkspace = resolveDefaultWorkspace(opts.project);
    let workspaceRoot = defaultWorkspace;

    const isExisting = await askYesNo("Are you working on an existing project?", pc.cyan("Are you working on an existing project? (y/N): "));
    if (isExisting) {
      let chosen: string | undefined;
      for (let attempt = 0; attempt < 3 && !chosen; attempt++) {
        const typed = (
          await ask(
            "text",
            "Absolute path to the project (empty = default workspace)",
            pc.cyan(`Enter the absolute path to the project (Enter = ${defaultWorkspace}): `),
            defaultWorkspace,
          )
        ).trim();
        const candidate = path.resolve(expandHome(typed || defaultWorkspace));
        if (isDirectory(candidate)) chosen = candidate;
        else console.log(pc.red(`❌ Not a folder: ${candidate}`));
      }
      if (chosen) {
        workspaceRoot = chosen;
      } else {
        console.log(pc.yellow("⚠ No valid folder given. Using the default workspace."));
      }
    } else {
      console.log(pc.dim("Using the default workspace (set AGENT_DEFAULT_WORKSPACE to change it)."));
    }

    console.log(pc.dim(`\n✅ Workspace locked to: ${workspaceRoot}`));

    const llm = makeProvider(opts.model);
    console.log(pc.dim(`Model: ${describeModel(llm)}   (type /model to list or switch)`));

    const autoWrite = await askYesNo(
      "Auto-write: let the agent write files without asking each time?",
      pc.cyan("Auto-write: let the agent write files without asking each time? (y/N): "),
    );
    let autoRun = false;
    if (process.env.AGENT_AUTO_RUN === "0") {
      console.log(pc.dim("Auto-run is disabled by AGENT_AUTO_RUN=0: every command asks."));
    } else {
      autoRun = await askYesNo(
        "Auto-run: let the agent run shell commands without asking each time? (risky ones like rm, sudo, git push still ask)",
        pc.cyan("Auto-run: let the agent run commands without asking each time? Risky ones still ask. (y/N): "),
      );
    }
    console.log(
      autoWrite
        ? pc.yellow("✎ Auto-write ON: files are written without asking (a log line is shown for each).")
        : pc.dim("Auto-write OFF: you approve every file write. Type '/auto-write' any time to switch."),
    );
    console.log(
      autoRun
        ? pc.yellow("⚡ Auto-run ON: commands run without asking (risky ones: rm, sudo, git reset/push, kill, ... still ask).")
        : pc.dim("Auto-run OFF: you approve every command. Type '/auto-run' any time to switch."),
    );

    // Gemini triage: opt-in, because it sends the question and a file-name overview to Google.
    const triage = new TriageGateway();
    let triageOn = false;
    const triageSetting = triageEnv();
    if (triageSetting === "on") {
      triageOn = triage.hasApiKey();
      console.log(
        triageOn
          ? pc.yellow("🧭 Gemini triage ON (AGENT_TRIAGE=on): each task is analysed by Gemini first.")
          : pc.yellow("⚠ AGENT_TRIAGE=on but GEMINI_API_KEY is not set (put it in .env). Triage stays off."),
      );
    } else if (triageSetting === undefined && triage.hasApiKey()) {
      triageOn = await askYesNo(
        "Gemini triage: run every task through Gemini first? Your question and a file-name overview of the project (no file contents, secrets masked) are sent to Google.",
        pc.cyan(
          "Run every task through Gemini triage first? Your question and a file-name overview of the project (no file contents, secrets masked) are sent to Google. (y/N): ",
        ),
      );
      console.log(triageOn ? pc.yellow("🧭 Gemini triage ON. Type '/triage' to switch.") : pc.dim("Triage OFF. Type '/triage' to switch."));
    }

    const mcp = await setupMcp(!opts.mcp);
    const executor = new Executor(llm, workspaceRoot, mcp, { autoWrite, autoRun });

    console.log(pc.bold("Type 'help' or '/help' for options, your task, or 'exit' to quit.\n"));

    const shutdown = () => {
      control.setTaskHandler(undefined);
      control.cancelPendingApproval();
      void ui?.close();
      stopDashboard();
      mcp?.close();
      rl.close();
      process.exit(0);
    };
    // Ctrl+C while a command runs stops that command only; when nothing runs it ends the session.
    const onCtrlC = () => {
      if (interruptRunningCommands() > 0) {
        console.log(pc.yellow("\n⏹ Stopping the running command (Ctrl+C again when idle exits)."));
        return;
      }
      shutdown();
    };
    process.on("SIGINT", onCtrlC);
    rl.on("SIGINT", onCtrlC);

    // State for manual agent locking
    let lockedAgentId: string | undefined = undefined;
    // Team mode (PM plans, engineers build, Safety Reviewer checks) and a reference picture read into a design brief.
    let teamOn = false;
    let brief: DesignBrief | undefined;

    // Routes and runs one task as one observable run. Used by the terminal and the dashboard.
    // `origin` decides where approvals are asked; `forcedAgentId` (dashboard picker) beats the
    // session lock and the router.
    const executeTask = async (rawTask: string, origin: "terminal" | "dashboard", forcedAgentId?: string): Promise<void> => {
      // `/team <task>` runs just this task with the team; `/team` alone toggles it for every task.
      const teamRequest = /^\/team\s+\S/i.test(rawTask);
      const useTeam = teamOn || teamRequest;
      const task = teamRequest ? rawTask.replace(/^\/team\s+/i, "").trim() : rawTask;
      const briefText = brief ? renderBriefForAgents(brief) : "";
      try {
        const result = await bus.withRun({ task, workspace: workspaceRoot, origin }, async () => {
          let resolvedAgent;
          let planContext: string | undefined;
          let suggested: string | undefined;
          const forcedId = forcedAgentId ?? lockedAgentId;

          if (triageOn) {
            if (origin === "dashboard" && process.env.AGENT_TRIAGE_CONFIRM === "1") {
              // The plan confirmation is a terminal prompt; do not block a browser-started run on it.
              console.log(pc.dim("Triage skipped: AGENT_TRIAGE_CONFIRM=1 needs the terminal."));
            } else {
              const out = await triage.run(task, workspaceRoot, executor.toolNames());
              if (out && (process.env.AGENT_TRIAGE_CONFIRM !== "1" || (await confirmPlan()))) {
                planContext = out.agentContext;
                suggested = out.recommendedAgent;
              }
            }
          }

          const combinedContext = [planContext, briefText].filter(Boolean).join("\n\n") || undefined;

          if (useTeam) {
            const team = await runTeam({
              llm,
              executor,
              task,
              workspaceRoot,
              context: combinedContext,
              // You approve the plan in the terminal; auto-write mode and dashboard runs start without asking.
              approvePlan: origin === "terminal" && !executor.isAutoWrite(),
              // Gemini leads (PM + UX) while Gemini triage is ON; the local model is the worker.
              think: triageOn ? (s, u, m, j) => triage.think(s, u, m, j) : undefined,
            });
            if (team) {
              return {
                finalMessage: team.report,
                stepsTaken: team.tasks.length,
                filesWritten: team.filesWritten,
                commandsRun: team.commandsRun,
              };
            }
            console.log(pc.dim("Continuing with a single agent.\n"));
          }

          const suggestedAgent = suggested ? getAgent(suggested) : undefined;
          if (forcedId) {
            resolvedAgent = getAgent(forcedId)!;
            announceForcedAgent(resolvedAgent);
          } else if (suggestedAgent) {
            resolvedAgent = suggestedAgent;
            announceTriageAgent(resolvedAgent);
            console.log(pc.dim(`Triage selected agent: ${resolvedAgent.id} (${resolvedAgent.name})`));
          } else {
            console.log(pc.dim("... Routing task & analyzing ..."));
            resolvedAgent = await routeTask(llm, task);
            console.log(pc.dim(`Router selected agent: ${resolvedAgent.id} (${resolvedAgent.name})`));
          }

          console.log(pc.gray("🤖 Agent is thinking and executing steps...\n"));

          return executor.run(resolvedAgent, task, combinedContext);
        });

        console.log(pc.green(`\n✔ Task completed successfully (${result.stepsTaken} step(s) taken)`));

        if (result.filesWritten.length > 0) {
          console.log(pc.cyan("Files written this session:"));
          result.filesWritten.forEach((f) => console.log(`  - ${f}`));
        }
      } catch (err: any) {
        console.error(pc.red("\nExecution error:"), err?.message ?? err);
      }
    };

    // 3. Main Chat Loop
    const askQuestion = () => {
      const agentTag = lockedAgentId ? pc.magenta(`[${lockedAgentId}]`) : pc.gray("[auto]");
      const tags = `${executor.isAutoWrite() ? pc.yellow("[✎ auto-write]") : ""}${executor.isAutoRun() ? pc.yellow("[⚡ auto-run]") : ""}`;
      const promptPrefix = `${agentTag}${tags}`;

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
  ${pc.cyan("auto-write")}    | ${pc.cyan("/auto-write")} - Toggle auto-write and auto-run together (files + commands without asking)
  ${pc.cyan("/auto-run")}                   - Toggle auto-run only (commands without asking; risky ones still ask)
  ${pc.cyan("/triage")}                      - Toggle Gemini triage; ${pc.cyan("/triage show")} prints the last plan given to the agent
  ${pc.cyan("/team <task>")}                 - Run one task with the team: Project Manager plans, engineers build, Safety Reviewer checks
  ${pc.cyan("/team")}                        - Toggle team mode for every task
  ${pc.cyan("/image <path> [note]")}         - Show a picture of what you want; it is read into a design brief the agents build from
  ${pc.cyan("/image show")} | ${pc.cyan("/image clear")} - Print or drop the current design brief
  ${pc.cyan("Ctrl+C")}                       - Stops a running command (a second Ctrl+C when idle exits)
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
              ? pc.yellow("\n✎ Auto mode ON: files are written and commands are run without asking (risky commands still ask).\n")
              : pc.green("\n✔ Auto mode OFF: you approve every file write and command.\n"),
          );
          askQuestion();
          return;
        }

        if (["auto-run", "/auto-run", "autorun", "/autorun"].includes(normalizedInput)) {
          if (process.env.AGENT_AUTO_RUN === "0") {
            console.log(pc.yellow("\n⚠ Auto-run is disabled by AGENT_AUTO_RUN=0 in your env file.\n"));
          } else {
            executor.setAutoRun(!executor.isAutoRun());
            console.log(
              executor.isAutoRun()
                ? pc.yellow("\n⚡ Auto-run ON: commands run without asking (risky ones still ask).\n")
                : pc.green("\n✔ Auto-run OFF: you approve every command.\n"),
            );
          }
          askQuestion();
          return;
        }

        if (normalizedInput === "/triage" || normalizedInput === "/triage show") {
          if (normalizedInput === "/triage show") {
            console.log(triage.last ? `\n${triage.last.agentContext}\n` : pc.dim("\nNo triage plan yet.\n"));
          } else if (!triage.hasApiKey()) {
            console.log(pc.yellow("\n⚠ GEMINI_API_KEY is not set. Put it in .env (git-ignored) and restart.\n"));
          } else {
            triageOn = !triageOn;
            console.log(
              triageOn
                ? pc.yellow("\n🧭 Gemini triage ON: the question and a file-name overview are sent to Google for each task.\n")
                : pc.green("\n✔ Gemini triage OFF: everything stays local.\n"),
            );
          }
          askQuestion();
          return;
        }

        if (normalizedInput === "/team") {
          teamOn = !teamOn;
          console.log(
            teamOn
              ? pc.yellow("\n🏢 Team mode ON: every task is planned by the Project Manager, built by engineers and checked by the Safety Reviewer.\n")
              : pc.green("\n✔ Team mode OFF: tasks go to a single agent.\n"),
          );
          askQuestion();
          return;
        }

        if (normalizedInput === "/image" || normalizedInput.startsWith("/image ")) {
          const arg = task.replace(/^\/image\s*/i, "").trim();
          if (arg === "show") {
            console.log(
              brief
                ? `\n${brief.brief}\n\n${pc.dim(`(from ${brief.imagePath}, read by ${brief.source})`)}\n`
                : pc.dim("\nNo reference image yet. Use: /image <path>\n"),
            );
          } else if (arg === "clear") {
            brief = undefined;
            console.log(pc.green("\n✔ Reference design dropped.\n"));
          } else if (!arg) {
            console.log(pc.dim("\nUsage: /image <path to png/jpg/webp> [what to build from it]\n"));
          } else {
            // The first token (or a quoted path) is the file; the rest is a note for the reader.
            // A path dragged into the terminal has spaces escaped as "\ ": those stay part of the file name.
            const m = /^(?:"([^"]+)"|'([^']+)'|((?:\\ |\S)+))\s*(.*)$/.exec(arg);
            const file = m ? (m[1] ?? m[2] ?? m[3]) : arg;
            const note = m?.[4]?.trim() || undefined;
            rl.pause(); // the reader may ask for confirmation through `prompts`
            try {
              brief = await describeImage(file, note);
              console.log(pc.green(`\n✔ Design brief ready (${brief.source}). It is added to your next tasks. '/image show' prints it, '/image clear' drops it.\n`));
              console.log(pc.dim(`${brief.brief.split("\n").slice(0, 8).join("\n")}\n…\n`));
            } catch (err: any) {
              console.log(pc.red(`\n${err?.message ?? err}\n`));
            } finally {
              rl.resume();
            }
          }
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
        // One run at a time: a task started from the dashboard holds the same lock.
        if (!control.tryAcquire()) {
          console.log(pc.yellow("\n⏳ The agent is busy with a task from the dashboard. Try again when it finishes.\n"));
          askQuestion();
          return;
        }
        // Pause our readline while the executor asks y/n questions through
        // `prompts`, so two readers never fight over stdin.
        rl.pause();
        try {
          await executeTask(task, "terminal");
        } finally {
          rl.resume();
          control.release();
        }

        askQuestion();
      });
    };

    // Tasks sent from the dashboard (only with a valid control token, see server.ts). The lock was
    // already taken by control.submitTask(). Approvals for these runs are answered in the browser.
    if (ui) {
      control.setTaskHandler(async (task, agentId) => {
        console.log(pc.cyan(`\n🖥  Task from the dashboard: ${task}`));
        await executeTask(task, "dashboard", agentId);
      });
    }

    askQuestion();
  });

program.parseAsync(process.argv);
