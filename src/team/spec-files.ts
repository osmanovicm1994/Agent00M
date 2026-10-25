// src/team/spec-files.ts
//
// A request often points at files that sit next to the project: "@ugovorv1.md", "see context.md", "match ugovor-ep.jpg".
// Until now the planner, the UX designer and the engineers only saw the NAME of such a file in the request text, never its
// content. This module finds the files the request names, reads the text ones, and lists the pictures and documents that
// nobody has looked at, so that nobody pretends to have matched them.
//
// Pure file reading, no model calls. Everything is bounded: few folders, small files, a hard character budget.

import fs from "node:fs";
import path from "node:path";

const TEXT_EXT = new Set([".md", ".txt", ".json", ".csv", ".yaml", ".yml", ".sql", ".prisma", ".html"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const BINARY_DOC_EXT = new Set([".pdf", ".docx", ".xlsx"]);

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "tasks", "_archive", ".turbo", ".cache"]);
const MAX_DEPTH = 2;
const MAX_FILES_SCANNED = 800;
const MAX_FILE_BYTES = 80_000;
const MAX_FILE_CHARS = 7000;
const MAX_TOTAL_CHARS = 12_000;
const MAX_MISSING_SHOWN = 5;

// Names that mean "a file the project will have" and are not documents someone attached.
const IGNORED_NAMES = new Set(["readme.md", "claude.md", "agents.md", "package.json", "tsconfig.json", "package-lock.json", "tasks.json"]);

export interface SpecText {
  /** Path relative to the project root, with "/" separators. */
  file: string;
  text: string;
  truncated: boolean;
}

export interface SpecFiles {
  texts: SpecText[];
  /** Pictures the request names and that exist. Nobody has looked at them unless a vision brief was given. */
  images: string[];
  /** Documents the request names that cannot be read as text (pdf, docx, xlsx). */
  unreadable: string[];
  /** Files the request names (documents or pictures) that are not in the project folder. */
  missing: string[];
  /** Ready to paste into a prompt. Empty when there is nothing to say. */
  block: string;
}

const NAME_RE = /[A-Za-z0-9_][A-Za-z0-9_.\-]*\.(?:md|txt|csv|jpe?g|png|webp|gif|pdf|docx|xlsx)\b/gi;

/** File names (with extension) that the text mentions, in order, without duplicates. Folders in front of a name are dropped. */
export function namedFiles(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(NAME_RE)) {
    const name = m[0];
    const key = name.toLowerCase();
    if (seen.has(key) || IGNORED_NAMES.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

interface Found {
  rel: string;
  abs: string;
}

function scan(root: string): Found[] {
  const found: Found[] = [];
  let scanned = 0;
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned >= MAX_FILES_SCANNED) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(abs, depth + 1);
      } else if (e.isFile()) {
        scanned++;
        found.push({ rel: path.relative(root, abs).split(path.sep).join("/"), abs });
      }
    }
  };
  walk(root, 0);
  return found;
}

function clipText(s: string, n: number): { text: string; truncated: boolean } {
  const t = s.replace(/\r\n/g, "\n").trim();
  return t.length > n ? { text: `${t.slice(0, n)}\n…`, truncated: true } : { text: t, truncated: false };
}

/** The attached files the request names. `root` is the project folder; matching is by file name, case-insensitive. */
export function findSpecFiles(root: string, requestText: string): SpecFiles {
  const empty: SpecFiles = { texts: [], images: [], unreadable: [], missing: [], block: "" };
  const names = namedFiles(requestText);
  if (names.length === 0) return empty;

  const files = scan(root);
  const byName = new Map<string, Found>();
  for (const f of files) {
    const key = path.posix.basename(f.rel).toLowerCase();
    const old = byName.get(key);
    if (!old || f.rel.length < old.rel.length) byName.set(key, f); // the shallowest one wins
  }

  const result: SpecFiles = { texts: [], images: [], unreadable: [], missing: [], block: "" };
  let budget = MAX_TOTAL_CHARS;
  for (const name of names) {
    const hit = byName.get(name.toLowerCase());
    const ext = path.extname(name).toLowerCase();
    if (!hit) {
      result.missing.push(name);
      continue;
    }
    if (IMAGE_EXT.has(ext)) {
      result.images.push(hit.rel);
    } else if (BINARY_DOC_EXT.has(ext)) {
      result.unreadable.push(hit.rel);
    } else if (TEXT_EXT.has(ext)) {
      if (budget <= 0) continue;
      try {
        if (fs.statSync(hit.abs).size > MAX_FILE_BYTES) {
          result.unreadable.push(`${hit.rel} (too large to include)`);
          continue;
        }
        const clipped = clipText(fs.readFileSync(hit.abs, "utf8"), Math.min(MAX_FILE_CHARS, budget));
        budget -= clipped.text.length;
        result.texts.push({ file: hit.rel, text: clipped.text, truncated: clipped.truncated });
      } catch {
        result.unreadable.push(hit.rel);
      }
    }
  }

  result.block = formatSpecFiles(result);
  return result;
}

/** The text block handed to the planner, the UX designer and the engineers. Empty when there is nothing to say. */
export function formatSpecFiles(sf: Omit<SpecFiles, "block">): string {
  const parts: string[] = [];
  for (const t of sf.texts) {
    parts.push(`### ${t.file}${t.truncated ? " (shortened; read the file itself for the rest)" : ""}\n${t.text}`);
  }
  const lines: string[] = [];
  if (sf.images.length) {
    lines.push(
      `Pictures named in the request: ${sf.images.join(", ")}. NOBODY HAS LOOKED AT THEM (no picture description was given to this run). ` +
        "Do not claim a layout, text or number from a picture. Build from the written requirements and say \"not checked against the picture\" in your result.",
    );
  }
  if (sf.unreadable.length) lines.push(`Documents named in the request that could not be read: ${sf.unreadable.join(", ")}.`);
  if (sf.missing.length) {
    lines.push(
      `Files named in the request that are NOT in the project folder: ${sf.missing.slice(0, MAX_MISSING_SHOWN).join(", ")}. ` +
        "Do not guess their content; list them as open questions.",
    );
  }
  if (parts.length === 0 && lines.length === 0) return "";
  return [
    parts.length ? `## REFERENCED FILES (their real content, as named in the request)\n${parts.join("\n\n")}` : "",
    lines.length ? `## REFERENCE FILES NOT READ\n${lines.map((l) => `- ${l}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Short plain warnings for the console and the plan's assumptions. */
export function specWarnings(sf: SpecFiles): string[] {
  const w: string[] = [];
  if (sf.images.length) w.push(`not looked at: ${sf.images.join(", ")} (start the run with -i <picture>, or /image, to describe it)`);
  if (sf.unreadable.length) w.push(`cannot be read: ${sf.unreadable.join(", ")}`);
  if (sf.missing.length) w.push(`not in the project folder: ${sf.missing.slice(0, MAX_MISSING_SHOWN).join(", ")}`);
  return w;
}
