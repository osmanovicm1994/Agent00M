/**.  used for testing the tools in isolation. It creates a temporary workspace, seeds it with test files, and verifies the behavior of the ToolDispatcher and its associated tools (FsTools, SearchTool, ShellTool). The tests cover directory tree generation, reading multiple files, preventing directory traversal, searching patterns using grep, and running commands safely within the workspace root. 
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ToolDispatcher } from "./index";

describe("ToolDispatcher & Tools", () => {
  let tmpDir: string;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-test-"));
    dispatcher = new ToolDispatcher(tmpDir);

    // Seed test files
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src/main.ts"), 'console.log("hello world");');
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test Workspace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should generate a directory tree", async () => {
    const tree = await dispatcher.dispatch("get_directory_tree", { path: ".", maxDepth: 2 });
    expect(tree).toContain("src/");
    expect(tree).toContain("README.md");
  });

  it("should read multiple files in one turn", async () => {
    const result = await dispatcher.dispatch("read_multiple_files", {
      paths: ["src/main.ts", "README.md"],
    });
    expect(result).toContain("hello world");
    expect(result).toContain("# Test Workspace");
  });

  it("should prevent directory traversal outside workspace", async () => {
    await expect(dispatcher.dispatch("read_file", { path: "../../../etc/passwd" }))
      .rejects.toThrow("Refusing to access path outside workspace");
  });

  it("should search pattern using grep", async () => {
    const result = await dispatcher.dispatch("grep", { pattern: "hello" });
    expect(result).toContain("src/main.ts:1: console.log(\"hello world\");");
  });

  it("should run commands safely in workspace root", async () => {
    const output = await dispatcher.dispatch("run_command", { command: "git init" });
    expect(output).toContain("EXIT CODE: 0");
  });
}); */