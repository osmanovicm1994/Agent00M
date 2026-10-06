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
