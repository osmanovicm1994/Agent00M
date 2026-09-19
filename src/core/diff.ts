import { createTwoFilesPatch } from "diff";
import pc from "picocolors";

// Renders a unified diff between old/new file content, colorized for
// terminal display, so the user can review before approving a write.
export function renderDiff(filePath: string, oldContent: string, newContent: string): string {
  const patch = createTwoFilesPatch(filePath, filePath, oldContent, newContent, "", "");
  const lines = patch.split("\n").slice(4); // drop the two "---"/"+++" header lines duplicated info
  return lines
    .map((line) => {
      if (line.startsWith("+")) return pc.green(line);
      if (line.startsWith("-")) return pc.red(line);
      if (line.startsWith("@@")) return pc.cyan(line);
      return line;
    })
    .join("\n");
}
