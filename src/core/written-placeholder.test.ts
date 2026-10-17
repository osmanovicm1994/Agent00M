import { describe, it, expect } from "vitest";
import { containsOmittedContentNote, isOmittedContentNote, omittedContentNote } from "./written-placeholder";

describe("history placeholder for written content", () => {
  it("recognises its own note and the old bracketed note", () => {
    expect(isOmittedContentNote(omittedContentNote(157, "apps/api/tsconfig.json"))).toBe(true);
    expect(isOmittedContentNote("[157 chars written to apps/api/tsconfig.json]")).toBe(true);
    expect(isOmittedContentNote("[157 chars written to apps/api/tsconfig.json]\n")).toBe(true);
  });

  it("does not look like content a model would imitate", () => {
    expect(omittedContentNote(10, "a.ts").startsWith("[")).toBe(false);
    expect(omittedContentNote(10, "a.ts")).toContain("NOT file content");
  });

  it("lets real content through, including JSON arrays and prose about characters", () => {
    expect(isOmittedContentNote('{"compilerOptions":{}}')).toBe(false);
    expect(isOmittedContentNote("[1, 2, 3]")).toBe(false);
    expect(isOmittedContentNote("export const x = '[5 chars written to y]';")).toBe(false);
    expect(containsOmittedContentNote("import a from 'a';\nexport const a = 1;\n")).toBe(false);
  });

  it("finds a note pasted as a line of real content", () => {
    expect(containsOmittedContentNote("import a from 'a';\n[102 chars written to src/x.ts]\nexport const a = 1;")).toBe(true);
  });
});
