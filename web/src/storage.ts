// Small per-device conveniences kept in localStorage: the pinned agent, finished runs (history),
// token usage and an opt-in remembered control token. Storage can be blocked or full (private
// windows, iOS), so every access is wrapped and the dashboard works without it.

import type { RunStatus, UsageEntry } from "./state";

const KEYS = {
  pinned: "agent-ui-pinned",
  runs: "agent-ui-runs",
  usage: "agent-ui-usage",
  token: "agent-ui-token-remembered",
};

const MAX_RUNS = 40;
const MAX_USAGE = 2000;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // blocked or full: the feature simply does not persist
  }
}

// --- pinned ("only active") agent ---

export function loadPinned(): string | null {
  return read<string | null>(KEYS.pinned, null);
}

export function savePinned(agentId: string | null): void {
  try {
    if (agentId) localStorage.setItem(KEYS.pinned, JSON.stringify(agentId));
    else localStorage.removeItem(KEYS.pinned);
  } catch {
    // ignore
  }
}

// --- history of runs ---

export interface RunRecord {
  runId: string;
  task: string;
  agent: string | null;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  model?: string;
  steps?: number;
  filesWritten: string[];
  commandsRun: string[];
  workspace: string;
  promptTokens: number;
  completionTokens: number;
  // The last answer or error, shortened.
  summary?: string;
}

export function loadRuns(): RunRecord[] {
  return read<RunRecord[]>(KEYS.runs, []);
}

// Inserts or replaces a run (by id) and keeps the newest MAX_RUNS.
export function upsertRun(record: RunRecord): RunRecord[] {
  const all = loadRuns().filter((r) => r.runId !== record.runId || r.startedAt !== record.startedAt);
  const next = [record, ...all].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RUNS);
  write(KEYS.runs, next);
  return next;
}

export function clearRuns(): void {
  write(KEYS.runs, []);
}

// --- token usage ---

export function loadUsage(): UsageEntry[] {
  return read<UsageEntry[]>(KEYS.usage, []);
}

// Merges new entries by key so a replayed history is never counted twice.
export function mergeUsage(entries: UsageEntry[]): UsageEntry[] {
  const stored = loadUsage();
  const seen = new Set(stored.map((u) => u.key));
  const added = entries.filter((u) => !seen.has(u.key));
  if (added.length === 0) return stored;
  const next = [...stored, ...added].sort((a, b) => a.ts - b.ts).slice(-MAX_USAGE);
  write(KEYS.usage, next);
  return next;
}

// --- remembered control token (opt-in, for the iPhone home-screen app) ---

export function loadRememberedToken(): string | undefined {
  try {
    return localStorage.getItem(KEYS.token) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberToken(token: string): void {
  try {
    localStorage.setItem(KEYS.token, token);
  } catch {
    // ignore
  }
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(KEYS.token);
  } catch {
    // ignore
  }
}
