// src/gateway/index.ts
//
// The Gemini access layer (no interceptor any more).
//
// This folder used to hold the "triage interceptor": every task went through a Gemini plan before the local agent
// started. That interceptor (TriageGateway) was removed. The flow is now in src/research:
//
//   ResearchAgent  (Gemini + Google Search grounding, runs first)  ──►  PlannerAgent (only when the research says a plan is needed)
//
// What stays here is the shared plumbing both stages and the other Gemini features use:
//   gemini.ts           SDK client with model fallback, retries, timeouts: plans, research, text, search, image reading
//   redact.ts           masks secret-looking values before anything leaves the machine
//   workspace-probe.ts  file-name overview of the project (no file contents, no .env)
//   types.ts / instruction.ts / render.ts   the plan schema, the planner's system instruction and its compact rendering
//
// PRIVACY: Gemini is the only place where data leaves the machine, and it is opt-in (see src/research/index.ts).

export { GeminiTriageClient, groundingStatus, resolveModels, TriageError } from "./gemini";
export type { TriagePlan } from "./types";
