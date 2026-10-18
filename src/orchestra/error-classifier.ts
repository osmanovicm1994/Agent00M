// src/orchestra/error-classifier.ts
//
// Pure function: looks at a finished command (command line + combined output) and says whether it failed in a
// way the Debug Agent can usefully fix, and how urgent it is.
//
//  - immediate: the first occurrence already deserves a debug run (missing package, version conflict, Prisma schema error).
//  - escalated: noisy or often-transient failures (test failures, build errors). The primary agent gets a chance to fix
//    them itself; the debug run starts only after the same failure key was seen `escalateAfter` times.
//
// No I/O, no model calls, so it is cheap to run after every command and easy to test.

export type FailureKind =
  | "npm-404"
  | "npm-peer-conflict"
  | "npm-version-missing"
  | "module-not-found"
  | "prisma-schema"
  | "prisma-migration"
  | "prisma-client"
  | "typescript"
  | "build"
  | "test"
  | "port-in-use"
  | "permission"
  | "network"
  | "command-not-found";

export interface Failure {
  kind: FailureKind;
  /** Stable key: the same underlying problem gives the same key, so repeats can be counted and runs de-duplicated. */
  key: string;
  /** True: debug on first sight. False: wait until the failure repeats. */
  immediate: boolean;
  /** False when a code or manifest patch cannot help (network down, port taken, permission): report, don't debug. */
  fixable: boolean;
  /** The lines that actually show the problem (never the whole log). */
  evidence: string;
  /** One sentence that tells the Debug Agent where to look first. */
  hint: string;
}

interface Rule {
  kind: FailureKind;
  test: RegExp;
  immediate: boolean;
  fixable: boolean;
  hint: string;
  /** Extracts the part that identifies the problem (package name, error code...). */
  id?: (m: RegExpMatchArray) => string;
}

