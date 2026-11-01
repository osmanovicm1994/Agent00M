// src/team/spec-promises.ts
//
// What a long spec PROMISES, read by code instead of trusted to a small model.
//
// A real run got a 17 000-character build prompt, saw only its first 7 000 characters, planned 7 tasks, built one API route out of about
// twelve, never wrote the seed script, and the QA engineer then reported "all requirements satisfied" because typecheck and build passed
// on the little that existed. Three things follow from that, and this module does all three without a model call:
//
//  1. LAYOUT. "Single app at the repository root, do not create apps/web" was ignored (the scaffold went to apps/web). The layout the request
//     names is detected here and written into every role's context.
//  2. CHECKLIST. The file tree and the API endpoints in the spec are extracted and handed to the planner as a list that every task must cover.
//  3. PROMISE GATE. After the tasks, the same list is checked against the disk. What is missing is built in repair rounds, and what is still
//     missing makes the run "not complete" and keeps run.md unwritten.
//
// Pure file reading and text parsing. No writes.

import * as fs from "fs";
import * as path from "path";
import { candidateAppDirs } from "./scaffold-gate";
import { findSpecFiles } from "./spec-files";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type LayoutKind = "root" | "apps-web" | null;

const ROOT_RE = [
  /\bsingle app at (?:the )?(?:repo(?:sitory)?|project) root\b/i,
  /\bapp (?:lives |is |goes )?(?:at|in) (?:the )?(?:repo(?:sitory)?|project) root\b/i,
  /\b(?:do not|don'?t|never)\s+(?:create|use|add)\s+[`"']?apps\/web\b/i,
  /\bno [`"']?apps\/web\b/i,
  /\bat the (?:repo(?:sitory)?|project) root\b/i,
];
const APPS_WEB_RE = /\b(?:in|under|at|inside)\s+[`"']?apps\/web\b/i;

/** The layout the request names explicitly, or null when it names none. */
export function detectLayout(text: string): LayoutKind {
  if (ROOT_RE.some((re) => re.test(text))) return "root";
  if (APPS_WEB_RE.test(text)) return "apps-web";
  return null;
}

/** The paragraph every role gets, so the scaffold and every path agree. Empty when the request names no layout. */
export function layoutBlock(kind: LayoutKind): string {
  if (kind === "root") {
    return [
      "## PROJECT LAYOUT (read from the request; it overrides every default)",
      "The application lives at the REPOSITORY ROOT: package.json, src/, prisma/ and public/ sit directly in the project folder. Do NOT create apps/web, apps/api or any second app folder, and never write a path that starts with apps/.",
      'Scaffold in the project folder itself: npx --yes create-next-app@16 . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --disable-git --yes. If it refuses because the folder is not empty (the request\'s .md files), scaffold into a temporary folder, move its files up WITHOUT overwriting existing files, then delete the temporary folder.',
      "Run every command in the project folder (npm run build, npx prisma generate): no `cd apps/web`, no `--prefix apps/web`. Every path in your instructions and in your acceptance checks is relative to the project root (src/app/..., prisma/..., src/lib/...).",
    ].join("\n");
  }
  if (kind === "apps-web") {
    return [
      "## PROJECT LAYOUT (read from the request; it overrides every default)",
      "The application lives in apps/web (package.json, src/, prisma/ inside it). Run commands in that folder and write every path relative to it.",
    ].join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Reading the spec
// ---------------------------------------------------------------------------

/** The request plus the COMPLETE text of every file it names (spec-files.ts shortens them for the prompt; promises need all of it). */
export function fullSpecText(root: string, requestText: string): string {
  const parts = [requestText];
  try {
    for (const t of findSpecFiles(root, requestText).texts) {
      try {
        const file = path.join(root, t.file);
        if (fs.statSync(file).size <= 200_000) parts.push(fs.readFileSync(file, "utf8"));
      } catch {
        parts.push(t.text);
      }
    }
  } catch {
    // no spec files: the request alone
  }
  return parts.join("\n\n");
}

export interface Promises {
  /** File paths the spec's tree lists, relative to the app folder (src/app/admin/page.tsx). */
  files: string[];
  /** Folders the tree lists with nothing under them (components/customer/). */
  dirs: string[];
  /** "GET /api/services" style lines. */
  endpoints: string[];
}

/** One level of {a,b,c} expansion: "auth/{login,logout}/route.ts" gives two paths. */
export function expandBraces(token: string): string[] {
  const m = /\{([^{}]*)\}/.exec(token);
  if (!m) return [token];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((alt) => expandBraces(token.slice(0, m.index) + alt + token.slice(m.index + m[0].length)));
}

const FILE_EXT_RE = /\.[A-Za-z0-9]+$/;
const TREE_TOKEN_RE = /^[A-Za-z0-9_@.\-()[\]{},/]+$/;

function parseTree(block: string, files: Set<string>, parents: Map<string, boolean>): void {
  const stack: Array<{ indent: number; path: string }> = [];
  for (const raw of block.split("\n")) {
    if (!raw.trim()) continue;
    const line = raw.replace(/\t/g, "  ");
    const indent = line.length - line.trimStart().length;
    const token = line.trim().replace(/\s+(#|\/\/).*$/, "").trim();
    if (!token || /\s/.test(token) || !TREE_TOKEN_RE.test(token)) continue;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const base = stack.length ? stack[stack.length - 1].path : "";
    const isDir = token.endsWith("/");
    const expanded = expandBraces(token);
    for (const t of expanded) {
      const rel = path.posix.join(base, t.replace(/\/$/, ""));
      if (!rel || rel === ".") continue;
      // Every folder on the way now has a child.
      const segs = rel.split("/");
      for (let i = 1; i < segs.length; i++) parents.set(segs.slice(0, i).join("/"), true);
      if (isDir) {
        if (!parents.has(rel)) parents.set(rel, false);
      } else if (FILE_EXT_RE.test(segs[segs.length - 1])) {
        files.add(rel);
      }
    }
    if (isDir && expanded.length === 1) stack.push({ indent, path: path.posix.join(base, token.replace(/\/$/, "")) });
  }
}

const ENDPOINT_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+[`"']?(\/api\/[A-Za-z0-9_\-/[\]:{}]*)/g;

/** The files, empty folders and API endpoints a spec lists. Only fenced blocks that look like a project tree are read as trees. */
export function extractPromises(text: string): Promises {
  const files = new Set<string>();
  const parents = new Map<string, boolean>();
  for (const m of text.matchAll(/```[A-Za-z]*\n([\s\S]*?)```/g)) {
    const block = m[1];
    if (/(?:page|route|layout)\.tsx?|schema\.prisma|seed\.ts/.test(block) && /\/\s*(?:#.*)?$/m.test(block)) parseTree(block, files, parents);
  }
  const endpoints = new Set<string>();
  for (const m of text.matchAll(ENDPOINT_RE)) endpoints.add(`${m[1]} ${m[2].replace(/\/+$/, "")}`);
  return {
    files: [...files].sort(),
    dirs: [...parents.entries()].filter(([, hasChild]) => !hasChild).map(([p]) => `${p}/`).sort(),
    endpoints: [...endpoints].sort(),
  };
}

/** The block the planner sees. Empty when the spec lists nothing checkable. */
export function checklistBlock(p: Promises): string {
  if (p.files.length === 0 && p.endpoints.length === 0) return "";
  const lines: string[] = [
    "These items were extracted by code from the request and its files. Every one must be built by some task: put the paths into that task's instructions. If the list is long, plan MORE tasks (up to 9), one area each (for example: auth API, bookings API, public/admin API, customer pages, admin pages, seed and environment, docs). A path in this list that no task mentions is a mistake in your plan.",
  ];
  if (p.files.length) lines.push(`FILES (${p.files.length}):`, ...p.files.slice(0, 80).map((f) => `- ${f}`), ...(p.files.length > 80 ? [`- … and ${p.files.length - 80} more`] : []));
  if (p.dirs.length) lines.push(`FOLDERS with content (${p.dirs.length}): ${p.dirs.slice(0, 30).join(", ")}`);
  if (p.endpoints.length) lines.push(`API ENDPOINTS (${p.endpoints.length}):`, ...p.endpoints.slice(0, 40).map((e) => `- ${e}`));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const CODE_EXT = ["ts", "tsx", "js", "jsx", "mjs"];

function appRoots(root: string, layout: LayoutKind): string[] {
  if (layout === "root") return [root];
  if (layout === "apps-web") return [path.join(root, "apps", "web")];
  return candidateAppDirs(root);
}

function fileExists(base: string, rel: string): boolean {
  const abs = path.join(base, rel);
  if (fs.existsSync(abs)) return true;
  const m = /^(.*)\.(ts|tsx|js|jsx|mjs)$/.exec(rel);
  return Boolean(m) && CODE_EXT.some((e) => fs.existsSync(path.join(base, `${m![1]}.${e}`)));
}

function dirHasContent(base: string, rel: string): boolean {
  try {
    return fs.readdirSync(path.join(base, rel)).length > 0;
  } catch {
    return false;
  }
}

const isDynamic = (seg: string): boolean => /^[:{[]/.test(seg);

function routeExists(base: string, endpointPath: string): boolean {
  const segs = endpointPath.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  let trailingDynamic = false;
  while (segs.length && isDynamic(segs[segs.length - 1])) {
    segs.pop(); // /x/:id is served by x/route.ts or x/[id]/route.ts
    trailingDynamic = true;
  }
  for (const apiRoot of ["src/app/api", "app/api"]) {
    let dir = path.join(base, apiRoot);
    let ok = fs.existsSync(dir);
    for (const seg of segs) {
      if (!ok) break;
      let next: string | null = null;
      try {
        const names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
        next = isDynamic(seg) ? names.find((n) => n.startsWith("[")) ?? null : names.includes(seg) ? seg : null;
      } catch {
        next = null;
      }
      if (next === null) ok = false;
      else dir = path.join(dir, next);
    }
    if (!ok) continue;
    if (CODE_EXT.some((e) => fs.existsSync(path.join(dir, `route.${e}`)))) return true;
    if (trailingDynamic) {
      try {
        const dynamicDirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("["));
        if (dynamicDirs.some((d) => CODE_EXT.some((e) => fs.existsSync(path.join(dir, d.name, `route.${e}`))))) return true;
      } catch {
        // not readable: not found
      }
    }
  }
  return false;
}

/** What the spec promises and the disk does not have, one short label per item. Never throws. */
export function missingPromises(root: string, p: Promises, layout: LayoutKind): string[] {
  const bases = appRoots(root, layout);
  const missing: string[] = [];
  for (const f of p.files) if (!bases.some((b) => fileExists(b, f))) missing.push(`file ${f}`);
  for (const d of p.dirs) if (!bases.some((b) => dirHasContent(b, d))) missing.push(`folder ${d}`);
  for (const e of p.endpoints) {
    const [method, ep] = e.split(" ");
    if (!bases.some((b) => routeExists(b, ep))) missing.push(`endpoint ${method} ${ep}`);
  }
  return missing;
}

/** Layout violation: the request says "repository root" but the app was scaffolded under apps/. */
export function layoutViolation(root: string, layout: LayoutKind): string | null {
  if (layout !== "root") return null;
  try {
    const appsWeb = path.join(root, "apps", "web");
    if (fs.existsSync(path.join(appsWeb, "package.json")) && !fs.existsSync(path.join(root, "package.json"))) {
      return "the request says the app lives at the repository root, but it was scaffolded in apps/web";
    }
  } catch {
    // nothing to report
  }
  return null;
}

/** The task for one repair round: the most important missing items first. */
export function promiseFixTask(missing: readonly string[], layout: LayoutKind, round: number, limit = 14): string {
  const batch = missing.slice(0, limit);
  return [
    `The request describes files and API endpoints that do not exist yet (${missing.length} missing). Repair round ${round}: build these now, in this order:`,
    ...batch.map((m) => `- ${m}`),
    missing.length > batch.length ? `(${missing.length - batch.length} more follow in the next round.)` : "",
    "",
    "How:",
    "1. Read the spec files the request names (BARBERSHOP_*.md or similar) for the exact contract of each item: request, response, status codes, auth rule. Read the files already in the project before you change them, and reuse what exists (auth guards, db client, validation helpers).",
    "2. Write each file in full with write_file, one file per call, real working code (no TODO, no placeholder responses). A route handler calls the shared service function in src/lib; it does not hold the business logic itself.",
    `3. ${layout === "root" ? "All paths are relative to the repository root (src/app/..., prisma/...). Do not create apps/web." : "Use the project's real folders."}`,
    "4. After every few files run npm run typecheck and fix the first error before you continue. Finish by saying exactly which of the listed items now exist.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
