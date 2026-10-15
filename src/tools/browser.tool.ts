// src/tools/browser.tool.ts
//
// inspect_page: lets a text-only coding model "look" at the interface it built. It renders a page in headless
// Chromium (Playwright, already a dependency) and returns FACTS as text: HTTP status, console and page errors,
// failed requests, horizontal overflow at phone and desktop widths, document structure (title, lang, headings,
// landmarks) and accessibility problems (controls without a name, inputs without a label, images without alt).
//
// What it cannot do: judge beauty or pixel accuracy. The model still reports those as "Not verified".
//
// Scope and safety:
//  - read-only: it only loads a page, it never clicks, types or submits;
//  - only the user's OWN pages: http(s)://localhost, 127.0.0.1 or [::1], or an .html file inside the workspace;
//  - it does not start a server. If nothing listens, it says so and the agent asks the user to start the dev server;
//  - Chromium must be installed once: npx playwright install chromium.

import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type { ToolSchema } from "../llm/types";

export const browserToolSchemas: ToolSchema[] = [
  {
    name: "inspect_page",
    description:
      "Render a page in headless Chromium and report facts: HTTP status, console/page errors, failed requests, horizontal overflow at phone and desktop widths, headings, landmarks and accessibility problems. " +
      "Only for the user's own pages: a localhost URL of a running dev server, or an .html file inside the project. Does not start a server and cannot judge visual design.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "http://localhost:PORT/path of a dev server that is already running" },
        path: { type: "string", description: "Alternative to url: an .html file inside the project (static sites)" },
        widths: { type: "array", items: { type: "number" }, description: "Viewport widths in px to test (default 375 and 1280, max 3)" },
        wait_ms: { type: "number", description: "Extra wait after load for client-side rendering (default 800, max 5000)" },
        screenshot: { type: "boolean", description: "Also save PNG screenshots for the human to open (the model cannot read them). Default false." },
      },
    },
  },
];

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MAX_REPORT_CHARS = 6000;

/** Decides which page may be opened. Pure: no browser, so it is unit-tested. */
export function resolveInspectTarget(
  args: Record<string, any>,
  workspaceRoot: string,
): { url: string; error?: undefined } | { url?: undefined; error: string } {
  if (typeof args.url === "string" && args.url.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(args.url.trim());
    } catch {
      return { error: `TOOL ERROR: "${args.url}" is not a valid URL. Use http://localhost:PORT/path.` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "TOOL ERROR: only http(s) URLs on localhost can be inspected." };
    }
    if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
      return { error: `TOOL ERROR: ${parsed.hostname} is not allowed. inspect_page only opens the user's own pages on localhost, 127.0.0.1 or [::1]. Use web_fetch for public sites.` };
    }
    return { url: parsed.toString() };
  }

  if (typeof args.path === "string" && args.path.trim()) {
    const root = path.resolve(workspaceRoot);
    const full = path.resolve(root, args.path.trim());
    const rel = path.relative(root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return { error: "TOOL ERROR: that path is outside the workspace." };
    if (!/\.html?$/i.test(full)) return { error: "TOOL ERROR: path must be an .html file. For a framework app give the dev server URL instead." };
    if (!fs.existsSync(full)) return { error: `TOOL ERROR: file not found: ${args.path}` };
    return { url: pathToFileURL(full).toString() };
  }

  return { error: 'TOOL ERROR: inspect_page needs "url" (a localhost dev server) or "path" (an .html file in the project).' };
}

function cleanWidths(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isFinite(n) && n >= 200 && n <= 3840) : [];
  return (list.length ? list : [375, 1280]).slice(0, 3).map(Math.round);
}

interface PageFacts {
  title: string;
  lang: string;
  h1Count: number;
  headings: string[];
  landmarks: Record<string, number>;
  unnamedButtons: string[];
  unnamedLinks: string[];
  unlabeledInputs: string[];
  imagesWithoutAlt: string[];
  interactive: number;
  textSample: string;
  overflow: string[];
}

