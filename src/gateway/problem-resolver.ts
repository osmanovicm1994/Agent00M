// src/gateway/problem-resolver.ts
//
// Outside help for a problem the local agent cannot get past. When the same failure comes back, or the agent keeps going in circles
// (see core/executor.ts), the executor asks this resolver for help. The steps:
//
//   1. COLLECT   the whole issue, not just the last error: the task, the failing command and its output, a per-file error digest,
//                the content of the files the errors name and of the files this run changed, the versions of the packages that
//                matter, the Prisma schema when it is involved, and the commands already tried.
//   2. REVIEW    locally, before anything leaves the machine: is the report complete? Missing pieces are added, secrets are masked.
//   3. APPROVE   the person sees exactly what would be sent (the executor asks; AGENT_RESOLVER_AUTO=1 skips the question).
//   4. SEND      to Gemini with a debugging brief; the answer goes back to the agent as advice and the run continues.
//
// Only the project's source files named above are included; secret files never are (.env*, keys). Nothing is sent without step 2.

import type { ProblemResolver, ResolverPrepared, ResolverRequest } from "../core/executor-hooks";
import { redactSecrets } from "./redact";
import { GeminiTriageClient } from "./gemini";

const DEFAULT_MAX_CHARS = 30_000;
const FILE_CHARS = 6_000;
const MAX_FILES = 8;
const OUTPUT_CHARS = 7_000;

const KEY_PACKAGES = [
  "next",
  "react",
  "react-dom",
  "typescript",
  "prisma",
  "@prisma/client",
  "@prisma/adapter-pg",
  "next-auth",
  "zod",
  "tailwindcss",
  "bcryptjs",
  "react-hook-form",
  "@hookform/resolvers",
  "vitest",
];

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const SECRET_FILE_RE = /(^|\/)(\.env(\.[\w.-]+)?|[^/]*\.(pem|key|p12|pfx)|id_rsa[^/]*|credentials[^/]*)$/i;

export const RESOLVER_SYSTEM =
  "You are a senior engineer called in to unblock a small local coding agent (a 30B model with a 32k context window) that is stuck in a loop on one problem. " +
  "You get a full report: the task, the failing command and its output, a per-file error summary, the files involved, package versions and what was already tried.\n" +
  "Answer in this structure and nothing else:\n" +
  "ROOT CAUSE: the real reason in 2-4 sentences. Many errors are consequences of one or two mistakes; name those, not the first line of the log.\n" +
  "FIX ORDER: numbered steps. Each step names ONE file. Give the complete corrected content of that file when it is shorter than about 80 lines, otherwise the exact block to replace. " +
  "Use only packages that appear in the given package.json and respect the given versions (Next, Prisma, Zod, next-auth have breaking changes between majors). " +
  "Use the enum values and field names of the given Prisma schema exactly.\n" +
  "DO NOT: the 2-4 things that would repeat the loop (for example rewriting a file that is not the cause, editing generated files, adding a second client or auth system).\n" +
  "VERIFY: the exact commands, in order, and what a pass looks like.\n" +
  "Be concrete and short (under 900 words). Do not ask questions: state any assumption in one line.";

/** Files named by compiler and bundler errors, in order of appearance, without generated output or node_modules. */
export function errorFiles(output: string, max = 6): string[] {
  const text = output.replace(ANSI_RE, "");
  const seen: string[] = [];
  const add = (f: string) => {
    const n = f.replace(/^\.\//, "").replace(/\\/g, "/");
    if (!n || /node_modules/.test(n) || /^\.next\//.test(n) || SECRET_FILE_RE.test(n)) return;
    if (!seen.includes(n)) seen.push(n);
  };
  for (const m of text.matchAll(/^(\S+?)\(\d+,\d+\):\s+error\s+TS\d+/gm)) add(m[1]);
  for (const m of text.matchAll(/^\.\/(\S+?):\d+:\d+\s*$/gm)) add(m[1]);
  return seen.slice(0, max);
}

/** "next 16.4.3, prisma 7.10.1, ..." from package.json (dependencies and devDependencies), only the packages that matter. */
export function packageVersions(packageJson: string | undefined): string[] {
  if (!packageJson) return [];
  try {
    const p = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>;
    const all = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) };
    return KEY_PACKAGES.filter((k) => all[k]).map((k) => `${k} ${all[k]}`);
  } catch {
    return [];
  }
}