// Order matters: the first matching rule wins, so specific rules come before generic ones.
const RULES: Rule[] = [
  {
    kind: "npm-404",
    test: /npm (?:ERR!|error) (?:code E404|404)[\s\S]*?['"]?((?:@[\w.-]+\/)?[\w.-]+)@?[^\s'"]*['"]? is not in this registry|npm (?:ERR!|error) 404\s+(?:Not Found\s+-\s+GET\s+\S+\/)?((?:@[\w.-]+%2f)?[\w.-]+)/i,
    immediate: true,
    fixable: true,
    hint: "A package name or version in package.json does not exist on the registry. Check the exact name/version (npm view <pkg> versions) and correct package.json.",
    id: (m) => (m[1] || m[2] || "pkg").replace(/%2f/i, "/"),
  },
  {
    kind: "npm-version-missing",
    test: /npm (?:ERR!|error) code ETARGET[\s\S]*?No matching version found for ((?:@[\w.-]+\/)?[\w.-]+)@([^\s.]+[^\s]*)/i,
    immediate: true,
    fixable: true,
    hint: "The requested version does not exist. List real versions with npm view <pkg> versions and pin one that exists.",
    id: (m) => `${m[1]}@${m[2]}`,
  },
  {
    kind: "npm-peer-conflict",
    test: /npm (?:ERR!|error) code ERESOLVE|Could not resolve dependency:|peer dep(?:endency)? (?:missing|conflict)/i,
    immediate: true,
    fixable: true,
    hint: "Dependency versions conflict. Read the 'Found:' and 'Could not resolve dependency' lines, align the versions in package.json. Do not use --force or --legacy-peer-deps unless nothing else works, and say so.",
    id: (m) => "eresolve",
  },
  {
    kind: "prisma-schema",
    test: /Error validating[^\n]*|prisma:error[^\n]*schema|Prisma schema validation|P1012/i,
    immediate: true,
    fixable: true,
    hint: "prisma/schema.prisma is invalid. Read the error line numbers and fix the schema, then run npx prisma validate.",
    id: (m) => "schema",
  },
  {
    kind: "prisma-migration",
    test: /Error: P3\d{3}|Migration .* failed to apply|migrate (?:dev|deploy) .* failed|drift detected|failed migration/i,
    immediate: true,
    fixable: true,
    hint: "A Prisma migration failed. Read the P3xxx code. Never reset or drop a database without the user's approval; prefer fixing the schema and creating a new migration.",
    id: (m) => (/P3\d{3}/.exec(m[0]) ?? ["migration"])[0],
  },
  {
    kind: "prisma-client",
    test: /@prisma\/client did not initialize yet|Cannot find module '\.prisma\/client'|PrismaClient is not a constructor|Run [`']?prisma generate/i,
    immediate: true,
    fixable: true,
    hint: "The Prisma client is not generated. Run npx prisma generate (from the app folder that owns schema.prisma) and make sure @prisma/client is installed.",
    id: () => "client",
  },
  {
    kind: "module-not-found",
    test: /Cannot find module ['"]([^'"]+)['"]|Module not found: (?:Error: )?Can't resolve ['"]([^'"]+)['"]|ERR_MODULE_NOT_FOUND[\s\S]*?['"]([^'"]+)['"]/i,
    immediate: true,
    fixable: true,
    hint: "An import cannot be resolved. Either the package is not installed (install the right version in the right app folder) or the relative path/alias is wrong.",
    id: (m) => m[1] || m[2] || m[3] || "module",
  },
  {
    kind: "port-in-use",
    test: /EADDRINUSE[^\n]*?:(\d+)|address already in use[^\n]*?:(\d+)/i,
    immediate: false,
    fixable: false,
    hint: "A port is taken by another process. Not a code problem: use a different port or stop the other process (ask first).",
    id: (m) => m[1] || m[2] || "port",
  },
  {
    kind: "permission",
    test: /EACCES|EPERM|permission denied|not writable/i,
    immediate: false,
    fixable: false,
    hint: "Permission problem. Do not use sudo or global installs; use a local folder inside the project.",
    id: () => "perm",
  },
  {
    kind: "network",
    test: /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network request failed|getaddrinfo/i,
    immediate: false,
    fixable: false,
    hint: "Network or service unreachable. A code patch will not fix this; report it.",
    id: (m) => m[0],
  },
  {
    kind: "command-not-found",
    test: /(?:command not found|is not recognized as an internal or external command)/i,
    immediate: false,
    fixable: false,
    hint: "The tool is not installed. Use npx --yes <tool> or a local devDependency instead of a global install.",
    id: () => "cmd",
  },
  {
    kind: "typescript",
    test: /error TS(\d{4,5}):/,
    immediate: false,
    fixable: true,
    hint: "TypeScript errors. Fix the code at the reported file and line; do not silence with @ts-ignore or any.",
    id: (m) => `TS${m[1]}`,
  },
  {
    kind: "test",
    test: /(?:Tests?:\s+\d+ failed|FAIL\s+\S+|AssertionError|✗|× |\d+ failing)/,
    immediate: false,
    fixable: true,
    hint: "Tests fail. Read the first failing assertion, find the cause in the code, and fix the code, not the test (unless the test is wrong).",
    id: () => "tests",
  },
  {
    kind: "build",
    test: /(?:Failed to compile|Build error occurred|npm (?:ERR!|error) (?:code ELIFECYCLE|Lifecycle script)|error during build)/i,
    immediate: false,
    fixable: true,
    hint: "The build failed. Read the first error, not the last; fix that one and rebuild.",
    id: () => "build",
  },
];

const MAX_EVIDENCE = 1200;

/** Picks the lines around the first match that show the problem, capped so a huge log never reaches the model. */
function evidenceFrom(output: string, index: number): string {
  const lines = output.split("\n");
  let pos = 0;
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    if (pos + lines[i].length >= index) {
      at = i;
      break;
    }
    pos += lines[i].length + 1;
  }
  const slice = lines.slice(Math.max(0, at - 2), at + 10).join("\n");
  return slice.length > MAX_EVIDENCE ? slice.slice(0, MAX_EVIDENCE) + " ..." : slice;
}

/** First token of the command that identifies the tool, for the key ("npm install" and "npm i" both -> "npm"). */
function toolOf(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return first.replace(/^.*\//, "");
}

/**
 * Returns null when the command did not fail (exit 0) or the output matches nothing we can classify.
 * `exitCode` null/undefined means "unknown": the output is still checked, but only strong signatures count.
 */
export function classifyFailure(command: string, output: string, exitCode?: number | null): Failure | null {
  if (exitCode === 0) return null;
  if (!output) return null;
  for (const rule of RULES) {
    const m = rule.test.exec(output);
    if (!m) continue;
    // Without a known non-zero exit code, only accept the "immediate" signatures (they are specific enough).
    if ((exitCode === undefined || exitCode === null) && !rule.immediate) continue;
    const id = rule.id ? rule.id(m) : rule.kind;
    return {
      kind: rule.kind,
      key: `${rule.kind}:${toolOf(command)}:${id}`,
      immediate: rule.immediate,
      fixable: rule.fixable,
      evidence: evidenceFrom(output, m.index),
      hint: rule.hint,
    };
  }
  return null;
}
