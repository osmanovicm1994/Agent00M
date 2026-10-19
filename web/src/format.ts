// "3.2s" / "1m 07s" between two epoch-millisecond timestamps.
export function elapsed(from: number, to: number): string {
  const seconds = Math.max(0, to - from) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

// Pulls the interesting bit (the command or the file path) out of a tool call's raw JSON
// arguments. The server truncates long arguments, so this uses a regex instead of JSON.parse.
export function summarizeArgs(args: string): string {
  const m = /"(command|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args);
  if (!m) return args;
  try {
    return JSON.parse(`"${m[2]}"`) as string;
  } catch {
    return m[2];
  }
}

function unescapeJson(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

export interface ParsedArgs {
  command?: string;
  reason?: string;
  path?: string;
  // Everything else, as compact text (empty when nothing is left).
  rest: string;
}

// Reads a tool call's JSON arguments. The server may have cut them off, so a regex fallback pulls out
// the command, reason and path when JSON.parse fails.
export function parseArgs(args: string): ParsedArgs {
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    const { command, reason, path, ...others } = obj;
    const rest = Object.keys(others).length ? JSON.stringify(others) : "";
    return {
      command: typeof command === "string" ? command : undefined,
      reason: typeof reason === "string" ? reason : undefined,
      path: typeof path === "string" ? path : undefined,
      rest,
    };
  } catch {
    const pick = (key: string): string | undefined => {
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(args);
      return m ? unescapeJson(m[1]) : undefined;
    };
    return { command: pick("command"), reason: pick("reason"), path: pick("path"), rest: "" };
  }
}

// Exit code of a run_command result (its preview is the JSON the agent got back), or undefined.
export function exitCodeOf(preview: string): number | null | undefined {
  const m = /"exitCode":(-?\d+|null)/.exec(preview);
  if (!m) return undefined;
  return m[1] === "null" ? null : Number(m[1]);
}

// 1234 -> "1.2K", 1_500_000 -> "1.5M"
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

// "just now", "5 min ago", "3 h ago", "2 d ago"
export function ago(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, now - ts) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

// Start of the local day for a timestamp.
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
