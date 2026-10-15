// src/research/types.ts
//
// The research brief: what the Gemini research stage hands to the next stages.
//
// Google Search grounding cannot be combined with a strict JSON response schema on every Gemini model,
// so the brief is requested as JSON in the prompt and validated here. Everything defaults (a model that
// returns null or leaves a field out must not crash the agent), and an answer that is not JSON at all
// still becomes a usable brief (see fallbackBrief).

import { z } from "zod";

// null / undefined / missing all become the empty value.
const text = z
  .string()
  .nullish()
  .transform((v) => v ?? "");
const flag = z
  .boolean()
  .nullish()
  .transform((v) => v ?? false);
const list = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(item)
    .nullish()
    .transform((v) => v ?? []);

export const researchBriefSchema = z.object({
  /** The real problem in 1-3 sentences, free of the XY trap. */
  clarifiedProblem: text,
  /** question | debug | build | change | review | other */
  intent: text,
  statedRequest: text,
  likelyRealGoal: text,
  isXYProblem: flag,
  /** e.g. "nestjs-api@apps/api" */
  stacks: list(z.string()),
  /** Facts found by searching. `source` is a title or domain; the real links come from the search metadata. */
  findings: list(z.object({ fact: text, source: text, confidence: text })),
  /** What only the repository (or the developer) can answer. */
  unknowns: list(z.string()),
  openQuestions: list(z.string()),
  /** Should a planner run after this stage? */
  needsPlan: flag,
  planReason: text,
  recommendedAgent: text,
});

export type ResearchBrief = z.infer<typeof researchBriefSchema>;

/** A page Google Search used for the answer. */
export interface ResearchSource {
  title: string;
  url: string;
}

/** Accepts plain JSON or JSON wrapped in a Markdown fence or in a sentence, then validates the shape. */
export function parseBrief(raw: string): ResearchBrief {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Gemini returned no JSON object");
  return researchBriefSchema.parse(JSON.parse(cleaned.slice(start, end + 1)));
}

/** The model answered in prose: keep what it said as one low-confidence finding instead of losing it. */
export function fallbackBrief(raw: string): ResearchBrief {
  const body = raw.replace(/\s+/g, " ").trim().slice(0, 1500);
  return researchBriefSchema.parse({ findings: body ? [{ fact: body, source: "", confidence: "low" }] : [] });
}
