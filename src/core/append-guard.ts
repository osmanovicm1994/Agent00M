// src/core/append-guard.ts
//
// A local model that is asked to write a long file in chunks sometimes "continues" a file by sending it from the top again.
// append_file then glues a second (or third) copy of the file to the first, and the build fails with "Duplicate function
// implementation" or "Cannot redeclare exported variable 'default'". This pure check recognises that: the first lines of the
// chunk are already in the file, one after the other.

const significant = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

/**
 * True when the first `window` non-empty lines of `chunk` already appear, in the same order and without a line between,
 * somewhere in `existing`. Short or generic openings (closing braces, one-word lines) never count: the opening must be at
 * least `minChars` characters long.
 */
export function repeatsEarlierContent(existing: string, chunk: string, window = 4, minChars = 80): boolean {
  const c = significant(chunk);
  if (c.length < window) return false;
  const head = c.slice(0, window);
  if (head.join("\n").length < minChars) return false;
  const e = significant(existing);
  for (let i = 0; i + window <= e.length; i++) {
    if (e[i] !== head[0]) continue;
    let same = true;
    for (let k = 1; k < window; k++) {
      if (e[i + k] !== head[k]) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}
