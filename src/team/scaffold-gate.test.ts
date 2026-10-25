import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describeStarter, findStarterContent, hasStarterMetadata, isStarterPage, starterFixTask } from "./scaffold-gate";

let root: string;
const write = (rel: string, text: string) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const NEXT_PKG = JSON.stringify({ dependencies: { next: "16.4.3", react: "19.3.0" } });
const STARTER = `export default function Home() { return <p>To get started, edit the page.tsx file.</p>; }`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-gate-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("starter detection", () => {
  it("knows the generated home page texts", () => {
    expect(isStarterPage("To get started, edit the page.tsx file")).toBe(true);
    expect(isStarterPage("Looking for a starting point or more instructions")).toBe(true);
    expect(isStarterPage('<img src="/next.svg" /> Deploy now Read our docs')).toBe(true);
    expect(isStarterPage("export default function Login() { return <form/>; }")).toBe(false);
  });

  it("knows the generated title", () => {
    expect(hasStarterMetadata('export const metadata = { title: "Create Next App" }')).toBe(true);
    expect(hasStarterMetadata('export const metadata = { title: "Ugovori" }')).toBe(false);
  });
});

describe("findStarterContent", () => {
  it("finds the starter page in apps/web as blocking and the title as non-blocking", () => {
    write("apps/web/package.json", NEXT_PKG);
    write("apps/web/src/app/page.tsx", STARTER);
    write("apps/web/src/app/layout.tsx", 'export const metadata = { title: "Create Next App" };');
    const found = findStarterContent(root);
    expect(found.find((f) => f.file === "apps/web/src/app/page.tsx")?.blocking).toBe(true);
    expect(found.find((f) => f.file === "apps/web/src/app/layout.tsx")?.blocking).toBe(false);
    expect(describeStarter(found)).toContain("apps/web/src/app/page.tsx");
    expect(starterFixTask(found)).toContain("Replace it now");
  });

  it("finds nothing once the page was replaced", () => {
    write("apps/web/package.json", NEXT_PKG);
    write("apps/web/src/app/page.tsx", "import { redirect } from 'next/navigation'; export default function Home() { redirect('/login'); }");
    write("apps/web/src/app/layout.tsx", 'export const metadata = { title: "Ugovori" };');
    expect(findStarterContent(root)).toEqual([]);
  });

  it("ignores folders that are not Next.js apps", () => {
    write("other/package.json", JSON.stringify({ dependencies: { express: "5" } }));
    write("other/src/app/page.tsx", STARTER);
    expect(findStarterContent(root)).toEqual([]);
  });

  it("also finds an app in the workspace root", () => {
    write("package.json", NEXT_PKG);
    write("app/page.tsx", STARTER);
    expect(findStarterContent(root).map((f) => f.file)).toEqual(["app/page.tsx"]);
  });
});
