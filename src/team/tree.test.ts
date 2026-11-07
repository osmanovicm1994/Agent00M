import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { projectTree } from "./tree";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tree-"));
  dirs.push(d);
  return d;
}
function touch(root: string, rel: string, content = "x"): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("projectTree", () => {
  it("shows nested folders, directories first, and indents by level", () => {
    const root = tmp();
    touch(root, "package.json");
    touch(root, "apps/api/src/main.ts");
    touch(root, "apps/web/page.tsx");
    const tree = projectTree(root).split("\n");
    expect(tree[0]).toBe("apps/");
    expect(tree).toContain("  api/");
    expect(tree).toContain("    src/");
    expect(tree).toContain("  web/");
    expect(tree[tree.length - 1]).toBe("package.json");
  });

  it("stops at the depth limit", () => {
    const root = tmp();
    touch(root, "a/b/c/d/deep.ts");
    const tree = projectTree(root, { maxDepth: 3 });
    expect(tree).toContain("c/");
    expect(tree).not.toContain("d/");
    expect(tree).not.toContain("deep.ts");
  });

  it("leaves out dependencies, build output, hidden folders and secret files", () => {
    const root = tmp();
    touch(root, "node_modules/x/index.js");
    touch(root, "dist/out.js");
    touch(root, ".git/config");
    touch(root, ".github/workflows/ci.yml");
    touch(root, ".env");
    touch(root, ".env.local");
    touch(root, ".gitignore");
    touch(root, "src/index.ts");
    const tree = projectTree(root);
    expect(tree).not.toContain("node_modules");
    expect(tree).not.toContain("dist");
    expect(tree).not.toContain(".git/");
    expect(tree).not.toContain(".env");
    expect(tree).toContain(".github/");
    expect(tree).toContain(".gitignore");
    expect(tree).toContain("src/");
  });

  it("does not follow symlinks", () => {
    const root = tmp();
    const outside = tmp();
    touch(outside, "secret.txt");
    fs.symlinkSync(outside, path.join(root, "link"));
    touch(root, "real.ts");
    const tree = projectTree(root);
    expect(tree).not.toContain("link");
    expect(tree).not.toContain("secret.txt");
    expect(tree).toContain("real.ts");
  });

  it("caps the number of lines and says so", () => {
    const root = tmp();
    for (let i = 0; i < 30; i++) touch(root, `f${String(i).padStart(2, "0")}.ts`);
    const tree = projectTree(root, { maxEntries: 10 });
    expect(tree.split("\n").filter((l) => l.endsWith(".ts"))).toHaveLength(10);
    expect(tree).toContain("more entries not shown");
  });

  it("says when the folder is empty or unreadable", () => {
    expect(projectTree(tmp())).toContain("new project");
    expect(projectTree(path.join(os.tmpdir(), "no-such-folder-tree-test"))).toBe("(unreadable)");
  });
});
