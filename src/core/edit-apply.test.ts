import { describe, expect, it } from "vitest";
import { applyEdit } from "./edit-apply";

const FILE = ["import a from \"a\";", "", "export function f() {", "  return 1;", "}", ""].join("\n");

describe("applyEdit", () => {
  it("replaces one exact piece and reports where", () => {
    const r = applyEdit(FILE, "  return 1;", "  return 2;");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain("  return 2;");
      expect(r.content).not.toContain("return 1;");
      expect(r.replaced).toBe(1);
      expect(r.firstLine).toBe(4);
    }
  });

  it("refuses an ambiguous match and lists the lines", () => {
    const r = applyEdit("a\nb\na\n", "a", "c");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/2 places \(lines 1, 3\)/);
  });

  it("replaces every match with replaceAll", () => {
    const r = applyEdit("a\nb\na\n", "a", "c", true);
    expect(r.ok && r.content).toBe("c\nb\nc\n");
  });

  it("deletes with an empty new_string", () => {
    const r = applyEdit(FILE, "import a from \"a\";\n\n", "");
    expect(r.ok && r.content.startsWith("export function")).toBe(true);
  });

  it("refuses an empty old_string, identical strings and a missing new_string", () => {
    expect(applyEdit(FILE, "", "x").ok).toBe(false);
    expect(applyEdit(FILE, "}", "}").ok).toBe(false);
    expect(applyEdit(FILE, "}", undefined as unknown as string).ok).toBe(false);
  });

  it("refuses text that is not in the file", () => {
    const bad = applyEdit(FILE, "export function f()  {", "x");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/not found/);
    expect(applyEdit(FILE, "return 1;\nreturn 2;", "x").ok).toBe(false);
  });

  it("ignores trailing spaces and CRLF when matching", () => {
    const r = applyEdit("one  \r\ntwo\r\n", "one\ntwo", "1\n2");
    expect(r.ok && r.content).toBe("1\n2\n");
  });

  it("names the line when the first line of old_string exists with other indentation", () => {
    const r = applyEdit("function f() {\n    return 1;\n}\n", "  return 1;\n  return 2;", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/line 2/);
  });
});
