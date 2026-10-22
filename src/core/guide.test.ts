import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { guidePath, readGuide } from "./guide";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpFile(content: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "guide-"));
  dirs.push(d);
  const f = path.join(d, "g.md");
  fs.writeFileSync(f, content);
  return f;
}

describe("readGuide", () => {
  it("finds the real tutorial in the repository", () => {
    expect(fs.existsSync(guidePath())).toBe(true);
    const text = readGuide();
    expect(text).not.toBeNull();
    expect(text!.length).toBeGreaterThan(1000);
  });

  it("returns the file text, and null for missing, empty or oversized files", () => {
    expect(readGuide(tmpFile("# Hello"))).toBe("# Hello");
    expect(readGuide(tmpFile(""))).toBeNull();
    expect(readGuide(tmpFile("x".repeat(300 * 1024 + 1)))).toBeNull();
    expect(readGuide(path.join(os.tmpdir(), "no-such-guide.md"))).toBeNull();
  });
});
