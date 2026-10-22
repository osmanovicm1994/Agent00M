// src/research/index.ts
//
// The Gemini front stage of the agent. It replaces the old always-on "triage interceptor":
//
//   user query ──► ResearchAgent (Gemini + Google Search grounding)  ── always first
//                      │ brief: problem, XY check, facts with sources, unknowns, needsPlan
//                      ▼
//                  needsPlan? ── yes (or AGENT_PLANNER=always) ──► PlannerAgent (Gemini, structured plan)
//                      │ no
//                      ▼
//   local agent (Executor.run) ◄── research brief (+ plan when one was made) as extra context
//
// Failure never blocks: no key, no network, quota, bad JSON -> a warning is printed and the local agent runs on the
// original query. Off by default, because it is a feature that sends data off the machine (see research-agent.ts).
//
// Env:
//   AGENT_RESEARCH=on|off           turn the stage on or off (AGENT_TRIAGE is accepted as an older name)
//   AGENT_PLANNER=auto|always|off   auto (default): plan only when the research says it is needed
//   AGENT_RESEARCH_GROUNDING=0      understand the request without Google Search
//   AGENT_RESEARCH_TIMEOUT_MS       research call timeout (default: AGENT_TRIAGE_TIMEOUT_MS, 60000)
//   AGENT_RESEARCH_MAX_CHARS        TOTAL size of brief + plan handed to the local model (default 2800, 4600 with a plan; see budget.ts)
//   AGENT_RESEARCH_CONFIRM=1        ask before the brief/plan is given to the local agent

import pc from "picocolors";
import prompts from "prompts";
import { GeminiTriageClient } from "../gateway/gemini";
import { redactSecrets } from "../gateway/redact";
import { runWebResearch } from "../tools/web-search.tool";
import { combineContext, contextBudget } from "./budget";
import { PlannerAgent, type PlanOutcome } from "./planner-agent";
import { renderResearchContext } from "./render";
import { ResearchAgent, type PreviousTurn, type ResearchOutcome } from "./research-agent";
import { clip } from "./util";

export type { ResearchBrief, ResearchSource } from "./types";
export type { ResearchOutcome } from "./research-agent";
export type { PlanOutcome } from "./planner-agent";

export type PlannerMode = "auto" | "always" | "off";

/** on / off from AGENT_RESEARCH (or the older AGENT_TRIAGE); undefined = not decided, ask at chat startup. */
export function researchEnv(): "on" | "off" | undefined {
  const v = (process.env.AGENT_RESEARCH || process.env.AGENT_TRIAGE || "").trim().toLowerCase();
  if (["on", "1", "true", "yes"].includes(v)) return "on";
  if (["off", "0", "false", "no"].includes(v)) return "off";
  return undefined;
}

export function plannerModeEnv(): PlannerMode {
  const v = (process.env.AGENT_PLANNER ?? "").trim().toLowerCase();
  return v === "always" || v === "off" ? v : "auto";
}

/** True when the developer wants to veto the brief/plan before the local agent sees it. */
export function confirmRequired(): boolean {
  return process.env.AGENT_RESEARCH_CONFIRM === "1" || process.env.AGENT_TRIAGE_CONFIRM === "1";
}

export async function confirmPlan(): Promise<boolean> {
  const answer = await prompts({ type: "confirm", name: "ok", message: "Give this research brief and plan to the local agent?", initial: true });
  return answer.ok !== false;
}

