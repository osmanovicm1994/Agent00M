// Design preview: serves files of the project folder to the dashboard's Preview panel, read-only.
//
// Safety, because this is an HTTP route onto the project folder:
//  - the route needs a random key (see server.ts) that only token holders receive
//  - paths are checked twice: textually (no "..", no hidden segments such as .git or .env) and on the REAL
//    path after resolving symlinks (it must stay inside the project folder and hide the same names)
//  - every response carries `Content-Security-Policy: sandbox ...`, so a page runs in an opaque origin even
//    when it is opened directly in a browser tab: it can never read the dashboard's storage or token
//  - HTML pages get a <base> tag and a small element-picker script (dormant until the dashboard enables it)

import * as fs from "fs";
import * as path from "path";
import { isHiddenName } from "./file-tree";

export const PREVIEW_ROUTE = "/preview/";
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
// Scripts and forms work; same-origin access, top navigation and downloads do not.
export const PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups";

// Plain shape (not a union), like the rest of core/.
export interface PreviewResolve {
  ok: boolean;
  // Absolute real path of the file to send.
  file?: string;
  // Path relative to the project folder ("/" separators), with index.html added for a folder.
  rel?: string;
  status?: number;
  reason?: string;
}

function fail(status: number, reason: string): PreviewResolve {
  return { ok: false, status, reason };
}

function isInside(realRoot: string, real: string): boolean {
  const r = path.relative(realRoot, real);
  if (r === "") return true;
  return r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r);
}

function hasHiddenSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((s) => s.startsWith("."));
}

export function resolvePreviewFile(root: string, rawRel: string): PreviewResolve {
  const input = String(rawRel ?? "");
  if (input.includes("\0") || input.includes("\\")) return fail(400, "Bad path.");
  const segments = input.split("/").filter((s) => s !== "" && s !== ".");
  for (const s of segments) {
    if (s === "..") return fail(403, "Path leaves the project folder.");
    if (s.startsWith(".")) return fail(403, "Hidden files are not served.");
  }

  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(path.join(root, ...segments));
  } catch {
    return fail(404, "Not found.");
  }
  if (!isInside(realRoot, real)) return fail(403, "Path leaves the project folder.");

  let relParts = segments;
  try {
    if (fs.statSync(real).isDirectory()) {
      real = fs.realpathSync(path.join(real, "index.html"));
      relParts = [...segments, "index.html"];
      if (!isInside(realRoot, real)) return fail(403, "Path leaves the project folder.");
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) return fail(404, "Not found.");
    // The real target (after symlinks) must not be a hidden or secret file either.
    if (hasHiddenSegment(path.relative(realRoot, real)) || isHiddenName(path.basename(real), false)) {
      return fail(403, "Hidden files are not served.");
    }
    if (stat.size > MAX_PREVIEW_BYTES) return fail(413, "File is too large for the preview.");
  } catch {
    return fail(404, "Not found.");
  }
  return { ok: true, file: real, rel: relParts.join("/") };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Base URL for relative links inside a page: the page's own folder under the preview route.
export function previewBaseHref(key: string, rel: string): string {
  const dir = path.posix.dirname(rel);
  const encoded = dir === "." || dir === "/" ? "" : dir.split("/").map(encodeURIComponent).join("/") + "/";
  return `${PREVIEW_ROUTE}${key}/${encoded}`;
}

// The element picker. Runs only inside an iframe. The dashboard turns it on with
//   postMessage({ source: "agent-preview", type: "inspect", on: true })
// and receives { source: "agent-inspector", type: "pick" | "ready", ... } back.
// Plain string: no backticks and no dollar-brace sequences inside.
export const INSPECTOR_SCRIPT = String.raw`(function () {
  if (window.parent === window || window.__agentInspector) return;
  window.__agentInspector = true;
  var on = false, box = null, tag = null;
  function css(el, s) { for (var k in s) el.style[k] = s[k]; }
  function ensure() {
    if (box) return;
    box = document.createElement("div");
    box.setAttribute("data-agent-inspector", "1");
    css(box, { position: "fixed", zIndex: 2147483647, pointerEvents: "none", border: "2px solid #2dd4bf", background: "rgba(45,212,191,.12)", display: "none", boxSizing: "border-box" });
    tag = document.createElement("div");
    tag.setAttribute("data-agent-inspector", "1");
    css(tag, { position: "fixed", zIndex: 2147483647, pointerEvents: "none", font: "11px/1.2 ui-monospace,monospace", background: "#0f766e", color: "#fff", padding: "2px 6px", borderRadius: "3px", display: "none", maxWidth: "60vw", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(tag);
  }
  function esc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
  function unique(id) { return document.querySelectorAll("#" + esc(id)).length === 1; }
  function selectorOf(el) {
    var parts = [], cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 6) {
      if (cur.id && unique(cur.id)) { parts.unshift("#" + esc(cur.id)); break; }
      var part = cur.tagName.toLowerCase();
      var cls = (cur.getAttribute("class") || "").trim().split(/\s+/).filter(function (c) { return c && c.length < 30 && !/[:\[\]\/]/.test(c); }).slice(0, 2);
      if (cls.length) part += "." + cls.map(esc).join(".");
      var p = cur.parentElement;
      if (p) {
        var same = [].filter.call(p.children, function (c) { return c.tagName === cur.tagName; });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }
  function ours(el) { return !el || el.nodeType !== 1 || el.hasAttribute("data-agent-inspector"); }
  function hide() { if (box) { box.style.display = "none"; tag.style.display = "none"; } }
  document.addEventListener("mousemove", function (e) {
    if (!on || ours(e.target)) return;
    ensure();
    var r = e.target.getBoundingClientRect();
    css(box, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    tag.textContent = selectorOf(e.target);
    css(tag, { display: "block", left: Math.max(0, r.left) + "px", top: Math.max(0, r.top - 20) + "px" });
  }, true);
  document.addEventListener("click", function (e) {
    if (!on || ours(e.target)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    var el = e.target, r = el.getBoundingClientRect();
    parent.postMessage({
      source: "agent-inspector", type: "pick", selector: selectorOf(el), tag: el.tagName.toLowerCase(),
      text: String(el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
      html: String(el.outerHTML).slice(0, 600),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    }, "*");
  }, true);
  document.addEventListener("submit", function (e) { if (on) e.preventDefault(); }, true);
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.source !== "agent-preview" || d.type !== "inspect") return;
    on = !!d.on;
    if (!on) hide();
    document.documentElement.style.cursor = on ? "crosshair" : "";
  });
  parent.postMessage({ source: "agent-inspector", type: "ready" }, "*");
})();`;

// Adds the <base> tag (unless the page has one) and the element picker right after <head>.
export function injectPreviewHtml(html: string, baseHref: string): string {
  const hasBase = /<base[\s>]/i.test(html);
  const tags = (hasBase ? "" : `<base href="${escapeAttr(baseHref)}">`) + `<script>${INSPECTOR_SCRIPT}</script>`;

  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return `${html.slice(0, at)}<head>${tags}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + tags + html.slice(doctype[0].length);
  return tags + html;
}
