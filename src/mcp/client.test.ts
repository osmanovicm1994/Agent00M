import { describe, expect, it } from "vitest";
import { expandVars, filterTools, isAutoApproved } from "./client";

describe("expandVars", () => {
  it("fills ${NAME} from the environment, leaves other text alone and uses empty for unset", () => {
    const env = { TOKEN: "abc" } as NodeJS.ProcessEnv;
    expect(expandVars("Bearer ${TOKEN}", env)).toBe("Bearer abc");
    expect(expandVars("--x=${MISSING}", env)).toBe("--x=");
    expect(expandVars("no vars $HOME {TOKEN}", env)).toBe("no vars $HOME {TOKEN}");
  });
});

describe("filterTools", () => {
  const tools = [{ name: "a" }, { name: "b" }, { name: "c" }];
  it("keeps everything without an allowlist and only the listed tools with one", () => {
    expect(filterTools(tools)).toHaveLength(3);
    expect(filterTools(tools, [])).toHaveLength(3);
    expect(filterTools(tools, ["b", "zzz"]).map((t) => t.name)).toEqual(["b"]);
  });
});

describe("isAutoApproved", () => {
  it("honours the whole-server flag and the per-tool list", () => {
    expect(isAutoApproved({ command: "x", autoApprove: true }, "any")).toBe(true);
    expect(isAutoApproved({ command: "x", autoApproveTools: ["snap"] }, "snap")).toBe(true);
    expect(isAutoApproved({ command: "x", autoApproveTools: ["snap"] }, "click")).toBe(false);
    expect(isAutoApproved({ command: "x" }, "snap")).toBe(false);
  });
});
