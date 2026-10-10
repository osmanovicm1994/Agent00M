// src/gateway/index.ts
//
// The interceptor. In front of the local agent loop:
//
//   user query ──► redact secrets ──► probe workspace (file names only) ──► Gemini ──► validated plan
//                                                                                          │
//   local agent (Executor.run) ◄── plan injected as extra context + recommended agent ◄────┘
//
// If anything fails (no key, no network, bad JSON) the interceptor returns null and the local
// agent simply runs on the original query: triage can never block work.
//
// PRIVACY: this is the one place where data leaves the machine. What is sent: the query and a
// file-name overview of the project (see workspace-probe.ts), both with secret-looking values
// masked. It is OFF unless you turn it on (AGENT_TRIAGE=on, `run --triage`, or the chat prompt).

import pc from "picocolors";
import prompts from "prompts";
import { AGENTS, getAgent } from "../agents/definitions";
import { GeminiTriageClient } from "./gemini";
import { fingerprintToJson, probeWorkspace } from "./workspace-probe";
import { redactSecrets } from "./redact";
import { printTriageSummary, renderAgentContext } from "./render";
import type { TriagePlan } from "./types";

export { GeminiTriageClient, resolveModels, TriageError } from "./gemini";
export type { TriagePlan } from "./types";

export interface TriageOutcome {
  plan: TriagePlan;
  /** Text to hand to Executor.run() as extra context. */
  agentContext: string;
  /** A valid local agent id suggested by the plan (lets the CLI skip the local routing call). */
  recommendedAgent?: string;
  model: string;
  ms: number;
  redactions: number;
}

/** Neutralise anything that could close or fake one of our tags inside the pasted query. */
function escapeTags(s: string): string {
  return s.replace(/<\/?(user_query|workspace_fingerprint|available_tools|previous_turn)>/gi, (m) => m.replace("<", "< "));
}

export class TriageGateway {
  private readonly client = new GeminiTriageClient();
  private previous?: { task: string; conclusion: string };
  /** The most recent successful outcome (for `/triage show`). */
  last?: TriageOutcome;

  hasApiKey(): boolean {
    return Boolean(GeminiTriageClient.resolveApiKey());
  }

  /**
   * Analyses `task` with Gemini and returns the plan for the local agent, or null if triage
   * could not be done (a warning is printed; the caller continues without a plan).
   */
  async run(task: string, workspaceRoot: string, toolNames: string[]): Promise<TriageOutcome | null> {
    const started = Date.now();
    console.log(pc.dim("🧭 Triage: asking Gemini to analyse the problem …"));

    try {
      // 1. Nothing leaves the machine before this step.
      const query = redactSecrets(task);
      const fingerprint = redactSecrets(fingerprintToJson(probeWorkspace(workspaceRoot)));
      const prev = this.previous
        ? redactSecrets(`Request: ${this.previous.task}\nConclusion: ${this.previous.conclusion}`)
        : { text: "", count: 0 };

      // 2. One user message with clearly separated, tagged blocks (the system instruction explains them).
      const content = [
        `<user_query>\n${escapeTags(query.text)}\n</user_query>`,
        `<workspace_fingerprint>\n${escapeTags(fingerprint.text)}\n</workspace_fingerprint>`,
        `<available_tools>\n${toolNames.join(", ")}\n</available_tools>`,
        prev.text ? `<previous_turn>\n${escapeTags(prev.text)}\n</previous_turn>` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      // 3. Gemini returns a validated plan (see gemini.ts for fallback and retry behaviour).
      const { plan, model } = await this.client.generatePlan(
        content,
        toolNames,
        AGENTS.map((a) => ({ id: a.id, description: a.description })),
      );

      // 4. Shape the plan for a small local model.
      const maxChars = Number(process.env.AGENT_TRIAGE_MAX_CHARS) || 4500;
      const outcome: TriageOutcome = {
        plan,
        agentContext: renderAgentContext(plan, maxChars),
        recommendedAgent: getAgent(plan.recommendedAgent.trim())?.id,
        model,
        ms: Date.now() - started,
        redactions: query.count + fingerprint.count + prev.count,
      };

      this.last = outcome;
      this.previous = { task: task.slice(0, 500), conclusion: plan.clarifiedProblem.slice(0, 300) };
      printTriageSummary(plan, outcome);
      return outcome;
    } catch (err: any) {
      console.log(pc.yellow(`⚠ Triage skipped: ${err?.message ?? err}\n  Continuing with the local agent only.\n`));
      return null;
    }
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

/** Optional safety net (AGENT_TRIAGE_CONFIRM=1): let the developer veto the plan before it is used. */
export async function confirmPlan(): Promise<boolean> {
  const answer = await prompts({ type: "confirm", name: "ok", message: "Give this plan to the local agent?", initial: true });
  return answer.ok !== false;
}
