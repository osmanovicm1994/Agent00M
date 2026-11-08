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

  /** A successful check means the previous identical failure was resolved or is no longer current. */
  clear(): void {
    this.counts.clear();
  }
}

/** A concrete terminal report used when the executor stops an identical failure loop. */
export function repeatedFailureReport(command: string, output: string, count: number): string {
  const evidence = summarizeFailures(output, 8) || output.trim().split("\n").slice(-8).join("\n") || "No useful error output was captured.";
  return [
    "REPEATED FAILURE STOP",
    `Command: ${command}`,
    `Same failure observed: ${count} times`,
    "Failure evidence:",
    evidence,
    "Tried: the command was rerun without a verified fix; the CLI stopped further retries to prevent a loop.",
    "Next step: inspect the listed errors and affected files, make one root-cause change, then run this check once.",
  ].join("\n");
}

export function repeatNote(count: number): string {
  return (
    `The same failure has now happened ${count} times. Stop trying small variations of the same fix. ` +
    "Before the next attempt, search for the exact error text with the tool and version (web_search), or read the package's documentation or type definitions. " +
    "Write down what the error says, what you already tried and your best theory, then either try ONE clearly different " +
    "approach (a different cause, not a different spelling) or give your final answer explaining where you are stuck. " +
    "If the output lists several different errors, check whether they share one cause before fixing one line. " +
    "If you give up, use exactly this format so the user can unblock you:\n" +
    "STUCK REPORT\n" +
    "Command: <the failing command>\n" +
    "First error: <the first error line, copied exactly>\n" +
    "Tried: <each different thing you tried, one line each>\n" +
    "Missing: <the specific information you lack, for example a file's content, a version, a decision, a permission>\n" +
    "Next step for the user: <one concrete action>"
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

// ---------------------------------------------------------------------------
// Progress, masked checks and per-file error digests (added after a run that looped on one route.ts file)
// ---------------------------------------------------------------------------

const COMPILER_ERROR_LINE_RE = /\berror TS\d{4,5}\b|\berror CS\d{4}\b|^\s*Error: /;

/** Number of lines that report a compiler or build error. A smaller number than last time means progress, not a repeat. */
export function countErrorLines(output: string): number {
  let n = 0;
  for (const raw of output.replace(ANSI_RE, "").split("\n")) if (COMPILER_ERROR_LINE_RE.test(raw)) n++;
  return n;
}

/**
 * Like errorSignature, but also carries the number of error lines. A whole-project typecheck prints the same FIRST error for
 * many runs while the agent fixes other files; with the count in the signature, a falling count is not "the same failure again".
 */
export function progressSignature(output: string): string {
  const sig = errorSignature(output);
  return sig ? `${sig}|errors=${countErrorLines(output)}` : "";
}

const CHECK_WORD_RE = /\b(?:typecheck|tsc|lint|eslint|test|vitest|jest|build|prisma\s+(?:validate|generate|migrate))\b/;
const MASK_RE = /\|\s*(?:grep|head|tail|wc|tee|sed|awk|cut|sort|uniq)\b|\|\|\s*(?:echo|true|printf)\b|;\s*(?:echo|true)\b|\$\(|`/;

/**
 * True when a typecheck, lint, test or build is wrapped so that the exit code belongs to the wrapper (a pipe into grep/head/tail,
 * `|| echo`, `$(...)`), not to the check. `grep -i error || echo PASSED` exits 0 whatever the build did: that is how a QA run once
 * reported "all passed" over 15 type errors.
 */
export function isMaskedCheck(command: string): boolean {
  if (/\bpipefail\b/.test(command)) return false;
  return CHECK_WORD_RE.test(command) && MASK_RE.test(command);
}

const CHECK_FAILURE_RE =
  /\berror TS\d{4,5}\b|Build error occurred|Failed to compile|Turbopack build failed|\bnpm (?:ERR!|error)\b|ELIFECYCLE|^\s*(?:FAIL|✖|×)\b|\b\d+ failed\b|Tests?:\s+\d+ failed|Module not found/im;

/** True when the output of a check shows a real failure. Used for masked checks, whose exit code cannot be trusted. */
export function checkOutputFailed(output: string): boolean {
  return CHECK_FAILURE_RE.test(output.replace(ANSI_RE, ""));
}

export const MASKED_CHECK_NOTE =
  "The exit code of this command belongs to the pipe / `|| echo` / `$(...)` around the check, not to the check itself, so exit 0 proves nothing and it does NOT count as verification. " +
  "Run the check alone (`npm run typecheck`, `npm run build`, `npm test`) and read its own exit code. Never report PASSED from a grep of the output.";

const TS_ERROR_LINE_RE = /^(\S+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s*(.*)$/;

const sameFile = (a: string, b: string): boolean => {
  const x = a.replace(/^\.\//, "");
  const y = b.replace(/^\.\//, "");
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
};

/**
 * A short per-file summary of a typecheck with many errors: which files fail, the files this run changed first, the first error
 * of each file. A small model that sees 20 mixed errors fixes the wrong ones in a random order; this puts its own files on top.
 * Returns "" when there is nothing to sort out (fewer than 4 errors or only one file).
 */
export function digestTypeErrors(output: string, written: readonly string[] = [], maxFiles = 8): string {
  const byFile = new Map<string, { n: number; first: string }>();
  let total = 0;
  for (const raw of output.replace(ANSI_RE, "").split("\n")) {
    const m = TS_ERROR_LINE_RE.exec(raw.trim());
    if (!m) continue;
    total++;
    const msg = m[4].length > 140 ? `${m[4].slice(0, 140)}...` : m[4];
    const entry = byFile.get(m[1]);
    if (entry) entry.n++;
    else byFile.set(m[1], { n: 1, first: `${m[1]}:${m[2]} ${m[3]} ${msg}` });
  }
  if (total < 4 || byFile.size < 2) return "";

  const files = [...byFile.entries()];
  const generated = files.filter(([f]) => /(^|\/)\.next\//.test(f));
  const real = files.filter(([f]) => !/(^|\/)\.next\//.test(f));
  const mine = real.filter(([f]) => written.some((w) => sameFile(f, w))).sort((a, b) => b[1].n - a[1].n);
  const others = real.filter(([f]) => !written.some((w) => sameFile(f, w))).sort((a, b) => b[1].n - a[1].n);

  const lines = [`Typecheck: ${total} errors in ${byFile.size} files. Fix them file by file, not line by line.`];
  if (mine.length) lines.push(`Files YOU changed in this run (fix these first): ${mine.map(([f, v]) => `${f} (${v.n})`).join(", ")}`);
  if (others.length) lines.push(`Other files: ${others.slice(0, maxFiles).map(([f, v]) => `${f} (${v.n})`).join(", ")}`);
  if (generated.length) {
    lines.push(".next/types/* errors are generated by Next from the exports of your route and page files: fix the route/page file the message names, never edit .next.");
  }
  lines.push("First error per file:");
  for (const [, v] of [...mine, ...others].slice(0, maxFiles)) lines.push(` - ${v.first}`);
  return lines.join("\n");
}
