import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compileIgnore, DEFAULT_TREE_IGNORE, isHiddenName, listWorkspace, sanitizeIgnore } from "./file-tree";

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

describe("ignore list (like tree -I)", () => {
  it("replaces the built-in folder list, so dist can be shown", () => {
    put("dist/out.js");
    put("node_modules/x/index.js");
    put(".agent_cache/a.gz");
    put("src/a.ts");
    const paths = listWorkspace(root, { maxDepth: 40, ignore: DEFAULT_TREE_IGNORE }).entries.map((e) => e.path);
    expect(paths).toEqual(["dist", "dist/out.js", "src", "src/a.ts"]);
  });

  it("still hides secret env files and OS clutter with a custom list", () => {
    put(".env", "S=1");
    put(".env.local", "S=2");
    put(".env.example", "S=");
    put(".DS_Store");
    put("a.ts");
    const paths = listWorkspace(root, { ignore: ["nothing"] }).entries.map((e) => e.path);
    expect(paths).toEqual([".env.example", "a.ts"]);
  });

  it("supports * and ? patterns on file and folder names", () => {
    put("a.log");
    put("b.ts");
    put("tmp1/x.txt");
    put("tmp22/x.txt");
    const paths = listWorkspace(root, { maxDepth: 5, ignore: ["*.log", "tmp?"] }).entries.map((e) => e.path);
    expect(paths).toEqual(["tmp22", "tmp22/x.txt", "b.ts"]);
  });

  it("goes deeper than the default 3 levels when asked", () => {
    put("a/b/c/d/e/deep.txt");
    const paths = listWorkspace(root, { maxDepth: 40, maxEntries: 20000, ignore: DEFAULT_TREE_IGNORE }).entries.map((e) => e.path);
    expect(paths).toContain("a/b/c/d/e/deep.txt");
  });

  it("treats an empty ignore list as not given", () => {
    put("node_modules/x.js");
    put("a.ts");
    expect(listWorkspace(root, { ignore: [] }).entries.map((e) => e.path)).toEqual(["a.ts"]);
  });
});

describe("sanitizeIgnore / compileIgnore", () => {
  it("keeps plain names, trims, drops paths, duplicates and non-strings", () => {
    expect(sanitizeIgnore([" node_modules ", "dist/", "a/b", "a\\b", "", 5, "dist", "*.log"])).toEqual(["node_modules", "dist", "*.log"]);
    expect(sanitizeIgnore("node_modules")).toBeUndefined();
    expect(sanitizeIgnore(undefined)).toBeUndefined();
  });

  it("bounds the number and length of patterns", () => {
    expect(sanitizeIgnore(Array.from({ length: 100 }, (_, i) => `n${i}`))).toHaveLength(40);
    expect(sanitizeIgnore(["x".repeat(200)])).toEqual([]);
  });

  it("matches exactly and with wildcards, escaping regex characters", () => {
    const m = compileIgnore(["node_modules", "*.min.js", "a+b"]);
    expect(m("node_modules")).toBe(true);
    expect(m("node_modules2")).toBe(false);
    expect(m("app.min.js")).toBe(true);
    expect(m("app.minXjs")).toBe(false);
    expect(m("a+b")).toBe(true);
  });
});
