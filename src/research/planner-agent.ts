// src/research/planner-agent.ts
//
// The planner. It does NOT run on every request: the pipeline fires it only when the research brief says a plan is
// needed (needsPlan), or when the developer forces it (AGENT_PLANNER=always, /plan always).
//
//   research brief + query + workspace overview ──► Gemini (structured JSON) ──► validated plan
//                                                                                    │
//   local agent (Executor.run) ◄── plan injected as extra context ◄──────────────────┘
//
// The plan machinery (schema, system instruction with the stack knowledge, compact rendering for a small local model)
// lives in gateway/types.ts, gateway/instruction.ts and gateway/render.ts. The research brief is passed in as a
// <research_brief> block so the planner uses what was already found instead of researching again.
//
// If anything fails the planner returns null and the local agent runs with the research brief alone.

import pc from "picocolors";
import { AGENTS, getAgent } from "../agents/definitions";
import type { GeminiTriageClient } from "../gateway/gemini";
import { redactSecrets } from "../gateway/redact";
import { printTriageSummary, renderAgentContext } from "../gateway/render";
import type { TriagePlan } from "../gateway/types";
import type { PreviousTurn } from "./research-agent";
import { renderResearchContext } from "./render";
import type { ResearchBrief, ResearchSource } from "./types";
import { escapeTags, maskedFingerprint } from "./util";

export interface PlanOutcome {
  plan: TriagePlan;
  /** Text to hand to Executor.run() as extra context. */
  context: string;
  /** A valid local agent id suggested by the plan. */
  recommendedAgent?: string;
  model: string;
  ms: number;
  redactions: number;
}

export class PlannerAgent {
  constructor(private readonly client: GeminiTriageClient) {}

  /**
   * Writes the plan for `task`, or returns null if it could not be made (a warning is printed; the caller
   * continues without a plan).
   */
  async run(
    task: string,
    workspaceRoot: string,
    toolNames: string[],
    research?: { brief: ResearchBrief; sources: ResearchSource[] },
    previous?: PreviousTurn,
  ): Promise<PlanOutcome | null> {
    const started = Date.now();
    console.log(pc.dim("📐 Planner: asking Gemini for a step-by-step plan …"));

    try {
      // 1. Nothing leaves the machine before this step.
      const query = redactSecrets(task);
      const fingerprint = maskedFingerprint(workspaceRoot);
      const prev = previous ? redactSecrets(`Request: ${previous.task}\nConclusion: ${previous.conclusion}`) : { text: "", count: 0 };
      const brief = research ? redactSecrets(renderResearchContext(research.brief, research.sources, 3500)) : { text: "", count: 0 };

      // 2. One user message with clearly separated, tagged blocks (the system instruction explains them).
      const content = [
        `<user_query>\n${escapeTags(query.text)}\n</user_query>`,
        `<workspace_fingerprint>\n${escapeTags(fingerprint.text)}\n</workspace_fingerprint>`,
        `<available_tools>\n${toolNames.join(", ")}\n</available_tools>`,
        brief.text ? `<research_brief>\n${escapeTags(brief.text)}\n</research_brief>` : "",
        prev.text ? `<previous_turn>\n${escapeTags(prev.text)}\n</previous_turn>` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      // 3. Gemini returns a validated plan (see gateway/gemini.ts for fallback and retry behaviour).
      const { plan, model } = await this.client.generatePlan(
        content,
        toolNames,
        AGENTS.map((a) => ({ id: a.id, description: a.description })),
      );

      // 4. Shape the plan for a small local model.
      const maxChars = Number(process.env.AGENT_TRIAGE_MAX_CHARS) || 4500;
      const outcome: PlanOutcome = {
        plan,
        context: renderAgentContext(plan, maxChars),
        recommendedAgent: getAgent(plan.recommendedAgent.trim())?.id,
        model,
        ms: Date.now() - started,
        redactions: query.count + fingerprint.count + prev.count,
      };
      printTriageSummary(plan, {
        model: outcome.model,
        ms: outcome.ms,
        redactions: outcome.redactions,
        recommendedAgent: outcome.recommendedAgent,
      });
      return outcome;
    } catch (err: any) {
      console.log(pc.yellow(`⚠ Planner skipped: ${err?.message ?? err}\n  Continuing without a plan.\n`));
      return null;
    }
  }
}
