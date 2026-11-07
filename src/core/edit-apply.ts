// src/core/edit-apply.ts
//
// The text change behind the edit_file tool: replace one exact piece of a file with another. Pure (no I/O), so it is
// unit-tested (edit-apply.test.ts). The executor reads the file, calls applyEdit(), and sends the result through the same
// write path as write_file, so every write gate (approval, placeholder check, package.json guard) still applies.
//
// Why a tool for this: with write_file alone, changing one line means sending the whole file again. A local model that
// does that drops code, loses its place in long files and burns tokens. A precise edit changes only what it names.

export type EditResult =
  | { ok: true; content: string; replaced: number; firstLine: number }
  | { ok: false; error: string };

const norm = (s: string): string => s.replace(/\r\n/g, "\n");

/** 1-based line number of the character offset `index`. */
function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Every start offset of `needle` in `text` (non-overlapping). */
function offsetsOf(text: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i === -1) return out;
    out.push(i);
    from = i + needle.length;
  }
}

const trimEndLines = (s: string): string => s.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n");

/** A hint for a missing match: where the first line of the wanted text appears, if anywhere (ignoring indentation). */
function nearestHint(content: string, oldStr: string): string {
  const first = oldStr.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return "";
  const lines = content.split("\n");
  const at = lines.findIndex((l) => l.trim() === first);
  if (at !== -1) {
    return ` The first line of old_string does appear at line ${at + 1} as:\n${lines[at]}\nCopy the lines EXACTLY from read_file (same indentation and spacing), without the "N:" line-number prefix.`;
  }
  const part = lines.findIndex((l) => l.includes(first.slice(0, Math.min(first.length, 40))));
  if (part !== -1) return ` Something similar is on line ${part + 1}:\n${lines[part]}\nRe-read the file and copy the text exactly.`;
  return " Nothing like it is in the file. Re-read the file with read_file; the text you want to change may have moved or may not exist.";
}

/**
 * Replaces `oldStr` with `newStr` in `content`.
 *  - old_string must match exactly once (or `replaceAll` must be set): an ambiguous edit is refused, never guessed.
 *  - Line endings are compared as \n. Trailing spaces at the end of a line are ignored when matching.
 */
export function applyEdit(content: string, oldStr: string, newStr: string, replaceAll = false): EditResult {
  if (typeof oldStr !== "string" || oldStr === "") {
    return { ok: false, error: "edit_file requires a non-empty old_string: the exact text to replace. To create a file or replace all of it, use write_file." };
  }
  if (typeof newStr !== "string") return { ok: false, error: 'edit_file requires "new_string" (use an empty string to delete the old text).' };

  const text = norm(content);
  const oldN = norm(oldStr);
  const newN = norm(newStr);
  if (oldN === newN) return { ok: false, error: "old_string and new_string are identical: nothing would change. Decide what must actually change, or finish." };

  let hits = offsetsOf(text, oldN);
  let haystack = text;
  let needle = oldN;

  // Second chance: a model often adds or drops trailing spaces. Match with those ignored on both sides.
  if (hits.length === 0) {
    const t2 = trimEndLines(text);
    const o2 = trimEndLines(oldN);
    const h2 = offsetsOf(t2, o2);
    if (h2.length > 0) {
      hits = h2;
      haystack = t2;
      needle = o2;
    }
  }

  if (hits.length === 0) {
    return { ok: false, error: `edit_file: old_string was not found in the file.${nearestHint(text, oldN)}` };
  }
  if (hits.length > 1 && !replaceAll) {
    const where = hits.slice(0, 6).map((h) => lineAt(haystack, h)).join(", ");
    return {
      ok: false,
      error:
        `edit_file: old_string matches ${hits.length} places (lines ${where}${hits.length > 6 ? ", ..." : ""}), so it is not clear which one to change. ` +
        "Add the lines around the one you mean to old_string until it is unique, or set replace_all to true to change every match.",
    };
  }

  // Replace from the end so earlier offsets stay valid.
  let out = haystack;
  const firstLine = lineAt(haystack, hits[0]);
  for (const h of [...hits].reverse()) out = out.slice(0, h) + newN + out.slice(h + needle.length);
  return { ok: true, content: out, replaced: hits.length, firstLine };
}
