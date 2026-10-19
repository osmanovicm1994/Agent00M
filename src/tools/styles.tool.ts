// src/tools/styles.tool.ts
//
// check_styles: read-only FACTS about whether a web app's styling pipeline is wired up, so a page cannot silently
// ship without any CSS. The agent cannot see a rendered page; this is the check that catches the commonest reason a
// generated UI looks like unstyled HTML: Tailwind installed but never processed (for example Tailwind 4 in Next.js
// without postcss.config.mjs, or a CSS file that does not import "tailwindcss", or CSS that no layout imports).
//
// Pure function of the files in the workspace: no commands, no network. Unit-tested in styles.test.ts.
// It never says "the UI looks good": it lists what is wrong and what it did not verify.

import * as fs from "fs";
import * as path from "path";
import type { ToolSchema } from "../llm/types";
import { appDirs, type CheckResult, type CheckLevel } from "./deploy.tool";

const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".agent", "out"]);
const MAX_CSS_BYTES = 300_000;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file: string): Record<string, any> | null {
  const t = readText(file);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function filesIn(dir: string, test: (name: string) => boolean): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && test(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** CSS files under src/, app/, styles/ and the app folder itself (depth 3), without build and dependency folders. */
function cssFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
      } else if (/\.css$/i.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(dir, 0);
  // Only look at folders where app styles live; ignore e.g. docs/ or a vendored sample.
  return out.filter((f) => /(^|[\\/])(src|app|styles|public)[\\/]|^[^\\/]+$/.test(path.relative(dir, f)));
}

export function tailwindMajor(spec: string | undefined): number | null {
  if (!spec) return null;
  const m = /(\d+)/.exec(spec);
  return m ? Number(m[1]) : null;
}

function postcssConfigText(dir: string, pkg: Record<string, any>): string | null {
  const files = filesIn(dir, (n) => /^(postcss\.config\.(js|mjs|cjs|ts|mts|cts)|\.postcssrc(\.(json|js|cjs|mjs|yml|yaml))?)$/.test(n));
  if (files.length) return files.map((f) => readText(f) ?? "").join("\n");
  if (pkg.postcss) return JSON.stringify(pkg.postcss);
  return null;
}

/** Root layout of a Next.js app (app router), or the main entry of a Vite app. */
function entryFile(dir: string, next: boolean): string | null {
  const candidates = next
    ? ["src/app/layout.tsx", "src/app/layout.jsx", "src/app/layout.js", "app/layout.tsx", "app/layout.jsx", "app/layout.js", "src/pages/_app.tsx", "pages/_app.tsx", "src/pages/_app.js", "pages/_app.js"]
    : ["src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js", "src/index.tsx", "src/index.jsx", "index.html"];
  for (const c of candidates) if (fs.existsSync(path.join(dir, c))) return path.join(dir, c);
  return null;
}

function builtCss(dir: string): string[] {
  const out: string[] = [];
  for (const sub of [".next/static/css", ".next/static/chunks", "dist/assets", "build/static/css"]) {
    out.push(...filesIn(path.join(dir, sub), (n) => /\.css$/i.test(n)));
  }
  return out;
}

export function checkStyling(root: string): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (level: CheckLevel, id: string, message: string) => out.push({ level, id, message });
  const rel = (f: string) => path.relative(root, f) || ".";

  let found = false;
  for (const dir of appDirs(root)) {
    const pkg = readJson(path.join(dir, "package.json"));
    if (!pkg) continue;
    const deps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (!deps.tailwindcss) continue;
    found = true;

    const label = rel(dir);
    const tag = (s: string) => `${label}: ${s}`;
    const next = Boolean(deps.next);
    const major = tailwindMajor(deps.tailwindcss);
    const v4 = major === 4 || (major === null && Boolean(deps["@tailwindcss/postcss"] || deps["@tailwindcss/vite"]));
    const css = cssFiles(dir).map((f) => ({ file: f, text: (readText(f) ?? "").slice(0, MAX_CSS_BYTES) }));
    const configFiles = filesIn(dir, (n) => /^tailwind\.config\.(js|cjs|mjs|ts|mts|cts)$/.test(n));
    const postcss = postcssConfigText(dir, pkg);

    if (v4) {
      const viaVite = Boolean(deps["@tailwindcss/vite"]);
      const viaPostcss = Boolean(deps["@tailwindcss/postcss"]);
      if (!viaVite && !viaPostcss && !deps["@tailwindcss/cli"]) {
        add("fail", "tw4-plugin", tag("Tailwind 4 is installed but neither @tailwindcss/postcss nor @tailwindcss/vite is. Without one of them no utility class is generated and the page is unstyled. Install @tailwindcss/postcss (Next.js) or @tailwindcss/vite (Vite)."));
      }
      if (viaPostcss || (next && !viaVite)) {
        if (postcss === null) {
          add("fail", "tw4-postcss-config", tag('there is no postcss config. Tailwind 4 needs postcss.config.mjs: export default { plugins: { "@tailwindcss/postcss": {} } }. Without it the CSS is never processed and the page is unstyled.'));
        } else if (!postcss.includes("@tailwindcss/postcss")) {
          add("fail", "tw4-postcss-config", tag('the postcss config does not use "@tailwindcss/postcss" (tailwindcss itself as a plugin is the v3 way and does not work in v4).'));
        } else {
          add("pass", "tw4-postcss-config", tag("postcss config uses @tailwindcss/postcss."));
        }
      }
      if (viaVite) {
        const vite = filesIn(dir, (n) => /^vite\.config\.(js|mjs|cjs|ts|mts)$/.test(n)).map((f) => readText(f) ?? "").join("\n");
        add(vite.includes("@tailwindcss/vite") ? "pass" : "fail", "tw4-vite-config", tag(vite.includes("@tailwindcss/vite") ? "vite.config uses @tailwindcss/vite." : "vite.config does not use the @tailwindcss/vite plugin."));
      }
      const entries = css.filter((c) => /@import\s+["']tailwindcss(\/[^"']*)?["']/.test(c.text));
      const v3Directive = css.filter((c) => /@tailwind\s+(base|components|utilities)\b/.test(c.text));
      if (v3Directive.length) add("fail", "tw4-v3-directives", tag(`${v3Directive.map((c) => rel(c.file)).join(", ")} uses @tailwind base/components/utilities, which is Tailwind 3 syntax. In Tailwind 4 use: @import "tailwindcss";`));
      if (entries.length === 0) {
        add("fail", "tw4-css-import", tag('no CSS file contains @import "tailwindcss";. Add it as the first line of the global stylesheet (for example src/app/globals.css).'));
      } else {
        add("pass", "tw4-css-import", tag(`${entries.map((c) => rel(c.file)).join(", ")} imports tailwindcss.`));
        linkCheck(dir, next, entries.map((c) => c.file), tag, add);
        if (configFiles.length && !entries.some((c) => /@config\b/.test(c.text))) {
          add("warn", "tw4-config-ignored", tag(`${configFiles.map(rel).join(", ")} is not read by Tailwind 4 unless the CSS has @config. Put colors, fonts and spacing in an @theme block in the CSS instead; do not rely on theme.extend.`));
        }
      }
    } else if (major === 3 || major === 2) {
      if (configFiles.length === 0) add("fail", "tw3-config", tag("tailwind.config.* is missing."));
      else {
        const text = configFiles.map((f) => readText(f) ?? "").join("\n");
        add(/content\s*:\s*\[\s*["'`]/.test(text) ? "pass" : "fail", "tw3-content", tag(/content\s*:\s*\[\s*["'`]/.test(text) ? "tailwind.config lists content paths." : "tailwind.config has no content paths: no class is generated."));
      }
      const entries = css.filter((c) => /@tailwind\s+(base|components|utilities)\b/.test(c.text));
      if (entries.length === 0) add("fail", "tw3-css-directives", tag("no CSS file contains @tailwind base; @tailwind components; @tailwind utilities;."));
      else {
        add("pass", "tw3-css-directives", tag(`${entries.map((c) => rel(c.file)).join(", ")} has the @tailwind directives.`));
        linkCheck(dir, next, entries.map((c) => c.file), tag, add);
      }
      if (next || deps.postcss) {
        add(postcss !== null && postcss.includes("tailwindcss") ? "pass" : "fail", "tw3-postcss-config", tag(postcss !== null && postcss.includes("tailwindcss") ? "postcss config lists tailwindcss." : "postcss config is missing or does not list tailwindcss: the CSS is not processed and the page is unstyled."));
      }
    } else {
      add("warn", "tw-version", tag(`cannot tell which Tailwind major is installed (tailwindcss: "${deps.tailwindcss}"). Read the version before writing config.`));
    }

    // Evidence from a real build, when one exists.
    const built = builtCss(dir);
    if (built.length) {
      const texts = built.map((f) => (readText(f) ?? "").slice(0, MAX_CSS_BYTES));
      const hasUtilities = texts.some((t) => /tailwindcss v\d|--tw-|\.(flex|grid|hidden|block)\b/.test(t));
      add(hasUtilities ? "pass" : "fail", "built-css", tag(hasUtilities ? "the last build's CSS contains Tailwind output." : `the last build's CSS (${built.map(rel).slice(0, 3).join(", ")}) has no Tailwind output: classes in the source were not turned into CSS.`));
    }
  }

  if (!found) add("warn", "tailwind", "No package.json with a tailwindcss dependency was found (root, app folders, apps/*). This check only knows Tailwind; for other styling methods read the global stylesheet and the layout yourself.");
  return out;
}

/** The layout/entry must import the stylesheet that holds the Tailwind import. */
function linkCheck(dir: string, next: boolean, entries: string[], tag: (s: string) => string, add: (l: CheckLevel, id: string, m: string) => void): void {
  const entry = entryFile(dir, next);
  if (!entry) {
    add("warn", "css-linked", tag(next ? "no app/layout.tsx or pages/_app found, so it is not known whether the global CSS is imported." : "no src/main.* found, so it is not known whether the global CSS is imported."));
    return;
  }
  const text = readText(entry) ?? "";
  const imported = entries.some((e) => {
    const base = path.basename(e);
    return new RegExp(`["'][^"']*${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(text);
  });
  add(imported ? "pass" : "fail", "css-linked", tag(imported ? `${path.basename(entry)} imports the global stylesheet.` : `${path.relative(dir, entry)} does not import ${entries.map((e) => path.basename(e)).join(" / ")}: the stylesheet is never loaded.`));
}

export function runStyleCheck(workspaceRoot: string): string {
  const results = checkStyling(workspaceRoot);
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  return [
    ...results.map((r) => `${r.level.toUpperCase().padEnd(4)} ${r.id}: ${r.message}`),
    "",
    `${fails} failed, ${warns} warning(s), ${results.filter((r) => r.level === "pass").length} passed.`,
    "NOT verified by this check: that the page looks right (layout, colours, spacing, images), that classes in your components are valid, or that the CSS loads in a browser. It only checks that the styling pipeline is configured. Run the build, then inspect_page or ask the user to look.",
  ].join("\n");
}

export const styleToolSchemas: ToolSchema[] = [
  {
    name: "check_styles",
    description:
      "Read-only facts about the web app's styling setup: Tailwind version, postcss config (Tailwind 4 needs @tailwindcss/postcss), whether a global stylesheet imports tailwindcss, whether the layout imports that stylesheet, ignored tailwind.config files, and whether the last build's CSS contains Tailwind output. " +
      "Run it after you create or change the global CSS, config or layout, and before you report a UI task as done. Fix every FAIL: a FAIL here means the page renders as unstyled HTML.",
    parameters: { type: "object", properties: {} },
  },
];
