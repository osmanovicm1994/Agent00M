import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findSpecFiles, formatSpecFiles, namedFiles, specWarnings } from "./spec-files";

let root: string;
const write = (rel: string, text = "x") => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-files-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("namedFiles", () => {
  it("finds document and picture names, once each, and ignores project files", () => {
    const text = "Read @ugovorv1.md and context.md, match ugovor-ep.jpg. Again ugovorv1.md. Edit package.json and README.md.";
    expect(namedFiles(text)).toEqual(["ugovorv1.md", "context.md", "ugovor-ep.jpg"]);
  });

  it("takes the file name from a path", () => {
    expect(namedFiles("see docs/spec/ugovorv1.md")).toEqual(["ugovorv1.md"]);
  });

  it("returns nothing for text without file names", () => {
    expect(namedFiles("build a login page")).toEqual([]);
  });
});

describe("findSpecFiles", () => {
  it("reads the content of a named markdown file next to the project", () => {
    write("ugovorv1.md", "# Ugovor\nSeller, buyer, vehicle.");
    const sf = findSpecFiles(root, "Use ugovorv1.md as the spec");
    expect(sf.texts).toHaveLength(1);
    expect(sf.texts[0].file).toBe("ugovorv1.md");
    expect(sf.block).toContain("REFERENCED FILES");
    expect(sf.block).toContain("Seller, buyer, vehicle.");
  });

  it("finds a file in docs/ (one level down) and matches the name case-insensitively", () => {
    write("docs/Context.MD", "Rules of the app");
    const sf = findSpecFiles(root, "read context.md first");
    expect(sf.texts.map((t) => t.file)).toEqual(["docs/Context.MD"]);
  });

  it("says plainly that a named picture was not looked at, and does not read it as text", () => {
    write("ugovor-ep.jpg", "\u0000\u0001binary");
    const sf = findSpecFiles(root, "layout like ugovor-ep.jpg");
    expect(sf.images).toEqual(["ugovor-ep.jpg"]);
    expect(sf.texts).toEqual([]);
    expect(sf.block).toContain("NOBODY HAS LOOKED AT THEM");
    expect(sf.block).not.toContain("binary");
    expect(specWarnings(sf).join()).toContain("not looked at: ugovor-ep.jpg");
  });

  it("reports a named file that is not in the folder (for example the other spelling of the spec name)", () => {
    write("ugovorv1.md", "spec");
    const sf = findSpecFiles(root, "Use context.md and ugovorv1.md");
    expect(sf.missing).toEqual(["context.md"]);
    expect(sf.block).toContain("NOT in the project folder: context.md");
    expect(sf.texts.map((t) => t.file)).toEqual(["ugovorv1.md"]);
  });

  it("shortens long files and keeps the total inside the budget", () => {
    write("a.md", "A".repeat(20_000));
    write("b.md", "B".repeat(20_000));
    const sf = findSpecFiles(root, "a.md b.md");
    expect(sf.texts[0].truncated).toBe(true);
    const total = sf.texts.reduce((n, t) => n + t.text.length, 0);
    expect(total).toBeLessThanOrEqual(12_100);
  });

  it("refuses very large files instead of reading them", () => {
    write("big.md", "x".repeat(100_000));
    const sf = findSpecFiles(root, "big.md");
    expect(sf.texts).toEqual([]);
    expect(sf.unreadable.join()).toContain("big.md");
  });

  it("does not look inside node_modules or the tasks folder", () => {
    write("node_modules/pkg/notes.md", "from a dependency");
    write("tasks/notes.md", "an old ticket");
    const sf = findSpecFiles(root, "see notes.md");
    expect(sf.texts).toEqual([]);
    expect(sf.missing).toEqual(["notes.md"]);
  });

  it("returns an empty block when the request names no files", () => {
    expect(findSpecFiles(root, "add a button").block).toBe("");
  });

  it("formatSpecFiles is empty for an empty result", () => {
    expect(formatSpecFiles({ texts: [], images: [], unreadable: [], missing: [] })).toBe("");
  });
});
