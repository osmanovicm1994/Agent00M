// src/gateway/render.ts
//
// Two views of the same plan:
//  - renderAgentContext(): the text injected into the LOCAL agent's first message. Compact,
//    because the local model's context is small.
//  - printTriageSummary(): a short human-readable summary for the terminal.

import pc from "picocolors";
import type { TriagePlan } from "./types";

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function build(plan: TriagePlan, maxSteps: number, maxHypotheses: number): string {
  const out: string[] = [];

  out.push("## ARCHITECT'S PLAN (you are the worker)");
  out.push(
    "Written by the project lead/architect, who could NOT see the repository. You execute it; you do not redesign it. " +
      "Follow the design and the steps in order. If real output contradicts the plan, follow the evidence and say so in " +
      "your final answer. Hypotheses are unverified: confirm them with your tools before changing anything. Paths that " +
      "are not in the project tree must be located with find_files or grep first. You are done only when every check " +
      "listed below has been run or confirmed and you can name its result.",
  );

  if (plan.clarifiedProblem) out.push(`\nProblem: ${clip(plan.clarifiedProblem, 400)}`);
  if (plan.xy.isXYProblem || plan.xy.likelyRealGoal) {
    const flag = plan.xy.isXYProblem ? "XY problem: yes. " : "";
    out.push(`Real goal: ${flag}${clip(plan.xy.likelyRealGoal || plan.xy.note, 300)}`);
  }

  const a = plan.architecture;
  if (a.approach || a.techChoices.length || a.filesToTouch.length || a.constraints.length) {
    out.push("\nDesign:");
    if (a.approach) out.push(`Approach: ${clip(a.approach, 600)}`);
    if (a.techChoices.length) out.push(`Use: ${a.techChoices.slice(0, 6).map((s) => clip(s, 140)).join(" | ")}`);
    if (a.filesToTouch.length) {
      out.push("Files:");
      a.filesToTouch.slice(0, 10).forEach((f) => out.push(`- ${clip(f.path, 120)}${f.change ? `: ${clip(f.change, 160)}` : ""}`));
    }
    if (a.constraints.length) out.push(`Rules: ${a.constraints.slice(0, 5).map((s) => clip(s, 140)).join(" | ")}`);
  }

  if (plan.workspaces.length) {
    out.push("\nWorkspaces:");
    for (const w of plan.workspaces.slice(0, 5)) {
      out.push(`- ${w.kind} at ${w.path || "."} (${w.confidence || "?"})${w.evidence ? `: ${clip(w.evidence, 120)}` : ""}`);
    }
  }

  const hyps = plan.hypotheses.slice(0, maxHypotheses);
  if (hyps.length) {
    out.push("\nHypotheses (most likely first):");
    hyps.forEach((h, i) => {
      out.push(`${i + 1}. ${clip(h.hypothesis, 220)}${h.confirmWith ? ` | confirm: ${clip(h.confirmWith, 200)}` : ""}`);
    });
  }

  const steps = plan.steps.slice(0, maxSteps);
  if (steps.length) {
    out.push("\nSteps:");
    steps.forEach((s, i) => {
      const what = s.command ? `\`${clip(s.command, 220)}\`` : clip(s.target, 220);
      const risky = s.risky ? " [RISKY: changes state]" : "";
      out.push(`${i + 1}. [${s.phase || "?"}] ${s.tool}${risky}${what ? `: ${what}` : ""}${s.expect ? ` -> expect: ${clip(s.expect, 200)}` : ""}`);
    });
  }

  if (plan.checks.length) out.push(`\nChecks before you finish: ${plan.checks.slice(0, 5).map((s, i) => `(${i + 1}) ${clip(s, 180)}`).join(" ")}`);
  if (plan.stopConditions.length) out.push(`\nStop and report if: ${plan.stopConditions.slice(0, 4).map((s) => clip(s, 160)).join(" | ")}`);
  if (plan.risks.length) out.push(`Risks: ${plan.risks.slice(0, 3).map((s) => clip(s, 160)).join(" | ")}`);
  if (plan.docsToCheck.length) {
    out.push(
      `Verify in official docs if a fetch tool is available (otherwise say it is unverified): ${plan.docsToCheck
        .slice(0, 3)
        .map((d) => `${clip(d.topic, 60)}: ${clip(d.question, 140)}`)
        .join(" | ")}`,
    );
  }
  if (plan.needsUserInput.length) {
    out.push(`Open questions for the user (mention them in your final answer): ${plan.needsUserInput.slice(0, 3).map((s) => clip(s, 160)).join(" | ")}`);
  }

  return out.join("\n");
}

/** Renders the plan for the local agent, shrinking it until it fits `maxChars`. */
export function renderAgentContext(plan: TriagePlan, maxChars = 4500): string {
  for (const [steps, hyps] of [
    [12, 4],
    [10, 3],
    [8, 3],
    [6, 2],
    [4, 2],
  ] as const) {
    const text = build(plan, steps, hyps);
    if (text.length <= maxChars) return text;
  }
  return build(plan, 4, 2).slice(0, maxChars) + "\n[plan shortened to fit]";
}

export interface TriageMeta {
  model: string;
  ms: number;
  redactions: number;
  recommendedAgent?: string;
}

export function printTriageSummary(plan: TriagePlan, meta: TriageMeta): void {
  const secrets = meta.redactions ? ` · ${meta.redactions} secret-looking value(s) masked before sending` : "";
  console.log(pc.cyan(`\n🧭 Triage by ${meta.model} (${(meta.ms / 1000).toFixed(1)}s${secrets})`));
  if (plan.clarifiedProblem) console.log(`  ${pc.bold("Problem:")} ${clip(plan.clarifiedProblem, 300)}`);
  if (plan.xy.isXYProblem) console.log(`  ${pc.yellow("XY problem:")} real goal → ${clip(plan.xy.likelyRealGoal || plan.xy.note, 240)}`);
  if (plan.workspaces.length) {
    console.log(`  ${pc.bold("Workspaces:")} ${plan.workspaces.slice(0, 5).map((w) => `${w.kind}@${w.path || "."} (${w.confidence || "?"})`).join(", ")}`);
  }
  if (plan.architecture.approach) console.log(`  ${pc.bold("Design:")} ${clip(plan.architecture.approach, 300)}`);
  if (plan.architecture.filesToTouch.length) {
    console.log(`  ${pc.bold("Files:")} ${plan.architecture.filesToTouch.slice(0, 6).map((f) => f.path).join(", ")}`);
  }
  if (plan.checks.length) console.log(`  ${pc.bold("Checks:")} ${plan.checks.length} planned`);
  plan.hypotheses.slice(0, 3).forEach((h, i) => console.log(`  ${pc.bold(`Hypothesis ${i + 1}:`)} ${clip(h.hypothesis, 200)}`));
  console.log(
    `  ${pc.bold("Plan:")} ${plan.steps.length} step(s)${meta.recommendedAgent ? ` · agent: ${meta.recommendedAgent}` : ""}` +
      `${plan.steps.some((s) => s.risky) ? pc.yellow(" · contains risky step(s)") : ""}`,
  );
  if (plan.needsUserInput.length) {
    console.log(`  ${pc.yellow("Gemini asks you:")}`);
    plan.needsUserInput.slice(0, 3).forEach((q) => console.log(`    - ${clip(q, 200)}`));
  }
  console.log(pc.dim("  (the full plan is passed to the local agent; /triage show prints it)\n"));
}
