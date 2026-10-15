// src/research/render.ts
//
// Two views of the same research brief:
//  - renderResearchContext(): the text injected into the LOCAL agent's first message (and into the planner's
//    input). Compact, because the local model's context is small.
//  - printResearchSummary(): a short human-readable summary for the terminal.

import pc from "picocolors";
import type { ResearchBrief, ResearchSource } from "./types";
import { clip } from "./util";

function build(brief: ResearchBrief, sources: ResearchSource[], maxFindings: number, maxSources: number): string {
  const out: string[] = [];

  out.push("## RESEARCH BRIEF");
  out.push(
    "Prepared before you started by a research stage that could use Google Search but could NOT see the repository " +
      "(only file names). Use it as background, not as an order. Findings marked low are unverified: confirm anything " +
      "version-sensitive with your tools or an official page before you rely on it. Real output beats this brief; if " +
      "they disagree, follow the output and say so in your final answer.",
  );

  if (brief.clarifiedProblem) out.push(`\nProblem: ${clip(brief.clarifiedProblem, 400)}`);
  if (brief.isXYProblem || brief.likelyRealGoal) {
    const flag = brief.isXYProblem ? "XY problem: yes. " : "";
    out.push(`Real goal: ${flag}${clip(brief.likelyRealGoal || brief.statedRequest, 300)}`);
  }
  if (brief.stacks.length) out.push(`Stacks: ${brief.stacks.slice(0, 6).map((s) => clip(s, 80)).join(", ")}`);

  const findings = brief.findings.filter((f) => f.fact).slice(0, maxFindings);
  if (findings.length) {
    out.push("\nFindings:");
    findings.forEach((f) =>
      out.push(`- [${f.confidence || "?"}] ${clip(f.fact, 260)}${f.source ? ` (${clip(f.source, 60)})` : ""}`),
    );
  }

  if (brief.unknowns.length) out.push(`\nCheck in the repository: ${brief.unknowns.slice(0, 5).map((s) => clip(s, 160)).join(" | ")}`);
  if (brief.openQuestions.length) {
    out.push(`Open questions for the user (mention them in your final answer): ${brief.openQuestions.slice(0, 3).map((s) => clip(s, 160)).join(" | ")}`);
  }

  const shown = sources.slice(0, maxSources);
  if (shown.length) {
    out.push("\nSources (Google Search):");
    shown.forEach((s, i) => out.push(`${i + 1}. ${clip(s.title, 70)} - ${s.url}`));
  }

  return out.join("\n");
}

/** Renders the brief for the local agent, shrinking it until it fits `maxChars`. */
export function renderResearchContext(brief: ResearchBrief, sources: ResearchSource[], maxChars = 2800): string {
  for (const [findings, srcs] of [
    [8, 6],
    [6, 5],
    [5, 4],
    [4, 3],
    [3, 2],
  ] as const) {
    const text = build(brief, sources, findings, srcs);
    if (text.length <= maxChars) return text;
  }
  return build(brief, sources, 3, 2).slice(0, maxChars) + "\n[brief shortened to fit]";
}

export interface ResearchMeta {
  model: string;
  ms: number;
  redactions: number;
  grounded: boolean;
  /** Why Google Search was not used, when it was not. */
  note?: string;
  queries: string[];
  sourceCount: number;
  recommendedAgent?: string;
}

export function printResearchSummary(brief: ResearchBrief, meta: ResearchMeta): void {
  const secrets = meta.redactions ? ` · ${meta.redactions} secret-looking value(s) masked before sending` : "";
  console.log(pc.cyan(`\n🔎 Research by ${meta.model} (${(meta.ms / 1000).toFixed(1)}s${secrets})`));
  if (brief.clarifiedProblem) console.log(`  ${pc.bold("Problem:")} ${clip(brief.clarifiedProblem, 300)}${brief.intent ? pc.dim(` [${brief.intent}]`) : ""}`);
  if (brief.isXYProblem) console.log(`  ${pc.yellow("XY problem:")} real goal → ${clip(brief.likelyRealGoal, 240)}`);
  if (brief.stacks.length) console.log(`  ${pc.bold("Stacks:")} ${brief.stacks.slice(0, 5).join(", ")}`);
  if (meta.grounded) {
    const searched = meta.queries.length
      ? `${meta.queries.length} Google search(es): ${meta.queries.slice(0, 3).map((q) => clip(q, 60)).join(" | ")}`
      : "Google Search was available, the model did not need it";
    console.log(`  ${pc.bold("Web:")} ${searched}${meta.sourceCount ? ` · ${meta.sourceCount} source(s)` : ""}`);
  } else {
    console.log(`  ${pc.bold("Web:")} ${meta.note ? pc.yellow(meta.note) : pc.dim("no web search in this stage (AGENT_RESEARCH_GROUNDING=1 would use Gemini's small free Google Search quota); the local agent searches with web_search")}`);
  }
  brief.findings.filter((f) => f.fact).slice(0, 4).forEach((f, i) => console.log(`  ${pc.bold(`Finding ${i + 1}:`)} [${f.confidence || "?"}] ${clip(f.fact, 200)}`));
  if (brief.unknowns.length) console.log(`  ${pc.bold("To check in the repo:")} ${brief.unknowns.length} item(s)`);
  console.log(
    `  ${pc.bold("Plan needed:")} ${brief.needsPlan ? pc.yellow("yes") : "no"}${brief.planReason ? pc.dim(` (${clip(brief.planReason, 140)})`) : ""}` +
      `${meta.recommendedAgent ? ` · agent: ${meta.recommendedAgent}` : ""}`,
  );
  if (brief.openQuestions.length) {
    console.log(`  ${pc.yellow("Gemini asks you:")}`);
    brief.openQuestions.slice(0, 3).forEach((q) => console.log(`    - ${clip(q, 200)}`));
  }
  console.log(pc.dim("  (the brief is passed to the local agent; /research show prints it)\n"));
}
