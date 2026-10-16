// Pure helpers that turn a command's raw output into something a small model can act on, and that notice
// when the agent keeps hitting the same wall. No I/O, so everything here is unit-tested (run-feedback.test.ts).

/** After this many identical failures the agent is told to stop trying variations and report. */
export const REPEAT_LIMIT = 3;

/** Source files whose change should be followed by a check (typecheck, test, build). Docs and JSON are not. */
const CODE_FILE_RE = /\.(tsx?|jsx?|mjs|cjs|cs|py|swift|kt|kts|java|go|rs|prisma|sql|css|scss|vue|svelte)$/i;

export function isCodeFile(filePath: string): boolean {
  return CODE_FILE_RE.test(filePath);
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

const ERROR_LINE_RE =
  /\b(error|failed|failure|exception|fatal)\b|\bERR_[A-Z_]+|\bE(NOENT|ADDRINUSE|CONNREFUSED|ACCES)\b|\bTS\d{4}\b|\bCS\d{4}\b|^\s*(FAIL|×|✗|✖)/i;

/**
 * A short, stable fingerprint of a failure: the first line that looks like an error, with line numbers, paths and
 * timings removed so that "the same error again" gives the same text. Falls back to the last non-empty line.
 * Returns "" for empty output.
 */
export function errorSignature(output: string): string {
  const lines = output
    .replace(ANSI_RE, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const line = lines.find((l) => ERROR_LINE_RE.test(l)) ?? lines[lines.length - 1];
  return line
    .toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][^\s:'"()]+/g, "<path>") // file paths
    .replace(/(?<![a-z\d])\d+(?:\.\d+)?(?:ms|s)?/g, "#") // numbers, but keep codes such as ts2304
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

/** Counts how often each failure signature has been seen in one run. */
export class RepeatTracker {
  private counts = new Map<string, number>();

  /** Records one occurrence and returns how many times this signature has now been seen. */
  record(signature: string): number {
    if (!signature) return 0;
    const n = (this.counts.get(signature) ?? 0) + 1;
    this.counts.set(signature, n);
    return n;
  }
}

export function repeatNote(count: number): string {
  return (
    `The same failure has now happened ${count} times. Stop trying small variations of the same fix. ` +
    "Write down what the error says, what you already tried and your best theory, then either try ONE clearly different " +
    "approach (a different cause, not a different spelling) or give your final answer explaining where you are stuck."
  );
}

const FAILURE_LINE_RE =
  /(^\s*(FAIL|×|✗|✖)\b|\bAssertionError\b|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|\berror (TS|CS)\d+|\berror:|\bError:|\bException\b|\bfailed\b|Cannot find|\bECONNREFUSED\b|\bEADDRINUSE\b|\bERR_[A-Z_]+|\bexpected\b.*\b(received|to)\b)/i;

/**
 * The failing lines of a long test or build output, de-duplicated and capped, so the cause is not lost in the omitted
 * middle of a long log. Returns "" when nothing looks like a failure.
 */
export function summarizeFailures(output: string, maxLines = 20): string {
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const raw of output.replace(ANSI_RE, "").split("\n")) {
    const line = raw.trim();
    if (!line || !FAILURE_LINE_RE.test(line) || seen.has(line)) continue;
    seen.add(line);
    picked.push(line.length > 220 ? `${line.slice(0, 220)}...` : line);
    if (picked.length >= maxLines) break;
  }
  return picked.join("\n");
}