// Runs inside the page. Must be self-contained (no references to outer variables).
function collectFacts(): PageFacts {
  const d = document;
  const desc = (el: Element): string => {
    const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : "";
    const cls = typeof (el as HTMLElement).className === "string" && (el as HTMLElement).className.trim() ? `.${(el as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const labelledBy = (el: Element) =>
    (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => (id ? text(d.getElementById(id) ?? el) : ""))
      .join("")
      .trim();
  const hasName = (el: Element) =>
    Boolean(el.getAttribute("aria-label")?.trim() || labelledBy(el) || text(el) || el.getAttribute("title")?.trim() || el.querySelector("img[alt]:not([alt=''])"));
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const first = (arr: string[], n = 6) => arr.slice(0, n);

  const all = (sel: string): Element[] => Array.from(d.querySelectorAll(sel));
  const buttons = all("button, [role='button']").filter(visible);
  const links = all("a[href]").filter(visible);
  const inputs = all("input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea").filter(visible);
  const labelled = (el: Element) => {
    const id = (el as HTMLElement).id;
    return Boolean(
      el.getAttribute("aria-label")?.trim() ||
        labelledBy(el) ||
        (id && d.querySelector(`label[for="${id}"]`)) ||
        el.closest("label"),
    );
  };

  const vw = d.documentElement.clientWidth;
  const overflow = Array.from(d.body.querySelectorAll("*"))
    .filter((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.right > vw + 1 && visible(el);
    })
    .slice(0, 5)
    .map((el) => `${desc(el)} (right edge ${Math.round((el as HTMLElement).getBoundingClientRect().right)}px > ${vw}px)`);
  const pageOverflows = d.documentElement.scrollWidth > vw + 1;

  const landmarks: Record<string, number> = {};
  for (const [name, sel] of [
    ["header", "header, [role='banner']"],
    ["nav", "nav, [role='navigation']"],
    ["main", "main, [role='main']"],
    ["footer", "footer, [role='contentinfo']"],
  ] as const) {
    landmarks[name] = d.querySelectorAll(sel).length;
  }

  return {
    title: d.title,
    lang: d.documentElement.lang,
    h1Count: d.querySelectorAll("h1").length,
    headings: first(all("h1, h2, h3").map((h) => `${h.tagName.toLowerCase()}: ${text(h).slice(0, 60)}`), 12),
    landmarks,
    unnamedButtons: first(buttons.filter((b) => !hasName(b)).map(desc)),
    unnamedLinks: first(links.filter((a) => !hasName(a)).map(desc)),
    unlabeledInputs: first(inputs.filter((i) => !labelled(i)).map(desc)),
    imagesWithoutAlt: first(all("img:not([alt])").map(desc)),
    interactive: buttons.length + links.length + inputs.length,
    textSample: text(d.body).slice(0, 500),
    overflow: pageOverflows ? (overflow.length ? overflow : ["the page is wider than the viewport"]) : [],
  };
}

/** Runs inspect_page. Never throws: every failure comes back as a TOOL ERROR text for the model. */
export async function runInspectPage(args: Record<string, any>, workspaceRoot: string): Promise<string> {
  const target = resolveInspectTarget(args, workspaceRoot);
  if (target.error) return target.error;

  let pw: any;
  try {
    pw = await import("playwright");
  } catch {
    return "TOOL ERROR: playwright is not installed in the agent project (npm install). Report the visual checks as Not verified.";
  }

  let browser: any;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (err: any) {
    const msg = String(err?.message ?? err).split("\n")[0];
    return `TOOL ERROR: could not start Chromium (${msg}). Ask the user to run: npx playwright install chromium. Report the visual checks as Not verified.`;
  }

  const widths = cleanWidths(args.widths);
  const waitMs = Math.min(Math.max(Number(args.wait_ms) || 800, 0), 5000);
  const shots: string[] = [];
  const lines: string[] = [];
  const consoleIssues = new Set<string>();
  const pageErrors = new Set<string>();
  const failed = new Set<string>();
  let status: number | string = "?";
  let first: PageFacts | undefined;

  try {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, acceptDownloads: false });
      const page = await context.newPage();
      page.on("console", (m: any) => {
        if (m.type() === "error" || m.type() === "warning") consoleIssues.add(`[${m.type()}] ${String(m.text()).slice(0, 200)}`);
      });
      page.on("pageerror", (e: any) => pageErrors.add(String(e?.message ?? e).slice(0, 200)));
      page.on("requestfailed", (r: any) => failed.add(`${r.method()} ${String(r.url()).slice(0, 120)} (${r.failure()?.errorText ?? "failed"})`));
      page.on("response", (r: any) => {
        if (r.status() >= 400) failed.add(`${r.status()} ${String(r.url()).slice(0, 120)}`);
      });

      try {
        const res = await page.goto(target.url, { waitUntil: "load", timeout: 15_000 });
        if (width === widths[0]) status = res?.status() ?? "?";
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        await context.close();
        if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(msg)) {
          return `TOOL ERROR: nothing is listening at ${target.url}. inspect_page does not start servers: ask the user to start the dev server (for example npm run dev) and tell you the URL, or report the visual checks as Not verified.`;
        }
        return `TOOL ERROR: could not load ${target.url}: ${msg.split("\n")[0]}`;
      }

      if (waitMs) await page.waitForTimeout(waitMs);
      const facts: PageFacts = await page.evaluate(collectFacts);
      if (!first) first = facts;
      lines.push(`at ${width}px: ${facts.overflow.length ? `HORIZONTAL OVERFLOW: ${facts.overflow.join("; ")}` : "no horizontal overflow"}`);

      if (args.screenshot === true) {
        const dir = path.resolve(process.cwd(), ".agent_cache", "screenshots");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `page-${Date.now()}-${width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(file);
      }
      await context.close();
    }
  } catch (err: any) {
    return `TOOL ERROR: inspect_page failed: ${String(err?.message ?? err).split("\n")[0]}`;
  } finally {
    await browser.close().catch(() => undefined);
  }

  const f = first!;
  const list = (label: string, items: string[]) => (items.length ? [`${label} (${items.length}): ${items.join(" | ")}`] : [`${label}: none`]);
  const report = [
    `PAGE ${target.url}  status ${status}  title "${f.title}"  lang "${f.lang || "(missing)"}"`,
    ...list("Console errors/warnings", [...consoleIssues].slice(0, 8)),
    ...list("Uncaught page errors", [...pageErrors].slice(0, 5)),
    ...list("Failed or 4xx/5xx requests", [...failed].slice(0, 8)),
    ...lines,
    `Structure: h1 count ${f.h1Count}; landmarks ${Object.entries(f.landmarks).map(([k, v]) => `${k}=${v}`).join(" ")}; ${f.interactive} interactive elements`,
    `Headings: ${f.headings.join(" | ") || "none"}`,
    ...list("Buttons without an accessible name", f.unnamedButtons),
    ...list("Links without an accessible name", f.unnamedLinks),
    ...list("Inputs without a label", f.unlabeledInputs),
    ...list("Images without alt", f.imagesWithoutAlt),
    `Visible text starts: "${f.textSample.slice(0, 300)}"`,
    shots.length ? `Screenshots saved for the user (you cannot read them): ${shots.join(", ")}` : "",
    "NOT checked by this tool: visual design, colours, spacing, pixel match, real-device behaviour, screen-reader output. Report those as Not verified.",
  ]
    .filter(Boolean)
    .join("\n");

  return report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}\n[report shortened]` : report;
}
