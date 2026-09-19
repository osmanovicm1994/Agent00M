import * as fs from "fs";
import * as path from "path";
import type { ToolSchema } from "../llm/types";

// All filesystem tools are scoped to a single "workspace root" (the target
// project directory the CLI was invoked against) to prevent an agent from
// reading/writing outside the project it's supposed to be working on.

export class FsTools {
  constructor(private readonly workspaceRoot: string) {}

  private resolve(relativePath: string): string {
    const full = path.resolve(this.workspaceRoot, relativePath);
    if (!full.startsWith(path.resolve(this.workspaceRoot))) {
      throw new Error(`Refusing to access path outside workspace: ${relativePath}`);
    }
    return full;
  }

  readFile(relativePath: string): string {
    const full = this.resolve(relativePath);
    if (!fs.existsSync(full)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return fs.readFileSync(full, "utf8");
  }

  listDirectory(relativeDirPath: string = "."): Array<{ name: string; isDirectory: boolean }> {
    const full = this.resolve(relativeDirPath);
    if (!fs.existsSync(full)) {
      throw new Error(`Directory not found: ${relativeDirPath}`);
    }
    return fs.readdirSync(full, { withFileTypes: true }).map((item) => ({
      name: item.name,
      isDirectory: item.isDirectory(),
    }));
  }

  // Returns the proposed new full-file content without writing it. The
  // executor is responsible for diffing this against the current content
  // and asking for approval before calling `commitWrite`.
  fileExists(relativePath: string): boolean {
    return fs.existsSync(this.resolve(relativePath));
  }

  commitWrite(relativePath: string, content: string): void {
    const full = this.resolve(relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

export const fsToolSchemas: ToolSchema[] = [
  {
    name: "read_file",
    description: "Read the full contents of a file, relative to the project root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "List files and subdirectories at a given path relative to the project root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root. Defaults to root." },
      },
    },
  },
  {
    name: "write_file",
    description:
      "Propose writing/overwriting a file with new full content. This does NOT apply immediately — the user is shown a diff and must approve it first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root" },
        content: { type: "string", description: "The full new content of the file" },
      },
      required: ["path", "content"],
    },
  },
];
