// src/research/util.ts
//
// Small helpers shared by the research stage and the planner.

import { redactSecrets, type Redacted } from "../gateway/redact";
import { fingerprintToJson, probeWorkspace } from "../gateway/workspace-probe";

/** One line, at most `max` characters. */
export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const OUR_TAGS = /<\/?(user_query|workspace_fingerprint|available_tools|previous_turn|research_brief)>/gi;

/** Neutralise anything that could close or fake one of our tags inside pasted text. */
export function escapeTags(s: string): string {
  return s.replace(OUR_TAGS, (m) => m.replace("<", "< "));
}

/** The file-name overview of the project (no file contents, no .env), with secret-looking values masked. */
export function maskedFingerprint(workspaceRoot: string): Redacted {
  return redactSecrets(fingerprintToJson(probeWorkspace(workspaceRoot)));
}
