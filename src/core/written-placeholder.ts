// src/core/written-placeholder.ts
// After a file is written, the executor replaces the (large) content in the conversation history by a short note so the
// context window is not spent twice. Small models copy whatever the history shows: the old note looked like valid
// content ("[157 chars written to apps/api/tsconfig.json]") and the benchmark found it written INTO tsconfig.json,
// a controller and a Next.js page. Two defences, both here and both pure:
//   1. the note no longer looks like file content, and
//   2. write_file / append_file refuse any content that is such a note (old or new wording).

export const OMITTED_PREFIX = "(content omitted from history";

/** What the history holds instead of the content of a write_file / append_file call that already succeeded. */
export function omittedContentNote(length: number, filePath: string): string {
  return `${OMITTED_PREFIX}: ${length} chars were saved to ${filePath}. This is NOT file content: never write this text into a file. Use read_file to see the file.)`;
}

const OLD_NOTE_RE = /^\s*\[\d+ chars written to [^\]\n]*\]\s*$/;

/** True when the whole content is one of the history notes (new wording or the old bracketed one). */
export function isOmittedContentNote(content: string): boolean {
  const t = content.trim();
  return t.startsWith(OMITTED_PREFIX) || OLD_NOTE_RE.test(t);
}

/** True when a note was pasted into otherwise real content (a line that is a note). */
export function containsOmittedContentNote(content: string): boolean {
  return content.split("\n").some((l) => isOmittedContentNote(l) && l.trim() !== "");
}

export const OMITTED_CONTENT_REFUSAL =
  "TOOL ERROR: refused to write: the content is the placeholder note that the history shows for earlier writes, not real file content. " +
  "Write the complete real content of the file in the \"content\" argument.";
