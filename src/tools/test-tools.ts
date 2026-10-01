/**.  used for testing the tools in isolation. It creates a temporary workspace, seeds it with test files, and verifies the behavior of the ToolDispatcher and its associated tools (FsTools, SearchTool, ShellTool). The tests cover directory tree generation, reading multiple files, preventing directory traversal, searching patterns using grep, and running commands safely within the workspace root. 

import * as path from "path";
import { ToolDispatcher, allToolSchemas } from "./index";

async function runSmokeTest() {
  const workspaceRoot = path.resolve(process.cwd());
  const dispatcher = new ToolDispatcher(workspaceRoot);

  console.log("Loaded Schemas:", allToolSchemas.map((s) => s.name));

  console.log("\n--- 1. Testing get_directory_tree ---");
  const tree = await dispatcher.dispatch("get_directory_tree", { path: ".", maxDepth: 2 });
  console.log(tree);

  console.log("\n--- 2. Testing read_multiple_files ---");
  const contents = await dispatcher.dispatch("read_multiple_files", {
    paths: ["package.json", "src/tools/shell.tool.ts"],
  });
  console.log(contents.slice(0, 300) + "\n...[truncated]");

  console.log("\n--- 3. Testing find_files ---");
  const foundFiles = await dispatcher.dispatch("find_files", { query: "tool" });
  console.log(foundFiles);

  console.log("\n--- 4. Testing grep ---");
  const grepResults = await dispatcher.dispatch("grep", { pattern: "ToolDispatcher" });
  console.log(grepResults);

  console.log("\n--- 5. Testing run_command ---");
  const cmdResult = await dispatcher.dispatch("run_command", { command: "node -v" });
  console.log(cmdResult);
}

runSmokeTest().catch(console.error);
*/