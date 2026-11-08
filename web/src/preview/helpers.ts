// Pure helpers for the design preview panel (no React, unit-tested in helpers.test.ts).

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s"'<>)\]]*)?/gi;

// Finds dev-server addresses in command output ("Local: http://localhost:5173/"). Colour codes are ignored,
// 0.0.0.0 becomes localhost, and each address appears once.
export function extractLocalUrls(text: string): string[] {
  const out: string[] = [];
  const clean = text.replace(ANSI, "");
  for (const match of clean.matchAll(LOCAL_URL)) {
    const url = match[0].replace(/[.,;:]+$/, "").replace("//0.0.0.0", "//localhost");
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

// Newest first, no duplicates, at most `cap`.
export function mergeUrls(existing: string[], found: string[], cap = 8): string[] {
  if (found.length === 0) return existing;
  const next = [...found.slice().reverse(), ...existing.filter((u) => !found.includes(u))];
  return next.slice(0, cap);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Where in the source file an element picked in the preview probably is: the 1-based line of its opening tag,
// or null when it cannot be found (for example when a script created the element).
export function findSourceLine(source: string, outerHtml: string): number | null {
  const open = /^<[a-zA-Z][^>]*>/.exec(outerHtml.trim());
  if (!open) return null;
  let at = source.indexOf(open[0]);
  if (at < 0) {
    const tag = /^<([a-zA-Z][\w-]*)/.exec(open[0])?.[1];
    if (!tag) return null;
    const id = /\bid=["']([^"']+)["']/.exec(open[0]);
    if (id) {
      const m = new RegExp(`<${tag}\\b[^>]*\\bid=["']${escapeRe(id[1])}["']`, "i").exec(source);
      if (m) at = m.index;
    }
    if (at < 0) {
      const cls = /\bclass=["']([^"']+)["']/.exec(open[0]);
      const first = cls ? cls[1].trim().split(/\s+/)[0] : "";
      if (first) {
        const m = new RegExp(`<${tag}\\b[^>]*\\bclass=["'][^"']*\\b${escapeRe(first)}\\b`, "i").exec(source);
        if (m) at = m.index;
      }
    }
  }
  if (at < 0) return null;
  return source.slice(0, at).split("\n").length;
}

// Files whose change can alter what a preview shows.
export const WEB_FILE = /\.(html?|css|m?jsx?|tsx?|svg|json|png|jpe?g|gif|webp|avif|woff2?|ttf|otf)$/i;

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

// "src/a b.html" -> "src/a%20b.html" (each segment encoded, slashes kept)
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export interface Device {
  id: string;
  label: string;
  // null = fills the window
  w: number | null;
  h: number | null;
}

export const DEVICES: Device[] = [
  { id: "fit", label: "Responsive", w: null, h: null },
  { id: "iphone", label: "iPhone 15 (390×844)", w: 390, h: 844 },
  { id: "android", label: "Android (412×915)", w: 412, h: 915 },
  { id: "tablet", label: "Tablet (820×1180)", w: 820, h: 1180 },
  { id: "desktop", label: "Desktop (1280×800)", w: 1280, h: 800 },
];

// Scale that makes a w×h screen fit into an available box (never enlarges above 1).
export function fitScale(w: number, h: number, boxW: number, boxH: number): number {
  if (w <= 0 || h <= 0 || boxW <= 0 || boxH <= 0) return 1;
  return Math.min(1, boxW / w, boxH / h);
}

// ---------- pages of a Next.js app (for the "Go to page" menu of the dev-server preview) ----------

export interface RouteInfo {
  // "/", "/dashboard", "/users/[id]"
  route: string;
  // true when the address needs a value (a [param] segment): it cannot be opened as it is
  dynamic: boolean;
  file: string;
}

const ROOT = "(?:(?:apps|packages)\\/[^/]+\\/)?(?:src\\/)?";
const APP_PAGE = new RegExp(`^${ROOT}app\\/((?:[^/]+\\/)*)page\\.(?:tsx|jsx|ts|js|mdx)$`);
const PAGES_FILE = new RegExp(`^${ROOT}pages\\/((?:[^/]+\\/)*)([^/]+)\\.(?:tsx|jsx|ts|js|mdx)$`);

function toRoute(parts: string[]): { route: string; dynamic: boolean } | null {
  const out: string[] = [];
  for (const p of parts) {
    if (p.startsWith("@")) return null; // parallel route slot: not an address of its own
    if (/^\(\.{1,3}\)/.test(p)) return null; // intercepting route
    if (p.startsWith("_")) return null; // private folder
    if (/^\(.*\)$/.test(p)) continue; // route group: not part of the address
    out.push(p);
  }
  return { route: "/" + out.join("/"), dynamic: out.some((s) => s.startsWith("[")) };
}

// The pages of a Next.js project, found from the file list: app/**/page.tsx (App Router) and pages/*.tsx
// (Pages Router). API routes, route handlers, layouts and special files are not pages. Static pages first.
export function nextRoutes(entries: { path: string; type: string }[]): RouteInfo[] {
  const found = new Map<string, RouteInfo>();
  for (const e of entries) {
    if (e.type !== "file") continue;
    let parts: string[] | null = null;

    const app = APP_PAGE.exec(e.path);
    if (app) {
      parts = app[1].split("/").filter(Boolean);
    } else {
      const pages = PAGES_FILE.exec(e.path);
      if (pages) {
        const dir = pages[1].split("/").filter(Boolean);
        const name = pages[2];
        if (name.startsWith("_") || dir[0] === "api") continue;
        parts = name === "index" ? dir : [...dir, name];
      }
    }
    if (!parts) continue;

    const r = toRoute(parts);
    if (r && !found.has(r.route)) found.set(r.route, { ...r, file: e.path });
  }
  return [...found.values()].sort((a, b) => {
    if (a.route === "/") return -1;
    if (b.route === "/") return 1;
    if (a.dynamic !== b.dynamic) return a.dynamic ? 1 : -1;
    return a.route.localeCompare(b.route);
  });
}

// The same server, another page: ("http://localhost:3000/login?x=1", "/users") -> "http://localhost:3000/users".
export function withRoute(base: string, route: string): string | null {
  try {
    const u = new URL(base);
    u.pathname = route;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
