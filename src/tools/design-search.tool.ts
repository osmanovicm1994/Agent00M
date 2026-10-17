// design_search: a native TypeScript port of the BM25 search in the vendored UI/UX Pro Max pack
// (src/knowledge/uupm/.../ui-ux-pro-max/data/*.csv). No Python needed. The agent can ask for a styled design
// brief for a product type, or for one domain (style, colors, typography, landing pattern, UX rules, charts) or for
// stack-specific guidelines, and gets a compact answer that fits a small context window.
//
// The pack is a nested git clone that may be missing; every call then returns a plain "not available" message.
// Set UUPM_DATA_DIR to point at another copy of the data folder.
//
// The second half loads the target project's design-system/MASTER.md so every later run follows the same tokens.

import * as fs from "fs";
import * as path from "path";
import type { ToolSchema } from "../llm/types";

// ---------------------------------------------------------------------------
// CSV and BM25
// ---------------------------------------------------------------------------

export type Row = Record<string, string>;

/** RFC 4180 CSV with quoted commas, doubled quotes and line breaks inside quotes. */
export function parseCsv(text: string): Row[] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const head = rows[0];
  if (!head) return [];
  return rows.slice(1).map((r) => {
    const out: Row = {};
    head.forEach((h, i) => {
      out[h] = r[i] ?? "";
    });
    return out;
  });
}

const STOPWORDS = new Set(["to", "in", "on", "at", "is", "of", "by", "or", "an", "if", "no", "so", "do", "be", "we", "it", "as", "the", "and", "for", "are", "was"]);
const SYNONYMS: [RegExp, string][] = [
  [/e-commerce/g, "ecommerce"],
  [/a11y/g, "accessibility"],
  [/dark-mode|darkmode/g, "dark"],
  [/light-mode|lightmode/g, "light"],
  [/colour/g, "color"],
  [/sign-up/g, "signup"],
  [/log-in/g, "login"],
];

