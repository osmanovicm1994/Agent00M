import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.DS_Store',
]);

export interface GetDirectoryTreeArgs {
  rootDir?: string;
  maxDepth?: number;
}

/**
 * Tool Definition Schema for LLM tool calling
 */
export const getDirectoryTreeToolDefinition = {
  name: 'get_directory_tree',
  description: 'Returns a visual ASCII file structure tree for a given directory. Use this instead of repeated list_directory calls to inspect project layout in one go.',
  parameters: {
    type: 'object',
    properties: {
      rootDir: {
        type: 'string',
        description: 'Relative path from the current workspace root (defaults to ".")',
      },
      maxDepth: {
        type: 'integer',
        description: 'Maximum folder depth to traverse (default: 3)',
      },
    },
  },
};

/**
 * Tool Execution Handler
 */
export function getDirectoryTree(args: GetDirectoryTreeArgs = {}): string {
  const rootDir = args.rootDir ? path.resolve(process.cwd(), args.rootDir) : process.cwd();
  const maxDepth = args.maxDepth ?? 3;

  if (!fs.existsSync(rootDir)) {
    return `Error: Directory '${args.rootDir}' does not exist.`;
  }

  function renderTree(currentPath: string, depth: number, prefix: string = ''): string {
    if (depth > maxDepth) return '';

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (err: any) {
      return `${prefix} [Error reading directory: ${err.message}]\n`;
    }

    const filtered = entries.filter((e) => !DEFAULT_IGNORED.has(e.name));
    let result = '';

    filtered.forEach((entry, index) => {
      const isLast = index === filtered.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      result += `${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}\n`;

      if (entry.isDirectory() && depth < maxDepth) {
        result += renderTree(path.join(currentPath, entry.name), depth + 1, prefix + childPrefix);
      }
    });

    return result;
  }

  const baseName = path.basename(rootDir);
  return `${baseName}/\n` + renderTree(rootDir, 0);
}