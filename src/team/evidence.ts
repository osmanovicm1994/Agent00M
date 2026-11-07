// src/team/evidence.ts
//
// A team task used to count as "done" when the model simply stopped calling tools. For a role whose job is to BUILD
// something (dev, api, db, design) that is not proof: a run that wrote no file delivered nothing, however confident
// its last message sounds. These helpers turn that into a plain rule. Pure, no model calls.
//
// infra, debug, qa and the reviewers are not in the list on purpose: their evidence is a command that ran or a verdict,
// not a file.

import type { TaskStatus } from "./orchestrator";

const BUILDER_ROLES = new Set(["dev", "api", "db", "design"]);

/** True for roles that must leave files behind to count as done. */
export function mustWriteFiles(role: string): boolean {
  return BUILDER_ROLES.has(role);
}

/** True when a finished run of this role has no evidence of work. */
export function lacksEvidence(role: string, filesWritten: readonly string[]): boolean {
  return mustWriteFiles(role) && filesWritten.length === 0;
}

/** "done" without evidence becomes "incomplete"; every other status stays as it is. */
export function applyEvidence(role: string, status: TaskStatus, filesWritten: readonly string[]): TaskStatus {
  return status === "done" && lacksEvidence(role, filesWritten) ? "incomplete" : status;
}

/** Whole-run verdict: every task done, not stopped, and the safety review did not fail or stay undecided. */
export function isComplete(input: {
  statuses: readonly TaskStatus[];
  interrupted: boolean;
  safety: "PASS" | "FAIL" | "UNKNOWN" | "NOT_RUN";
}): boolean {
  return !input.interrupted && input.statuses.length > 0 && input.statuses.every((s) => s === "done") && (input.safety === "PASS" || input.safety === "NOT_RUN");
}

/** Added to the assignment for the one retry of a builder task that wrote nothing. */
export const NO_FILES_NUDGE =
  "RETRY: your previous attempt ended without writing any file, so nothing was delivered. Create the files this task asks for now with write_file. Do not describe what you would do; do it, then run the check from the acceptance criteria.";
