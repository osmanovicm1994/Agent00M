// src/gateway/types.ts
//
// The shape of the plan Gemini returns. Two things are defined here from one description:
//  - planSchema: a lenient zod schema used to VALIDATE what comes back (a model that returns
//    null or omits a field must not crash the agent, so everything defaults).
//  - buildResponseSchema(): the JSON Schema sent to Gemini so it answers in this exact shape.

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

const xySchema = z.object({
  statedRequest: text,
  likelyRealGoal: text,
  isXYProblem: flag,
  note: text,
});

export const planSchema = z.object({
  clarifiedProblem: text,
  xy: xySchema.nullish().transform((v) => v ?? xySchema.parse({})),
  workspaces: list(
    z.object({
      kind: text,
      path: text,
      confidence: text,
      evidence: text,
    }),
  ),
  hypotheses: list(
    z.object({
      hypothesis: text,
      evidence: text,
      confirmWith: text,
    }),
  ),
  recommendedAgent: text,
  steps: list(
    z.object({
      phase: text,
      tool: text,
      target: text,
      command: text,
      expect: text,
      risky: flag,
    }),
  ),
  stopConditions: list(z.string()),
  risks: list(z.string()),
  docsToCheck: list(z.object({ topic: text, question: text })),
  needsUserInput: list(z.string()),
});

export type TriagePlan = z.infer<typeof planSchema>;

export const WORKSPACE_KINDS = [
  "ios",
  "android",
  "nestjs-api",
  "nextjs-web",
  "node-monorepo-root",
  "database",
  "playwright",
  "appium",
  "dotnet",
  "python",
  "docker",
  "other",
] as const;

export const STEP_PHASES = ["collect", "confirm", "fix", "verify"] as const;

/**
 * JSON Schema for Gemini's structured output. `toolNames` restricts each step to tools the local
 * agent really has, and `agentIds` restricts the routing suggestion to real agents.
 */
export function buildResponseSchema(toolNames: string[], agentIds: string[]): Record<string, unknown> {
  const str = { type: "string" };
  const strList = { type: "array", items: str };
  return {
    type: "object",
    properties: {
      clarifiedProblem: { type: "string", description: "The real problem in 1-3 sentences, free of the XY trap." },
      xy: {
        type: "object",
        properties: {
          statedRequest: str,
          likelyRealGoal: str,
          isXYProblem: { type: "boolean" },
          note: str,
        },
        required: ["statedRequest", "likelyRealGoal", "isXYProblem"],
      },
      workspaces: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...WORKSPACE_KINDS] },
            path: { type: "string", description: "Relative to the project root; '.' for the root." },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            evidence: str,
          },
          required: ["kind", "path", "confidence"],
        },
      },
      hypotheses: {
        type: "array",
        description: "Ranked, most likely first. Maximum 4.",
        items: {
          type: "object",
          properties: { hypothesis: str, evidence: str, confirmWith: str },
          required: ["hypothesis", "confirmWith"],
        },
      },
      recommendedAgent: { type: "string", enum: agentIds },
      steps: {
        type: "array",
        description: "Ordered steps for the local agent. Maximum 12.",
        items: {
          type: "object",
          properties: {
            phase: { type: "string", enum: [...STEP_PHASES] },
            tool: { type: "string", enum: toolNames.length ? toolNames : undefined },
            target: { type: "string", description: "File path(s), search pattern or topic. Empty for run_command." },
            command: { type: "string", description: "Exact non-interactive shell command for run_command. Empty otherwise." },
            expect: { type: "string", description: "What the output should show, and what it means if it does not." },
            risky: { type: "boolean", description: "True if the step changes state (writes, installs, deletes, restarts)." },
          },
          required: ["phase", "tool", "expect"],
        },
      },
      stopConditions: { ...strList, description: "When the local agent must stop and report instead of continuing." },
      risks: strList,
      docsToCheck: {
        type: "array",
        description: "Version-sensitive facts worth verifying in official docs before relying on them.",
        items: { type: "object", properties: { topic: str, question: str }, required: ["topic", "question"] },
      },
      needsUserInput: { ...strList, description: "Questions only the user can answer. Maximum 3." },
    },
    required: ["clarifiedProblem", "xy", "workspaces", "hypotheses", "recommendedAgent", "steps"],
  };
}
