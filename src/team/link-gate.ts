// src/team/link-gate.ts
//
// "Every button leads to a 404." A run can report every task as done while the home page links to /listings, /login and /admin
// and none of those routes has a page. This gate reads the files on disk (no model call) and lists every internal link or
// navigation call whose target has no page or route handler in the Next.js App Router.
//
// Team mode uses it once after all tasks: one repair run by the frontend engineer, and an honest "not complete" in the report
// when dead links still stand afterwards.
//
// Pure file reading, no writes.

import * as fs from "fs";
import * as path from "path";
import { candidateAppDirs } from "./scaffold-gate";

export interface DeadLink {
  /** File that contains the link, relative to the workspace, forward slashes. */
  file: string;
  /** The link target as written, without query or hash (for example "/listings"). */
  target: string;
}

export interface LinkReport {
  dead: DeadLink[];
  /** Routes that exist, for the repair task ("/", "/api/listings/[id]"). */
  routes: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".git", "tasks", "coverage", "generated"]);
const SOURCE_RE = /\.(tsx|jsx|ts|js)$/i;
const TEST_RE = /\.(test|spec|integration)\.|\.test\.|\.spec\./i;
const PAGE_FILE_RE = /^(page|route)\.(tsx|jsx|ts|js|mdx)$/i;
const MAX_FILES = 600;

// href="/x", href={"/x"}, href: "/x" (navigation arrays), router.push("/x"), redirect("/x").
const LINK_RES: RegExp[] = [
  /\bhref\s*[:=]\s*\{?\s*["'`](\/[^"'`${}\s]*)["'`]/g,
  /\b(?:push|replace|redirect|permanentRedirect)\(\s*["'`](\/[^"'`${}\s]*)["'`]/g,
];

function readSmall(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").slice(0, 80_000);
  } catch {
    return "";
  }
}

export function usesNext(dir: string): boolean {
  try {
    const pkg = JSON.parse(readSmall(path.join(dir, "package.json")));
    return Boolean({ ...pkg.dependencies, ...pkg.devDependencies }.next);
  } catch {
    return false;
  }
}

/** The app router folder of a Next.js project, or null. */
export function appRouterDir(dir: string): string | null {
  for (const base of ["src/app", "app"]) {
    const p = path.join(dir, base);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return null;
}

/** URL segments of every page.* and route.* below the app router folder. Route groups (x) and slots @x do not appear in the URL. */
export function collectRoutes(appDir: string): string[][] {
  const routes: string[][] = [];
  const walk = (dir: string, segs: string[]): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && PAGE_FILE_RE.test(e.name))) routes.push(segs);
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith("_")) continue;
      if (e.name.startsWith("@")) continue; // parallel slot: not a URL segment
      const isGroup = /^\(.*\)$/.test(e.name);
      walk(path.join(dir, e.name), isGroup ? segs : [...segs, e.name]);
    }
  };
  walk(appDir, []);
  return routes;
}

function segmentsOf(target: string): string[] {
  return target.split("/").filter(Boolean);
}

/** Does a link target match a route, with [id], [...rest] and [[...rest]] segments? */
export function routeMatches(route: string[], target: string[]): boolean {
  let i = 0;
  for (let r = 0; r < route.length; r++) {
    const seg = route[r];
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) return true; // optional catch-all takes zero or more
    if (/^\[\.\.\.[^\]]+\]$/.test(seg)) return i < target.length; // catch-all takes one or more
    if (i >= target.length) return false;
    if (!/^\[[^\]]+\]$/.test(seg) && seg !== target[i]) return false;
    i++;
  }
  return i === target.length;
}

export function routeLabel(route: string[]): string {
  return `/${route.join("/")}`;
}

/** The link targets written in one source file. */
export function extractLinks(text: string): string[] {
  const out = new Set<string>();
  for (const re of LINK_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const target = m[1].split(/[?#]/)[0];
      if (!target || target.startsWith("//")) continue;
      if (/^\/(_next|favicon)/.test(target)) continue;
      if (/\.[a-z0-9]{2,5}$/i.test(target)) continue; // an asset such as /logo.svg
      out.add(target.length > 1 ? target.replace(/\/+$/, "") : target);
    }
  }
  return [...out];
}

function sourceFiles(dir: string, acc: string[]): string[] {
  if (acc.length >= MAX_FILES) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) sourceFiles(path.join(dir, e.name), acc);
    } else if (SOURCE_RE.test(e.name) && !TEST_RE.test(e.name)) {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

/** Internal links without a page or route in every Next.js app found under the workspace. */
export function findDeadLinks(root: string): LinkReport {
  const dead: DeadLink[] = [];
  const routeLabels = new Set<string>();
  const seen = new Set<string>();
  const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");

  for (const dir of candidateAppDirs(root)) {
    if (!usesNext(dir)) continue;
    const appDir = appRouterDir(dir);
    if (!appDir) continue;
    const routes = collectRoutes(appDir);
    routes.forEach((r) => routeLabels.add(routeLabel(r)));
    const srcRoot = path.dirname(appDir) === path.join(dir, "src") ? path.join(dir, "src") : appDir;

    for (const file of sourceFiles(srcRoot, [])) {
      for (const target of extractLinks(readSmall(file))) {
        const segs = segmentsOf(target);
        if (routes.some((r) => routeMatches(r, segs))) continue;
        if (fs.existsSync(path.join(dir, "public", target))) continue;
        const key = `${rel(file)}|${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dead.push({ file: rel(file), target });
      }
    }
  }
  return { dead, routes: [...routeLabels].sort() };
}

/** One line per dead link, for logs and for the report facts. */
export function describeDeadLinks(dead: readonly DeadLink[], limit = 8): string {
  const shown = dead.slice(0, limit).map((d) => `${d.file} -> ${d.target}`);
  return shown.join("; ") + (dead.length > limit ? `; and ${dead.length - limit} more` : "");
}

/** The task given to the frontend engineer for the one repair run. */
export function linkFixTask(report: LinkReport): string {
  const targets = [...new Set(report.dead.map((d) => d.target))];
  return [
    "The app contains links and navigation calls that lead to pages which do not exist, so the person clicks and gets a 404:",
    ...report.dead.slice(0, 20).map((d) => `- ${d.file} links to ${d.target}`),
    "",
    `Routes that exist now: ${report.routes.join(", ") || "(none)"}.`,
    "",
    "Fix it now, one target at a time:",
    `1. For each missing target (${targets.slice(0, 12).join(", ")}): if the request needs that screen, BUILD the real page (src/app/<route>/page.tsx) with its real content, wired to the API routes that exist. A placeholder that only says "coming soon" does not count.`,
    "2. If the request says the screen must not be linked from the public pages (for example an admin panel or the login for staff), keep the page but remove the link from public navigation. Say so in your final answer.",
    "3. Only link to routes that exist. Reuse the layout and the existing components.",
    "4. Run the typecheck and the build. Report the exact result.",
  ].join("\n");
}
