// src/core/guide.ts
//
// The prompting tutorial (docs/PROMPTING.md) as text, for clients that cannot bundle it themselves (the native iOS
// app asks for it over the dashboard socket with `get_guide`). The web dashboard bundles the same file at build time.

import * as fs from "fs";
import * as path from "path";

// A guide larger than this is not a guide: refuse instead of sending a huge socket message.
const MAX_BYTES = 300 * 1024;

/** Location of the guide: <repo>/docs/PROMPTING.md, from src/core (ts-node) and dist/core (built) alike. */
export function guidePath(): string {
  return path.resolve(__dirname, "..", "..", "docs", "PROMPTING.md");
}

/** The guide text, or null when the file is missing, unreadable, empty or too large. Never throws. */
export function readGuide(file: string = guidePath()): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
