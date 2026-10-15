// Tests for the workspace-scoped tools through the non-interactive ToolDispatcher.
// Each test works in a temporary workspace, so nothing in the real project is touched.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ToolDispatcher } from "./index";

describe("ToolDispatcher and tools", () => {
  let tmpDir: string;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-test-"));
    dispatcher = new ToolDispatcher(tmpDir);

    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src/main.ts"), 'console.log("hello world");');
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test Workspace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates a directory tree", async () => {
    const tree = await dispatcher.dispatch("get_directory_tree", { path: ".", maxDepth: 2 });
    expect(tree).toContain("src/");
    expect(tree).toContain("README.md");
  });

  it("reads several files in one call", async () => {
    const result = await dispatcher.dispatch("read_multiple_files", { paths: ["src/main.ts", "README.md"] });
    expect(result).toContain("hello world");
    expect(result).toContain("# Test Workspace");
  });

  it("refuses to read outside the workspace", async () => {
    await expect(dispatcher.dispatch("read_file", { path: "../../../etc/passwd" })).rejects.toThrow(
      "Refusing to access path outside workspace",
    );
  });

  it("does not treat a sibling folder with the same prefix as inside the workspace", async () => {
    const sibling = `${tmpDir}-evil`;
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "secret.txt"), "nope");
    try {
      await expect(dispatcher.dispatch("read_file", { path: `../${path.basename(sibling)}/secret.txt` })).rejects.toThrow(
        "outside workspace",
      );
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("finds a pattern with grep", async () => {
    const result = await dispatcher.dispatch("grep", { pattern: "hello" });
    expect(result).toContain('src/main.ts:1: console.log("hello world");');
  });

  it("finds files by name", async () => {
    const result = await dispatcher.dispatch("find_files", { query: "main" });
    expect(result).toContain(path.join("src", "main.ts"));
  });

  it("writes and appends files inside the workspace", async () => {
    await dispatcher.dispatch("write_file", { path: "out/a.txt", content: "one\n" });
    await dispatcher.dispatch("append_file", { path: "out/a.txt", content: "two\n" });
    expect(fs.readFileSync(path.join(tmpDir, "out/a.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("runs commands in the workspace root", async () => {
    const output = await dispatcher.dispatch("run_command", { command: "node -v" });
    expect(output).toContain("EXIT CODE: 0");
  });

  it("rejects an unknown tool", async () => {
    await expect(dispatcher.dispatch("does_not_exist", {})).rejects.toThrow("Unknown tool");
  });
});
