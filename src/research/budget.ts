// src/research/budget.ts
//
// One size limit for everything the research stage hands to the local model (the brief AND the plan together).
// A local model has a small context, so the total is fixed and split: without a plan the brief gets all of it; with a
// plan the brief gets 40% and the plan 60%.
//
// AGENT_RESEARCH_MAX_CHARS sets the TOTAL (default 2800 without a plan, 4600 with one; allowed 800 to 20000).

import { boundedInt } from "../orchestra/env-int";

export interface ContextBudget {
  total: number;
  research: number;
  plan: number;
}

export function contextBudget(hasPlan: boolean, env: NodeJS.ProcessEnv = process.env): ContextBudget {
  const total = boundedInt(env.AGENT_RESEARCH_MAX_CHARS, hasPlan ? 4600 : 2800, 800, 20_000);
  if (!hasPlan) return { total, research: total, plan: 0 };
  const research = Math.round(total * 0.4);
  return { total, research, plan: total - research };
}

const NOTE = "\n[shortened to fit]";

/** At most `max` characters including the note that says it was shortened. */
export function fitText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - NOTE.length)) + NOTE;
}

const JOINER = "\n\n";

/** Brief and plan as one block that never exceeds budget.total. */
export function combineContext(research: string, plan: string, budget: ContextBudget): string {
  const parts: string[] = [];
  if (research) parts.push(fitText(research, plan ? budget.research : budget.total));
  if (plan) parts.push(fitText(plan, budget.plan - (research ? JOINER.length : 0)));
  return parts.join(JOINER);
}
