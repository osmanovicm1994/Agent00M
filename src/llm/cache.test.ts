import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pruneCache } from "./cache";

const DAY = 86_400_000;

describe("pruneCache", () => {
  let dir: string;

  const entry = (name: string, kb: number, ageDays: number) => {
    const file = path.join(dir, `${name}.gz`);
    fs.writeFileSync(file, Buffer.alloc(kb * 1024));
    const when = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(file, when, when);
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes entries older than the TTL", () => {
    const old = entry("old", 1, 10);
    const fresh = entry("fresh", 1, 1);
    expect(pruneCache(dir, 7, 0)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("removes the oldest entries first when the folder is over the size limit", () => {
    const a = entry("a", 600, 3);
    const b = entry("b", 600, 2);
    const c = entry("c", 600, 1);
    pruneCache(dir, 0, 1); // 1 MB limit, 1.8 MB present
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(fs.existsSync(c)).toBe(true);
  });

  it("keeps everything when TTL and size limit are disabled", () => {
    entry("x", 1, 100);
    expect(pruneCache(dir, 0, 0)).toBe(0);
  });

  it("ignores files that are not cache entries and a missing folder", () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
    expect(pruneCache(dir, 7, 1)).toBe(0);
    expect(pruneCache(path.join(dir, "missing"), 7, 1)).toBe(0);
  });
});
