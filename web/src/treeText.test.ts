import { describe, expect, it } from "vitest";
import type { FileEntry } from "./protocol";
import { allDirPaths, ancestorsOf, buildTree, countEntries, pathsMatching, renderTreeText, visibleRows } from "./treeText";

const entries: FileEntry[] = [
  { path: "src", type: "dir" },
  { path: "src/core", type: "dir" },
  { path: "src/core/a.ts", type: "file", size: 10 },
  { path: "src/cli.ts", type: "file", size: 5 },
  { path: "web", type: "dir" },
  { path: "README.md", type: "file", size: 1 },
];

describe("buildTree / countEntries", () => {
  it("nests a flat pre-order list", () => {
    const roots = buildTree(entries);
    expect(roots.map((r) => r.name)).toEqual(["src", "web", "README.md"]);
    expect(roots[0].children.map((c) => c.name)).toEqual(["core", "cli.ts"]);
    expect(roots[0].children[0].children[0].path).toBe("src/core/a.ts");
  });

  it("puts an entry whose folder was cut off at the top level", () => {
    expect(buildTree([{ path: "gone/x.ts", type: "file" }]).map((r) => r.path)).toEqual(["gone/x.ts"]);
  });

  it("counts folders and files", () => {
    expect(countEntries(entries)).toEqual({ dirs: 3, files: 3 });
  });
});

describe("renderTreeText", () => {
  it("looks like the tree command", () => {
    expect(renderTreeText(entries)).toBe(
      [
        ".",
        "├── src",
        "│   ├── core",
        "│   │   └── a.ts",
        "│   └── cli.ts",
        "├── web",
        "└── README.md",
        "",
        "3 directories, 3 files",
      ].join("\n"),
    );
  });

  it("uses singular words and a custom root label", () => {
    expect(renderTreeText([{ path: "a", type: "dir" }, { path: "a/b.txt", type: "file" }], "proj")).toBe(
      ["proj", "└── a", "    └── b.txt", "", "1 directory, 1 file"].join("\n"),
    );
  });

  it("handles an empty project", () => {
    expect(renderTreeText([])).toBe(".\n\n0 directories, 0 files");
  });
});

describe("visibleRows", () => {
  const roots = buildTree(entries);

  it("shows only the top level when nothing is open", () => {
    expect(visibleRows(roots, new Set()).map((r) => r.node.path)).toEqual(["src", "web", "README.md"]);
  });

  it("shows children of open folders with their depth", () => {
    const rows = visibleRows(roots, new Set(["src", "src/core"]));
    expect(rows.map((r) => [r.node.path, r.depth])).toEqual([
      ["src", 0],
      ["src/core", 1],
      ["src/core/a.ts", 2],
      ["src/cli.ts", 1],
      ["web", 0],
      ["README.md", 0],
    ]);
  });

  it("with a filter shows matches and their folders, all open", () => {
    const matching = pathsMatching(entries, "A.TS");
    expect([...matching].sort()).toEqual(["src", "src/core", "src/core/a.ts"]);
    expect(visibleRows(roots, new Set(), matching).map((r) => r.node.path)).toEqual(["src", "src/core", "src/core/a.ts"]);
  });

  it("an empty filter matches nothing (the caller then does not filter)", () => {
    expect(pathsMatching(entries, "  ").size).toBe(0);
  });
});

describe("allDirPaths / ancestorsOf", () => {
  it("lists folders", () => {
    expect(allDirPaths(entries)).toEqual(["src", "src/core", "web"]);
  });

  it("lists the folders above files, tolerating ./", () => {
    expect(ancestorsOf(["./src/core/a.ts", "README.md", "src/cli.ts"]).sort()).toEqual(["src", "src/core"]);
  });
});