function clipFile(text: string, max = FILE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} more characters not included]`;
}

function headAndTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  return `${text.slice(0, head)}\n[... ${text.length - max} characters cut from the middle ...]\n${text.slice(-(max - head))}`;
}

export interface CollectedFile {
  path: string;
  text: string;
}

export interface Collected {
  files: CollectedFile[];
  versions: string[];
  /** What the review had to add or change, for the person. */
  notes: string[];
}

/** Step 1 + the "add what is missing" half of step 2. */
export function collect(req: ResolverRequest): Collected {
  const notes: string[] = [];
  const output = req.output.replace(ANSI_RE, "");
  const wanted: string[] = [];
  const push = (p: string) => {
    if (p && !SECRET_FILE_RE.test(p) && !wanted.includes(p)) wanted.push(p);
  };

  for (const f of errorFiles(output)) push(f);
  for (const f of req.filesWritten.slice(-4)) push(f);
  if (/prisma|UserRole|@\/generated|enums\.js|PrismaClient/i.test(output) || wanted.some((f) => /prisma/i.test(f))) push("prisma/schema.prisma");
  if (/tsconfig|isolatedModules|allowImportingTsExtensions|module not found|cannot find module/i.test(output)) push("tsconfig.json");
  if (/next\.config|turbopack|Module not found/i.test(output)) push("next.config.ts");

  const files: CollectedFile[] = [];
  for (const rel of wanted) {
    if (files.length >= MAX_FILES) break;
    const text = req.readFile(rel);
    if (text === undefined) {
      if (errorFiles(output).includes(rel)) notes.push(`${rel} is named in the errors but could not be read: it may not exist (the report says so).`);
      continue;
    }
    files.push({ path: rel, text: clipFile(text) });
  }

  const versions = packageVersions(req.readFile("package.json"));
  if (!versions.length) notes.push("package.json could not be read: versions are missing from the report, so the advice may target the wrong major version.");
  if (!files.length) notes.push("No source file could be attached: the advice will be general.");
  if (!output.trim()) notes.push("The failing command printed no output.");
  return { files, versions, notes };
}

/** The report, as text. Section order puts the most useful things first so a cut at the size limit loses the least. */
export function buildDossier(req: ResolverRequest, c: Collected, maxChars = DEFAULT_MAX_CHARS): string {
  const out = req.output.replace(ANSI_RE, "");
  const parts: string[] = [];
  parts.push(`## Why you are asked\nTrigger: ${req.trigger}. The "${req.agentId}" agent could not get past this problem.`);
  parts.push(`## Task of the agent\n${clipFile(req.task, 2500)}`);
  if (req.command) parts.push(`## Failing command\n${req.command}`);
  if (c.versions.length) parts.push(`## Versions (package.json)\n${c.versions.join(", ")}`);
  if (req.errorDigest) parts.push(`## Errors by file\n${req.errorDigest}`);
  parts.push(`## Output of the last run (start and end)\n${headAndTail(out, OUTPUT_CHARS)}`);
  if (req.commandsRun.length) parts.push(`## Already tried (last commands of this run, oldest first)\n${req.commandsRun.slice(-15).join("\n")}`);
  if (req.filesWritten.length) parts.push(`## Files the agent changed in this run\n${req.filesWritten.join(", ")}`);

  let text = parts.join("\n\n");
  for (const f of c.files) {
    const block = `\n\n## File: ${f.path}\n${f.text}`;
    if (text.length + block.length > maxChars) {
      text += `\n\n## File: ${f.path}\n[left out: report size limit reached]`;
      continue;
    }
    text += block;
  }
  return text;
}

export interface Prepared {
  dossier: string;
  notes: string[];
  redactions: number;
  files: string[];
}

/** Steps 1-2: collect, review, mask. Pure: no network. */
export function prepareReport(req: ResolverRequest, maxChars = DEFAULT_MAX_CHARS): Prepared {
  const c = collect(req);
  const raw = buildDossier(req, c, maxChars);
  const { text, count } = redactSecrets(raw);
  const notes = [...c.notes];
  if (count > 0) notes.push(`${count} secret-looking value${count === 1 ? " was" : "s were"} masked before sending.`);
  return { dossier: text, notes, redactions: count, files: c.files.map((f) => f.path) };
}

export interface ResolverOptions {
  /** Test seam: anything with generateText. Default: the Gemini client (needs GEMINI_API_KEY). */
  client?: Pick<GeminiTriageClient, "generateText">;
  maxChars?: number;
  /** Most reports one process may send. Default AGENT_RESOLVER_MAX or 4. */
  maxPerSession?: number;
}

/** The resolver the executor uses, or undefined when help is switched off (AGENT_GEMINI_RESOLVER=0) or no key is set. */
export function createProblemResolver(opts: ResolverOptions = {}): ProblemResolver | undefined {
  if (process.env.AGENT_GEMINI_RESOLVER === "0") return undefined;
  if (!opts.client && !GeminiTriageClient.resolveApiKey()) return undefined;
  const maxPerSession = opts.maxPerSession ?? (Number(process.env.AGENT_RESOLVER_MAX) || 4);
  let sent = 0;
  let client = opts.client;

  return {
    async prepare(req: ResolverRequest): Promise<ResolverPrepared | null> {
      try {
        if (sent >= maxPerSession) return null;
        const report = prepareReport(req, opts.maxChars ?? (Number(process.env.AGENT_RESOLVER_CHARS) || DEFAULT_MAX_CHARS));
        const kb = Math.max(1, Math.round(report.dossier.length / 1024));
        const preview =
          `Gemini would receive this problem report (${kb} KB). Source files included: ${report.files.join(", ") || "none"}.\n` +
          (report.notes.length ? `Review: ${report.notes.join(" ")}\n` : "Review: the report is complete.\n") +
          `\n${report.dossier}`;
        return {
          preview,
          notes: report.notes,
          async send(): Promise<string> {
            client ??= new GeminiTriageClient();
            sent++;
            const { text, model } = await client.generateText(RESOLVER_SYSTEM, report.dossier, { maxTokens: 6000 });
            return `ADVICE FROM GEMINI (${model}). Follow the FIX ORDER step by step; do not repeat what DO NOT lists.\n\n${text.slice(0, 7000)}`;
          },
        };
      } catch {
        return null;
      }
    },
  };
}
