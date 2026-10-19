import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { checkStyling, runStyleCheck, tailwindMajor } from "./styles.tool";

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "styles-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "x", dependencies: { next: "16.0.0", ...deps } });
const LAYOUT = 'import "./globals.css";\nexport default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n';
const ids = (root: string, level: string) => checkStyling(root).filter((r) => r.level === level).map((r) => r.id);

describe("tailwindMajor", () => {
  it("reads the major from a range", () => {
    expect(tailwindMajor("^4.1.2")).toBe(4);
    expect(tailwindMajor("3.4.1")).toBe(3);
    expect(tailwindMajor("latest")).toBeNull();
    expect(tailwindMajor(undefined)).toBeNull();
  });
});

describe("checkStyling: Tailwind 4", () => {
  it("passes a correct Next.js setup", () => {
    const root = project({
      "package.json": pkg({ tailwindcss: "^4", "@tailwindcss/postcss": "^4" }),
      "postcss.config.mjs": 'export default { plugins: { "@tailwindcss/postcss": {} } };',
      "src/app/globals.css": '@import "tailwindcss";\n:root { --bg: #fff; }',
      "src/app/layout.tsx": LAYOUT,
    });
    expect(ids(root, "fail")).toEqual([]);
  });

  it("fails when postcss.config is missing (the unstyled-page case)", () => {
    const root = project({
      "package.json": pkg({ tailwindcss: "^4", "@tailwindcss/postcss": "^4" }),
      "src/app/globals.css": '@import "tailwindcss";',
      "src/app/layout.tsx": LAYOUT,
    });
    expect(ids(root, "fail")).toContain("tw4-postcss-config");
  });

  it("fails when the plugin package is not installed at all", () => {
    const root = project({
      "package.json": pkg({ tailwindcss: "^4" }),
      "src/app/globals.css": '@import "tailwindcss";',
      "src/app/layout.tsx": LAYOUT,
    });
    expect(ids(root, "fail")).toContain("tw4-plugin");
  });

  it("fails when postcss still uses tailwindcss as the plugin (v3 style)", () => {
    const root = project({
      "package.json": pkg({ tailwindcss: "^4", "@tailwindcss/postcss": "^4" }),
      "postcss.config.js": "module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };",
      "src/app/globals.css": '@import "tailwindcss";',
      "src/app/layout.tsx": LAYOUT,
    });
    expect(ids(root, "fail")).toContain("tw4-postcss-config");
  });

  it("fails on v3 directives and on a missing import", () => {
    const root = project({
      "package.json": pkg({ tailwindcss: "^4", "@tailwindcss/postcss": "^4" }),
      "postcss.config.mjs": 'export default { plugins: { "@tailwindcss/postcss": {} } };',
      "src/app/globals.css": "@tailwind base;\n@tailwind components;\n@tailwind utilities;",
      "src/app/layout.tsx": LAYOUT,
    });
    const fails = ids(root, "fail");
    expect(fails).toContain("tw4-v3-directives");
    expect(fails).toContain("tw4-css-import");
  });

  it("fails when the layout does not import the stylesheet", () => {
    const root = project({
      "package.json": pkg({ tailwindcss: "^4", "@tailwindcss/postcss": "^4" }),
      "postcss.config.mjs": 'export default { plugins: { "@tailwindcss/postcss": {} } };',
      "src/app/globals.css": '@import "tailwindcss";',
      "src/app/layout.tsx": "export default function L({ children }) { return children; }",
    });
    expect(ids(root, "fail")).toContain("css-linked");
  });

  it("warns that tailwind.config.ts is ignored without @config", () => {
    const root = project({
      "package.json": pkg({ tailwindcss: "^4", "@tailwindcss/postcss": "^4" }),
      "postcss.config.mjs": 'export default { plugins: { "@tailwindcss/postcss": {} } };',
      "tailwind.config.ts": "export default { content: [] };",
      "src/app/globals.css": '@import "tailwindcss";',
      "src/app/layout.tsx": LAYOUT,
    });
    expect(ids(root, "warn")).toContain("tw4-config-ignored");
    expect(ids(root, "fail")).toEqual([]);
  });

  it("accepts the Vite plugin and finds it missing from vite.config", () => {
    const base = {
      "package.json": JSON.stringify({ devDependencies: { tailwindcss: "^4", "@tailwindcss/vite": "^4", vite: "^6" } }),
      "src/index.css": '@import "tailwindcss";',
      "src/main.tsx": 'import "./index.css";',
    };
    expect(ids(project({ ...base, "vite.config.ts": 'import tailwindcss from "@tailwindcss/vite"; export default { plugins: [tailwindcss()] };' }), "fail")).toEqual([]);
    expect(ids(project({ ...base, "vite.config.ts": "export default { plugins: [] };" }), "fail")).toContain("tw4-vite-config");
  });
});

describe("checkStyling: Tailwind 3, builds and monorepos", () => {
  it("passes a correct v3 setup and fails a missing content list", () => {
    const files = {
      "package.json": pkg({ tailwindcss: "^3.4.0", postcss: "^8", autoprefixer: "^10" }),
      "postcss.config.js": "module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };",
      "src/app/globals.css": "@tailwind base;\n@tailwind components;\n@tailwind utilities;",
      "src/app/layout.tsx": LAYOUT,
    };
    expect(ids(project({ ...files, "tailwind.config.ts": 'export default { content: ["./src/**/*.{ts,tsx}"] };' }), "fail")).toEqual([]);
    expect(ids(project({ ...files, "tailwind.config.ts": "export default { theme: {} };" }), "fail")).toContain("tw3-content");
  });

  it("checks apps in a monorepo", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "root" }),
      "apps/web/package.json": pkg({ tailwindcss: "^4", "@tailwindcss/postcss": "^4" }),
      "apps/web/src/app/globals.css": '@import "tailwindcss";',
      "apps/web/src/app/layout.tsx": LAYOUT,
    });
    const r = checkStyling(root).find((x) => x.id === "tw4-postcss-config");
    expect(r?.level).toBe("fail");
    expect(r?.message).toContain("apps");
  });

  it("uses the last build's CSS as evidence", () => {
    const ok = {
      "package.json": pkg({ tailwindcss: "^4", "@tailwindcss/postcss": "^4" }),
      "postcss.config.mjs": 'export default { plugins: { "@tailwindcss/postcss": {} } };',
      "src/app/globals.css": '@import "tailwindcss";',
      "src/app/layout.tsx": LAYOUT,
    };
    expect(ids(project({ ...ok, ".next/static/css/a.css": "/*! tailwindcss v4.1.0 */ .flex{display:flex}" }), "fail")).toEqual([]);
    expect(ids(project({ ...ok, ".next/static/css/a.css": 'body{color:red}@import "tailwindcss";' }), "fail")).toContain("built-css");
  });

  it("says plainly when there is no Tailwind", () => {
    const root = project({ "package.json": pkg({}) });
    expect(ids(root, "warn")).toContain("tailwind");
  });

  it("the tool text states what it did not verify", () => {
    const text = runStyleCheck(project({ "package.json": pkg({}) }));
    expect(text).toContain("NOT verified");
    expect(text).not.toMatch(/looks good/i);
  });
});
