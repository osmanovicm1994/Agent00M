import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveInspectTarget } from "./browser.tool";

describe("resolveInspectTarget (which pages inspect_page may open)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-test-"));
    fs.writeFileSync(path.join(root, "index.html"), "<h1>hi</h1>");
    fs.writeFileSync(path.join(root, "notes.txt"), "x");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("allows a localhost dev server", () => {
    expect(resolveInspectTarget({ url: "http://localhost:5173/" }, root).url).toBe("http://localhost:5173/");
    expect(resolveInspectTarget({ url: "http://127.0.0.1:3000/app" }, root).url).toContain("127.0.0.1:3000");
  });

  it("refuses public hosts, other protocols and bad URLs", () => {
    expect(resolveInspectTarget({ url: "https://example.com" }, root).error).toMatch(/not allowed/);
    expect(resolveInspectTarget({ url: "file:///etc/passwd" }, root).error).toMatch(/only http/);
    expect(resolveInspectTarget({ url: "not a url" }, root).error).toMatch(/not a valid URL/);
    expect(resolveInspectTarget({ url: "http://192.168.1.10:3000" }, root).error).toMatch(/not allowed/);
  });

  it("opens an .html file inside the workspace", () => {
    expect(resolveInspectTarget({ path: "index.html" }, root).url).toMatch(/^file:\/\/.*index\.html$/);
  });

  it("refuses files outside the workspace, missing files and non-html files", () => {
    expect(resolveInspectTarget({ path: "../other.html" }, root).error).toMatch(/outside/);
    expect(resolveInspectTarget({ path: "missing.html" }, root).error).toMatch(/not found/);
    expect(resolveInspectTarget({ path: "notes.txt" }, root).error).toMatch(/\.html/);
  });

  it("needs a url or a path", () => {
    expect(resolveInspectTarget({}, root).error).toMatch(/needs/);
  });
});
