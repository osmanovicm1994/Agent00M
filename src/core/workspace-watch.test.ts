import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compileIgnore, DEFAULT_TREE_IGNORE } from "./file-tree";
import { shouldReport, watchWorkspace } from "./workspace-watch";

describe("shouldReport", () => {
  const ignored = compileIgnore(DEFAULT_TREE_IGNORE);

  it("reports normal files", () => {
    expect(shouldReport("src/app.ts", ignored)).toBe(true);
    expect(shouldReport("index.html", ignored)).toBe(true);
  });

  it("skips ignored and heavy folders anywhere in the path", () => {
    expect(shouldReport("node_modules/x/index.js", ignored)).toBe(false);
    expect(shouldReport("web/node_modules/x.js", ignored)).toBe(false);
    expect(shouldReport(".git/HEAD", ignored)).toBe(false);
    expect(shouldReport(".agent_cache/abc.gz", ignored)).toBe(false);
    expect(shouldReport("dist/out.js", ignored)).toBe(false);
    expect(shouldReport("node_modules", ignored)).toBe(false);
  });

  it("skips secret env files and OS clutter, keeps .env.example", () => {
    expect(shouldReport(".env", ignored)).toBe(false);
    expect(shouldReport("app/.env.local", ignored)).toBe(false);
    expect(shouldReport(".DS_Store", ignored)).toBe(false);
    expect(shouldReport(".env.example", ignored)).toBe(true);
  });

  it("ignores empty paths", () => {
    expect(shouldReport("", ignored)).toBe(false);
  });
});

describe("watchWorkspace", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-watch-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports a created file once, debounced, and not ignored folders", async () => {
    const batches: string[][] = [];
    const watcher = watchWorkspace(root, (paths) => batches.push(paths), { debounceMs: 50 });
    if (!watcher.supported) {
      watcher.close();
      return; // recursive watching is not available on this platform
    }
    // The recursive watcher (FSEvents on macOS) needs a moment to start; files written right away can be missed.
    await new Promise((r) => setTimeout(r, 500));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "x.js"), "x");
    fs.writeFileSync(path.join(root, "page.html"), "<p>1</p>");
    fs.writeFileSync(path.join(root, "page.html"), "<p>2</p>");

    const deadline = Date.now() + 4000;
    while (!batches.flat().includes("page.html") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    // give any late batch a chance to show up, so a wrongly reported ignored folder would be caught
    await new Promise((r) => setTimeout(r, 300));
    watcher.close();

    const all = batches.flat();
    expect(all).toContain("page.html");
    expect(all.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(all).not.toContain(path.basename(root));
    // one report per debounce window, even though the file was written twice
    expect(batches.every((b) => b.filter((p) => p === "page.html").length <= 1)).toBe(true);
  });

  it("stops reporting after close", async () => {
    const batches: string[][] = [];
    const watcher = watchWorkspace(root, (paths) => batches.push(paths), { debounceMs: 20 });
    watcher.close();
    fs.writeFileSync(path.join(root, "late.txt"), "x");
    await new Promise((r) => setTimeout(r, 200));
    expect(batches).toEqual([]);
  });
});
