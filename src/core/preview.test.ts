import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { contentTypeFor, injectPreviewHtml, MAX_PREVIEW_BYTES, previewBaseHref, resolvePreviewFile } from "./preview";

let root: string;
let outside: string;

function put(rel: string, content = "x"): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-preview-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-preview-out-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("resolvePreviewFile", () => {
  it("serves a normal file and returns its relative path", () => {
    put("mock/home.html", "<p>hi</p>");
    const r = resolvePreviewFile(root, "mock/home.html");
    expect(r.ok).toBe(true);
    expect(r.rel).toBe("mock/home.html");
    expect(r.file && fs.readFileSync(r.file, "utf8")).toBe("<p>hi</p>");
  });

  it("serves index.html for a folder and for the root", () => {
    put("index.html");
    put("docs/index.html");
    expect(resolvePreviewFile(root, "").rel).toBe("index.html");
    expect(resolvePreviewFile(root, "docs").rel).toBe("docs/index.html");
    expect(resolvePreviewFile(root, "docs/").rel).toBe("docs/index.html");
  });

  it("rejects .. and backslashes", () => {
    put("a.html");
    expect(resolvePreviewFile(root, "../etc/passwd").ok).toBe(false);
    expect(resolvePreviewFile(root, "a/../../x").status).toBe(403);
    expect(resolvePreviewFile(root, "a\\b").status).toBe(400);
    expect(resolvePreviewFile(root, "a\0b").status).toBe(400);
  });

  it("rejects hidden files and folders such as .env and .git", () => {
    put(".env", "SECRET=1");
    put(".git/config", "x");
    put("app/.env.local", "SECRET=2");
    expect(resolvePreviewFile(root, ".env").status).toBe(403);
    expect(resolvePreviewFile(root, ".git/config").status).toBe(403);
    expect(resolvePreviewFile(root, "app/.env.local").status).toBe(403);
  });

  it("answers 404 for a missing file", () => {
    expect(resolvePreviewFile(root, "nope.html").status).toBe(404);
    expect(resolvePreviewFile(path.join(root, "missing-root"), "a.html").status).toBe(404);
  });

  it("does not follow a symlink out of the folder", () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    } catch {
      return; // symlinks are not allowed here
    }
    const r = resolvePreviewFile(root, "link.txt");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it("does not let a symlink inside the folder reach a hidden folder", () => {
    put(".git/config", "x");
    try {
      fs.symlinkSync(path.join(root, ".git", "config"), path.join(root, "innocent.txt"));
    } catch {
      return;
    }
    expect(resolvePreviewFile(root, "innocent.txt").ok).toBe(false);
  });

  it("refuses files over the size limit", () => {
    put("big.bin", "");
    fs.truncateSync(path.join(root, "big.bin"), MAX_PREVIEW_BYTES + 1);
    expect(resolvePreviewFile(root, "big.bin").status).toBe(413);
  });
});

describe("contentTypeFor", () => {
  it("maps common web types and falls back to octet-stream", () => {
    expect(contentTypeFor("a.html")).toContain("text/html");
    expect(contentTypeFor("a.CSS")).toContain("text/css");
    expect(contentTypeFor("a.mjs")).toContain("javascript");
    expect(contentTypeFor("a.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("a.unknown")).toBe("application/octet-stream");
  });
});

describe("previewBaseHref", () => {
  it("points at the page's own folder under the route", () => {
    expect(previewBaseHref("k", "index.html")).toBe("/preview/k/");
    expect(previewBaseHref("k", "mock/a b/home.html")).toBe("/preview/k/mock/a%20b/");
  });
});

describe("injectPreviewHtml", () => {
  const base = "/preview/k/mock/";

  it("adds the base tag and the picker right after <head>", () => {
    const out = injectPreviewHtml("<!doctype html><html><head><title>t</title></head><body>x</body></html>", base);
    expect(out).toContain(`<head><base href="${base}"><script>`);
    expect(out.indexOf("<base")).toBeLessThan(out.indexOf("<title>"));
    expect(out).toContain("<body>x</body>");
  });

  it("does not add a second base tag", () => {
    const out = injectPreviewHtml('<html><head><base href="/x/"></head></html>', base);
    expect(out.match(/<base/g)).toHaveLength(1);
    expect(out).toContain("<script>");
  });

  it("does not confuse <header> with <head>", () => {
    const out = injectPreviewHtml("<html><body><header>h</header></body></html>", base);
    expect(out).toContain("<html><head><base");
  });

  it("handles fragments and doctype-only documents", () => {
    expect(injectPreviewHtml("<p>x</p>", base).startsWith("<base")).toBe(true);
    expect(injectPreviewHtml("<!DOCTYPE html><p>x</p>", base).startsWith("<!DOCTYPE html><base")).toBe(true);
  });

  it("escapes the base href", () => {
    expect(injectPreviewHtml("<head></head>", '/p/"x/')).toContain('href="/p/&quot;x/"');
  });
});
