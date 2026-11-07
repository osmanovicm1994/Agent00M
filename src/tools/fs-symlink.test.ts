import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FsTools, isSecretPath } from "./fs.tool";
import { SearchTool } from "./search.tool";

// A project folder next to an "outside" folder, with symlinks inside the project that point out of it.
let base: string;
let proj: string;
let outside: string;
let fsTools: FsTools;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-symlink-")));
  proj = path.join(base, "proj");
  outside = path.join(base, "outside");
  fs.mkdirSync(proj);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET-OUTSIDE");
  fs.writeFileSync(path.join(outside, ".env"), "API_KEY=outside-real-key");
  fs.writeFileSync(path.join(proj, "ok.txt"), "plain project file");
  fs.writeFileSync(path.join(proj, ".env"), "API_KEY=inside-real-key");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(proj, "link-file"));
  fs.symlinkSync(outside, path.join(proj, "link-dir"));
  fs.symlinkSync(path.join(outside, "does-not-exist.txt"), path.join(proj, "dangling"));
  // Inside the project, but the target is a real .env: the link name looks harmless.
  fs.symlinkSync(path.join(proj, ".env"), path.join(proj, "config.txt"));
  fsTools = new FsTools(proj);
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("FsTools and symlinks", () => {
  it("still reads a normal project file", () => {
    expect(fsTools.readFile("ok.txt")).toBe("plain project file");
  });

  it("refuses a file symlink that points outside the project", () => {
    expect(() => fsTools.readFile("link-file")).toThrow(/outside workspace/);
  });

  it("refuses to read through a directory symlink", () => {
    expect(() => fsTools.readFile("link-dir/secret.txt")).toThrow(/outside workspace/);
    expect(() => fsTools.listDirectory("link-dir")).toThrow(/outside workspace/);
  });

  it("refuses to write or append through a symlink that leaves the project", () => {
    expect(() => fsTools.commitWrite("link-dir/new.txt", "x")).toThrow(/outside workspace/);
    expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
    expect(() => fsTools.appendToFile("link-file", "more")).toThrow(/outside workspace/);
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("TOP-SECRET-OUTSIDE");
  });

  it("refuses a dangling symlink (writing would create a file outside)", () => {
    expect(() => fsTools.commitWrite("dangling", "x")).toThrow(/symlink/);
    expect(fs.existsSync(path.join(outside, "does-not-exist.txt"))).toBe(false);
  });

  it("blocks a harmless-looking link whose real target is a secret .env", () => {
    expect(() => fsTools.readFile("config.txt")).toThrow(/secret env file/);
  });

  it("allows writing a new file in a new folder inside the project", () => {
    fsTools.commitWrite("src/new/file.ts", "export {};\n");
    expect(fs.readFileSync(path.join(proj, "src/new/file.ts"), "utf8")).toBe("export {};\n");
  });

  it("does not treat a folder named '..foo' as an escape", () => {
    fsTools.commitWrite("..foo/a.txt", "x");
    expect(fsTools.readFile("..foo/a.txt")).toBe("x");
  });

  it("still blocks plain ../ traversal", () => {
    expect(() => fsTools.readFile("../outside/secret.txt")).toThrow(/outside workspace/);
  });
});

describe("SearchTool and symlinks", () => {
  const search = () => new SearchTool(proj);

  it("grep does not follow symlinks to files or folders", () => {
    const hits = search().grep("TOP-SECRET-OUTSIDE|outside-real-key");
    expect(hits).toEqual([]);
  });

  it("find_files does not list files behind a directory symlink", () => {
    const found = search().findFiles("secret");
    expect(found).toEqual([]);
  });

  it("grep still finds ordinary project files", () => {
    const hits = search().grep("plain project file");
    expect(hits.map((h) => h.file)).toContain("ok.txt");
  });
});

describe("isSecretPath", () => {
  it("blocks real env files and allows examples", () => {
    expect(isSecretPath(".env")).toBe(true);
    expect(isSecretPath("apps/api/.env.local")).toBe(true);
    expect(isSecretPath(".env.example")).toBe(false);
    expect(isSecretPath(".env.sample")).toBe(false);
    expect(isSecretPath("src/env.ts")).toBe(false);
  });
});
