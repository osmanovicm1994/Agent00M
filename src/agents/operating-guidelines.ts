// src/agents/operating-guidelines.ts
//
// The operating guidelines: how every agent is told to WORK (not what to know). They sit at the very start of each
// agent's system prompt, in the same way a product's system prompt starts with how the assistant behaves, and the
// agent's own prompt and standards follow.
//
// Two versions:
//  - full  (00-agent-core/operating-guidelines.md): the roles that build things. Plan from the spec, build in slices,
//          check each slice, stay inside the limits, report honestly. A one-paragraph role focus is added at the end.
//  - lite  (00-agent-core/operating-guidelines-lite.md): roles that investigate or review and must stay cheap
//          (debug, safety reviewer, research, knowledge harvester, logic).
//
// The text lives in markdown files so it can be edited without touching code. The identical first block in every
// prompt also helps the local model server: it can reuse its cached prompt prefix between agents.
//
// AGENT_GUIDELINES=0 switches the block off (for comparing runs).

import { readKnowledgeFile } from "./helpers";

export const FULL_GUIDELINES_FILE = "00-agent-core/operating-guidelines.md";
export const LITE_GUIDELINES_FILE = "00-agent-core/operating-guidelines-lite.md";

/** Roles that investigate or review: they get the short version so a debugging or review run stays cheap. */
export const LITE_GUIDELINE_AGENTS: ReadonlySet<string> = new Set(["debug", "safety", "research", "kb-harvester", "logic"]);

/** What each building role delivers. Added under "Your role in this team". */
export const ROLE_FOCUS: Readonly<Record<string, string>> = {
  dev:
    "Your deliverable is working application code that follows the plan and the contracts of the other roles. You own the glue: pages that call real endpoints, shared types, helpers. Do not leave a stub that returns fake data when a real implementation is possible.",
  design:
    "Your deliverable is the real screens the user will open. Every route and screen the spec names must exist as a page that renders, with loading, empty and error states. The generated starter page (src/app/page.tsx) and the starter title in layout.tsx are replaced by your work, and the home route sends the user to the right place (the login page, or the dashboard when signed in). Run the build: a page that does not build does not exist.",
  api:
    "Your deliverable is endpoints and server code that work and are safe: input validated with a schema, the signed-in user's role and ownership checked on the server for every call, one error shape, the right status codes (401 not signed in, 403 not allowed, 404 not found, 422 invalid input). Use the database client and the auth helper that already exist. Check each endpoint with typecheck and build, and with one real request when a server can run.",
  db:
    "Your deliverable is the schema, ONE shared database client, migrations and a seed script. Relations, indexes and constraints exactly as the spec says. Export the client from a single module (for example src/lib/db.ts) and give its path in your final message so the API and UI tasks import it. The seed creates the accounts the spec names, with hashed passwords. If no database is reachable, run validate and generate and report the migration as not applied.",
  infra:
    "Your deliverable is a skeleton that installs, typechecks and builds, made with the exact scaffold and install commands of your standards. You write no feature code. Your task ends at its gate: stop as soon as the commands pass, and report.",
  qa:
    "Your deliverable is evidence. Run typecheck, lint, tests and the build and report the real results. Check the security rules of the spec with real requests or tests (for example: a signed-in USER asking for another user's record gets 403 or 404). Write tests for requirements that have none. Report failures with the exact error and file; fix only trivial problems yourself.",
};

export function guidelinesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_GUIDELINES !== "0";
}

const cache = new Map<string, string>();

function read(rel: string): string {
  const hit = cache.get(rel);
  if (hit !== undefined) return hit;
  const text = readKnowledgeFile(rel);
  // A missing file is not cached: it may be added while the CLI runs, and the warning is printed once anyway.
  if (text) cache.set(rel, text);
  return text;
}

/** The guidelines block for one agent, or "" when they are switched off or the file is missing. */
export function operatingGuidelines(agentId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!guidelinesEnabled(env)) return "";
  const lite = LITE_GUIDELINE_AGENTS.has(agentId);
  const body = read(lite ? LITE_GUIDELINES_FILE : FULL_GUIDELINES_FILE);
  if (!body) return "";
  const focus = lite ? undefined : ROLE_FOCUS[agentId];
  return focus ? `${body}\n\n## Your role in this team\n${focus}` : body;
}