const REALTIME_RE = /\b(weather|forecast|temperature|news|headlines?|exchange rate|stock price|share price|bitcoin|score|standings|who won|results? of|today'?s|tonight|tomorrow)\b/i;
const CODE_RE = /\b(code|bug|error|exception|stack ?trace|function|class|component|api|endpoint|repo|repository|file|npm|package|install|build|compile|test|deploy|docker|database|sql|typescript|javascript|python|react|node|playwright|appium|git|refactor|implement|fix)\b|\.(ts|tsx|js|json|py|cs|md)\b/i;

/** A plain real-time question (weather, news, prices, scores) that has nothing to do with the project: Gemini adds nothing here. */
export function isGeneralRealtime(task: string): boolean {
  return REALTIME_RE.test(task) && !CODE_RE.test(task);
}

/**
 * For a plain real-time question the live web results are fetched HERE (local SearXNG, the user's own words as the query)
 * and handed to the agent as context. A small local model otherwise wanders through the repository or searches for
 * "how do I get the weather" instead of the weather. Returns null when the search fails (the agent then searches itself).
 */
export async function prefetchRealtime(task: string): Promise<string | null> {
  console.log(pc.dim("🌐 Real-time question: searching the web locally first …"));
  try {
    const text = await runWebResearch({ question: task, maxPages: 3 });
    if (!text || /^\s*(❌|error|web research failed)/i.test(text)) return null;
    return [
      "## LIVE WEB RESULTS",
      "These were fetched just now from the web for the user's question. Answer from them. Do NOT call file tools (get_directory_tree, grep, read_file, find_files): the question has nothing to do with the project. Do not search again unless these results clearly miss the answer.",
      "Give the numbers or facts the pages report, say which place and date/time they refer to, and cite the URLs. If the user named no place and the pages assume one, say which place you used and offer to check another. If the results do not contain the answer, say so plainly.",
      "",
      text.length > 5500 ? text.slice(0, 5500) + "\n[results shortened]" : text,
    ].join("\n");
  } catch (err: any) {
    console.log(pc.yellow(`⚠ Local pre-search failed: ${String(err?.message ?? err).split("\n")[0]}. The agent will search itself.`));
    return null;
  }
}

export interface PipelineOutcome {
  /** Text to hand to Executor.run() as extra context: the research brief first, then the plan if one was made. */
  context: string;
  /** A valid local agent id suggested by the plan, else by the research (skips the local routing call). */
  recommendedAgent?: string;
  research?: ResearchOutcome;
  plan?: PlanOutcome;
}

export class ResearchPipeline {
  private readonly client = new GeminiTriageClient();
  private readonly researcher = new ResearchAgent(this.client);
  private readonly planner = new PlannerAgent(this.client);
  private previous?: PreviousTurn;

  /** auto: plan only when needed; always: plan after every research; off: never plan. */
  plannerMode: PlannerMode = plannerModeEnv();
  /** The most recent successful outcome (for `/research show`). */
  last?: PipelineOutcome;

  hasApiKey(): boolean {
    return Boolean(GeminiTriageClient.resolveApiKey());
  }

  /**
   * Runs the research stage, then the planner when it is needed. Returns null when neither produced anything
   * (warnings were printed; the caller continues with the local agent only).
   */
  async run(task: string, workspaceRoot: string, toolNames: string[]): Promise<PipelineOutcome | null> {
    if (isGeneralRealtime(task)) {
      console.log(pc.dim("🔎 Research stage skipped: plain real-time question, the local agent searches with local SearXNG."));
      return null;
    }
    const research = await this.researcher.run(task, workspaceRoot, this.previous);

    const wantPlan = this.plannerMode === "always" || (this.plannerMode === "auto" && Boolean(research?.brief.needsPlan));
    let plan: PlanOutcome | null = null;
    if (wantPlan) {
      if (research?.brief.planReason) console.log(pc.dim(`📐 Plan needed: ${clip(research.brief.planReason, 160)}`));
      plan = await this.planner.run(
        task,
        workspaceRoot,
        toolNames,
        research ? { brief: research.brief, sources: research.sources } : undefined,
        this.previous,
      );
    } else if (research) {
      console.log(
        pc.dim(this.plannerMode === "off" ? "📐 Planner is off (/plan auto turns it on)." : "📐 No plan needed for this request (/plan always forces one)."),
      );
    }

    if (!research && !plan) return null;

    // One combined cap: the brief and the plan together never exceed AGENT_RESEARCH_MAX_CHARS.
    const budget = contextBudget(Boolean(plan));
    const context = combineContext(research ? renderResearchContext(research.brief, research.sources, budget.research) : "", plan?.context ?? "", budget);

    const outcome: PipelineOutcome = {
      context,
      recommendedAgent: plan?.recommendedAgent ?? research?.recommendedAgent,
      research: research ?? undefined,
      plan: plan ?? undefined,
    };
    this.last = outcome;
    this.previous = {
      task: task.slice(0, 500),
      conclusion: (plan?.plan.clarifiedProblem || research?.brief.clarifiedProblem || "").slice(0, 300),
    };
    return outcome;
  }

  /**
   * One Gemini call for a team lead role (Project Manager, UX Designer). Secrets are masked first.
   * Returns null on any failure so the caller can fall back to the local model.
   */
  async think(system: string, user: string, maxTokens: number, json = false): Promise<string | null> {
    try {
      const { text } = await this.client.generateText(system, redactSecrets(user).text, { json, maxTokens: Math.max(maxTokens, 4096) });
      return text;
    } catch (err: any) {
      console.log(pc.yellow(`⚠ Gemini lead step failed: ${err?.message ?? err}`));
      return null;
    }
  }
}
