import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isHiddenName, listWorkspace } from "./file-tree";

let root: string;
let outside: string;

function put(rel: string, content = "x"): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tree-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tree-outside-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("isHiddenName", () => {
  it("hides secret env files but not the example file", () => {
    expect(isHiddenName(".env", false)).toBe(true);
    expect(isHiddenName(".env.local", false)).toBe(true);
    expect(isHiddenName(".env.example", false)).toBe(false);
    expect(isHiddenName("env.ts", false)).toBe(false);
  });

  it("hides heavy folders and OS clutter", () => {
    expect(isHiddenName("node_modules", true)).toBe(true);
    expect(isHiddenName(".git", true)).toBe(true);
    expect(isHiddenName(".DS_Store", false)).toBe(true);
    expect(isHiddenName("src", true)).toBe(false);
  });
});

describe("listWorkspace", () => {
  it("lists folders before files, in pre-order, with relative paths", () => {
    put("src/b.ts");
    put("src/a.ts");
    put("README.md");
    put("package.json");
    const { entries } = listWorkspace(root);
    expect(entries.map((e) => e.path)).toEqual(["src", "src/a.ts", "src/b.ts", "package.json", "README.md"]);
    expect(entries[0].type).toBe("dir");
    expect(entries[1].type).toBe("file");
    expect(entries[1].size).toBe(1);
  });

  it("leaves out secrets, caches and generated folders", () => {
    put(".env", "SECRET=1");
    put(".env.local", "SECRET=2");
    put(".env.example", "SECRET=");
    put("node_modules/x/index.js");
    put(".git/config");
    put("dist/out.js");
    put(".DS_Store");
    put("app.ts");
    const paths = listWorkspace(root).entries.map((e) => e.path);
    expect(paths).toEqual([".env.example", "app.ts"]);
  });

  it("stops at maxDepth", () => {
    put("a/b/c/d/deep.txt");
    const paths = listWorkspace(root, { maxDepth: 2 }).entries.map((e) => e.path);
    expect(paths).toEqual(["a", "a/b"]);
  });

  it("truncates at maxEntries and says so", () => {
    for (let i = 0; i < 10; i++) put(`f${i}.txt`);
    const result = listWorkspace(root, { maxEntries: 4 });
    expect(result.entries).toHaveLength(4);
    expect(result.truncated).toBe(true);
    expect(listWorkspace(root, { maxEntries: 50 }).truncated).toBe(false);
  });

  it("never follows symbolic links out of the folder", () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
    try {
      fs.symlinkSync(outside, path.join(root, "link"));
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "secret-link.txt"));
    } catch {
      return; // symlinks are not allowed in this environment; nothing to check
    }
    put("ok.txt");
    expect(listWorkspace(root).entries.map((e) => e.path)).toEqual(["ok.txt"]);
  });

  it("returns an empty listing for a missing folder", () => {
    const result = listWorkspace(path.join(root, "does-not-exist"));
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