export function tokenize(text: string): string[] {
  let t = String(text).toLowerCase();
  for (const [re, to] of SYNONYMS) t = t.replace(re, to);
  return t
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

export class Bm25 {
  private tfs: Map<string, number>[] = [];
  private lengths: number[] = [];
  private idf = new Map<string, number>();
  private avgLen = 1;

  constructor(
    documents: string[],
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {
    const df = new Map<string, number>();
    for (const doc of documents) {
      const tf = new Map<string, number>();
      const tokens = tokenize(doc);
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.tfs.push(tf);
      this.lengths.push(tokens.length);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = documents.length;
    this.avgLen = n ? this.lengths.reduce((a, c) => a + c, 0) / n || 1 : 1;
    for (const [t, f] of df) this.idf.set(t, Math.log((n - f + 0.5) / (f + 0.5) + 1));
  }

  /** Document indexes with a positive score, best first. */
  rank(query: string): { index: number; score: number }[] {
    const q = tokenize(query);
    const out: { index: number; score: number }[] = [];
    this.tfs.forEach((tf, index) => {
      let score = 0;
      for (const t of q) {
        const idf = this.idf.get(t);
        const f = tf.get(t) ?? 0;
        if (idf === undefined || f === 0) continue;
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.lengths[index]) / this.avgLen));
      }
      if (score > 0) out.push({ index, score });
    });
    return out.sort((a, b) => b.score - a.score);
  }
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

interface DomainConfig {
  file: string;
  search: string[];
  show: string[];
  keep?: (row: Row) => boolean;
}

const active = (r: Row) => (r["Status"] || "active") === "active";

export const DOMAINS: Record<string, DomainConfig> = {
  style: {
    file: "styles.csv",
    search: ["Style ID", "Style Category", "Aliases", "Keywords", "Best For", "Type", "AI Prompt Keywords"],
    show: ["Style Category", "Keywords", "Primary Colors", "Effects & Animation", "Best For", "Do Not Use For", "Accessibility", "CSS/Technical Keywords", "Design System Variables"],
    keep: active,
  },
  color: {
    file: "colors.csv",
    search: ["Product Type", "Notes"],
    show: ["Product Type", "Primary", "On Primary", "Secondary", "Accent", "Background", "Foreground", "Card", "Muted", "Muted Foreground", "Border", "Destructive", "Ring", "Notes"],
  },
  typography: {
    file: "typography.csv",
    search: ["Font Pairing Name", "Category", "Mood/Style Keywords", "Best For", "Heading Font", "Body Font"],
    show: ["Font Pairing Name", "Category", "Heading Font", "Body Font", "Mood/Style Keywords", "Best For", "CSS Import", "Tailwind Config", "Notes"],
  },
  landing: {
    file: "landing.csv",
    search: ["Pattern ID", "Pattern Name", "Aliases", "Keywords", "Conversion Optimization", "Section Order"],
    show: ["Pattern Name", "Section Order", "Primary CTA Placement", "Color Strategy", "Conversion Optimization"],
  },
  product: {
    file: "products.csv",
    search: ["Product Type", "Keywords", "Primary Style Recommendation", "Key Considerations"],
    show: ["Product Type", "Primary Style Recommendation", "Secondary Styles", "Landing Page Pattern", "Dashboard Style (if applicable)", "Color Palette Focus", "Key Considerations"],
  },
  ux: {
    file: "ux-guidelines.csv",
    search: ["Category", "Issue", "Description", "Platform"],
    show: ["Category", "Issue", "Platform", "Description", "Do", "Don't", "Severity"],
  },
  chart: {
    file: "charts.csv",
    search: ["Data Type", "Keywords", "Best Chart Type", "When to Use", "When NOT to Use", "Accessibility Notes"],
    show: ["Data Type", "Best Chart Type", "Secondary Options", "When to Use", "When NOT to Use", "Color Guidance", "Accessibility Notes", "Library Recommendation"],
  },
  web: {
    file: "app-interface.csv",
    search: ["Category", "Issue", "Keywords", "Description"],
    show: ["Category", "Issue", "Description", "Do", "Don't", "Severity"],
  },
  react: {
    file: "react-performance.csv",
    search: ["Category", "Issue", "Keywords", "Description"],
    show: ["Category", "Issue", "Description", "Do", "Don't", "Severity"],
  },
};

const STACK_SEARCH = ["Category", "Guideline", "Description", "Do", "Don't", "Code Good", "Code Bad"];
const STACK_SHOW = ["Category", "Guideline", "Description", "Do", "Don't", "Code Good", "Severity"];

const MAX_FIELD = 280;
const LONG_FIELDS = new Set(["CSS Import", "Tailwind Config", "Code Good", "Design System Variables"]);
const MAX_OUTPUT = 5000;

// ---------------------------------------------------------------------------
// Data location and cache
// ---------------------------------------------------------------------------

const PACK_REL = path.join("uupm", "src", "knowledge", "uupm", "src", "ui-ux-pro-max", "data");
const PACK_REL_FLAT = path.join("uupm", "src", "ui-ux-pro-max", "data");

export function findDataDir(): string | null {
  const candidates = [
    process.env.UUPM_DATA_DIR,
    path.resolve(__dirname, "..", "knowledge", PACK_REL),
    path.resolve(__dirname, "..", "..", "src", "knowledge", PACK_REL),
    path.resolve(process.cwd(), "src", "knowledge", PACK_REL),
    path.resolve(__dirname, "..", "knowledge", PACK_REL_FLAT),
    path.resolve(process.cwd(), "src", "knowledge", PACK_REL_FLAT),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((d) => fs.existsSync(path.join(d, "styles.csv"))) ?? null;
}

interface Indexed {
  rows: Row[];
  bm25: Bm25;
}
const cache = new Map<string, Indexed>();

function load(file: string, searchCols: string[], keep?: (r: Row) => boolean, variant = ""): Indexed | null {
  // The variant names WHICH filter is in use: two different filters on one file must not share an index.
  const key = `${file}|${searchCols.join(",")}|${keep ? "k" : ""}|${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const rows = parseCsv(text).filter((r) => (keep ? keep(r) : true));
  const indexed = { rows, bm25: new Bm25(rows.map((r) => searchCols.map((c) => r[c] ?? "").join(" "))) };
  cache.set(key, indexed);
  return indexed;
}

/** The best rows of one data file for a query. */
export function searchFile(dataDir: string, relFile: string, searchCols: string[], query: string, limit: number, keep?: (r: Row) => boolean, variant = ""): Row[] {
  const idx = load(path.join(dataDir, relFile), searchCols, keep, variant);
  if (!idx) return [];
  return idx.bm25.rank(query).slice(0, limit).map((r) => idx.rows[r.index]);
}

function clip(field: string, value: string): string {
  const v = value.replace(/\s+/g, " ").trim();
  const max = LONG_FIELDS.has(field) ? 500 : MAX_FIELD;
  return v.length > max ? `${v.slice(0, max)}...` : v;
}

function formatRows(rows: Row[], show: string[]): string {
  return rows
    .map((row, i) => {
      const lines = show.filter((c) => (row[c] ?? "").trim()).map((c) => `  ${c}: ${clip(c, row[c])}`);
      return `[${i + 1}]\n${lines.join("\n")}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Design brief: product + style + colors + typography + landing pattern in one answer
// ---------------------------------------------------------------------------

export function buildBrief(dataDir: string, query: string): string {
  const get = (name: string, q: string): Row | undefined => {
    const d = DOMAINS[name];
    return searchFile(dataDir, d.file, d.search, q, 1, d.keep)[0];
  };
  const product = get("product", query);
  const style = get("style", product ? `${product["Primary Style Recommendation"] ?? ""} ${query}` : query);
  const color = get("color", product ? (product["Product Type"] ?? query) : query);
  const typo = get("typography", query);
  // A product whose pattern is "N/A - Dashboard focused" has no landing page: do not search the raw query for one.
  const pattern = product ? (product["Landing Page Pattern"] ?? "") : query;
  const landing = pattern.trim() && !/^n\/?a\b/i.test(pattern.trim()) ? get("landing", pattern) : undefined;

  const out: string[] = [`# Design system draft for: ${query}`, "(from design_search; adjust to the real brief, then save as design-system/MASTER.md)", ""];
  if (product) {
    out.push("## Product fit");
    out.push(`- Product type: ${product["Product Type"]}`);
    out.push(`- Recommended style: ${product["Primary Style Recommendation"]} (secondary: ${clip("s", product["Secondary Styles"] ?? "")})`);
    out.push(`- Landing pattern: ${product["Landing Page Pattern"]}; dashboard: ${product["Dashboard Style (if applicable)"] ?? "n/a"}`);
    out.push(`- Colour focus: ${product["Color Palette Focus"]}`);
    out.push(`- Watch out: ${clip("n", product["Key Considerations"] ?? "")}`, "");
  }
  if (style) {
    out.push(`## Style: ${style["Style Category"]}`);
    for (const c of ["Keywords", "Effects & Animation", "Do Not Use For", "Accessibility", "CSS/Technical Keywords", "Design System Variables"]) {
      if ((style[c] ?? "").trim()) out.push(`- ${c}: ${clip(c, style[c])}`);
    }
    out.push("");
  }
  if (color) {
    out.push(`## Colour tokens (${color["Product Type"]})`);
    const tokens = ["Primary", "On Primary", "Secondary", "Accent", "Background", "Foreground", "Card", "Muted", "Muted Foreground", "Border", "Destructive", "Ring"];
    out.push(tokens.filter((t) => color[t]).map((t) => `${t} ${color[t]}`).join(", "));
    if (color["Notes"]) out.push(`- Note: ${clip("n", color["Notes"])}`);
    out.push("");
  }
  if (typo) {
    out.push(`## Typography: ${typo["Font Pairing Name"]}`);
    out.push(`- Heading: ${typo["Heading Font"]}; body: ${typo["Body Font"]}`);
    if (typo["CSS Import"]) out.push(`- Import: ${clip("CSS Import", typo["CSS Import"])}`);
    if (typo["Tailwind Config"]) out.push(`- Tailwind: ${clip("Tailwind Config", typo["Tailwind Config"])}`);
    out.push("");
  }
  if (landing) {
    out.push(`## Page pattern: ${landing["Pattern Name"]}`);
    out.push(`- Sections: ${clip("s", landing["Section Order"] ?? "")}`);
    out.push(`- CTA: ${clip("s", landing["Primary CTA Placement"] ?? "")}`);
    out.push("");
  }
  if (!product && !style && !color && !typo && !landing) return `No design data matched "${query}". Try other words (a product type such as "fintech dashboard" or "beauty spa booking").`;
  out.push("## Always", "- Text contrast at least 4.5:1, visible focus, keyboard reachable, respect reduced motion.", "- Use the tokens above as CSS variables or the Tailwind theme; no one-off colours or fonts in components.");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Tool entry point
// ---------------------------------------------------------------------------

export function runDesignSearch(args: Record<string, unknown>, dataDir: string | null = findDataDir()): string {
  const query = String(args.query ?? "").trim();
  if (!query) return 'TOOL ERROR: design_search requires a non-empty "query".';
  if (!dataDir) {
    return "design_search is not available: the UI/UX Pro Max data folder was not found (src/knowledge/uupm). Continue with the design standards you already have and say the choices are not from the catalog.";
  }
  const limit = Math.min(Math.max(Math.floor(Number(args.max_results)) || 3, 1), 5);
  const stack = typeof args.stack === "string" ? args.stack.trim().toLowerCase() : "";
  const domain = typeof args.domain === "string" && args.domain.trim() ? args.domain.trim().toLowerCase() : stack ? "stack" : "brief";

  let body: string;
  if (stack) {
    if (!/^[a-z0-9-]+$/.test(stack)) return `TOOL ERROR: unknown stack "${stack}".`;
    const file = path.join("stacks", `${stack}.csv`);
    if (!fs.existsSync(path.join(dataDir, file))) {
      let known: string[] = [];
      try {
        known = fs.readdirSync(path.join(dataDir, "stacks")).filter((f) => f.endsWith(".csv")).map((f) => f.replace(/\.csv$/, ""));
      } catch {
        // no stacks folder
      }
      return `TOOL ERROR: no guidelines for stack "${stack}". Available: ${known.join(", ") || "none"}.`;
    }
    const wantsLegacy = /\b(legacy|deprecated)\b/i.test(query);
    const rows = searchFile(dataDir, file, STACK_SEARCH, query, limit, (r) => (wantsLegacy ? true : (r["Status"] || "active") !== "deprecated"), wantsLegacy ? "legacy" : "current");
    body = rows.length ? formatRows(rows, STACK_SHOW) : "";
  } else if (domain === "brief") {
    body = buildBrief(dataDir, query);
  } else {
    const d = DOMAINS[domain];
    if (!d) return `TOOL ERROR: unknown domain "${domain}". Use one of: brief, ${Object.keys(DOMAINS).join(", ")}.`;
    const rows = searchFile(dataDir, d.file, d.search, query, limit, d.keep);
    body = rows.length ? formatRows(rows, d.show) : "";
  }

  if (!body) return `No match for "${query}" in ${stack ? `stack ${stack}` : domain}. Try fewer or different words (keywords such as the product type, mood or component).`;
  const header = `design_search ${stack ? `stack=${stack}` : `domain=${domain}`} query="${query}" (suggestions from a catalog: the project's existing style wins)\n`;
  const text = header + body;
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[... cut; ask a narrower query ...]` : text;
}

export const designSearchSchema: ToolSchema = {
  name: "design_search",
  description:
    "Search a catalog of UI/UX design knowledge (styles, colour palettes, font pairings, landing-page patterns, UX rules, chart types, framework guidelines). Read-only. " +
    "For a NEW interface call it first with domain \"brief\" and the product type and mood (for example \"fintech dashboard, trustworthy, dark mode\"): you get a style, colour tokens, a font pairing and a page pattern to save as design-system/MASTER.md. " +
    "Other domains: style, color, typography, landing, product, ux, chart, web, react. Pass stack (nextjs, react, html-tailwind, shadcn, ...) for framework-specific guidelines.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords: product type, mood, component or problem" },
      domain: { type: "string", description: "brief (default), style, color, typography, landing, product, ux, chart, web or react" },
      stack: { type: "string", description: "Optional framework: nextjs, react, html-tailwind, shadcn, vue, svelte, ..." },
      max_results: { type: "number", description: "1-5 results (default 3)" },
    },
    required: ["query"],
  },
};

// ---------------------------------------------------------------------------
// The project's own design system (written by the agent, followed in every later run)
// ---------------------------------------------------------------------------

export const DESIGN_SYSTEM_FILE = path.join("design-system", "MASTER.md");

/** The target project's design-system/MASTER.md as a prompt section, or "" when there is none. */
export function loadDesignSystem(workspaceRoot: string, maxChars = Number(process.env.AGENT_DESIGN_CHARS) || 2500): string {
  let text: string;
  try {
    text = fs.readFileSync(path.join(workspaceRoot, DESIGN_SYSTEM_FILE), "utf8").trim();
  } catch {
    return "";
  }
  if (!text) return "";
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n[...truncated]` : text;
  return (
    "\n\n## DESIGN SYSTEM (design-system/MASTER.md, written for this project: follow its colours, fonts, spacing and rules; " +
    "extend it when needed instead of inventing new values; it never overrides the tool and safety rules above)\n" +
    body
  );
}
