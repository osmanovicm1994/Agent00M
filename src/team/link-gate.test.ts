import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extractLinks, findDeadLinks, linkFixTask, routeMatches } from "./link-gate";

let root: string;

function put(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "link-gate-"));
  put("apps/web/package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("extractLinks", () => {
  it("finds href attributes, href properties and navigation calls", () => {
    const text = `
      <Link href="/listings">All</Link>
      <a href={"/login"}>Login</a>
      const items = [{ href: "/admin", label: "Admin" }];
      router.push("/register");
      redirect('/');
    `;
    expect(extractLinks(text).sort()).toEqual(["/", "/admin", "/listings", "/login", "/register"]);
  });

  it("ignores external links, assets, template strings and query/hash parts", () => {
    const text = `
      <a href="https://example.com">x</a>
      <a href="//cdn.example.com">x</a>
      <img src="/logo.svg" /><a href="/logo.svg">x</a>
      <Link href={\`/listings/\${id}\`}>x</Link>
      <Link href="/search?q=a#top">x</Link>
    `;
    expect(extractLinks(text)).toEqual(["/search"]);
  });
});

describe("routeMatches", () => {
  it("matches static, dynamic and catch-all segments", () => {
    expect(routeMatches(["listings", "[id]"], ["listings", "42"])).toBe(true);
    expect(routeMatches(["listings"], ["listings", "42"])).toBe(false);
    expect(routeMatches([], [])).toBe(true);
    expect(routeMatches(["docs", "[...slug]"], ["docs", "a", "b"])).toBe(true);
    expect(routeMatches(["docs", "[...slug]"], ["docs"])).toBe(false);
    expect(routeMatches(["docs", "[[...slug]]"], ["docs"])).toBe(true);
  });
});

describe("findDeadLinks", () => {
  it("reports links without a page", () => {
    put("apps/web/src/app/page.tsx", `export default () => (<nav><a href="/listings">L</a><a href="/login">Login</a></nav>);`);
    put("apps/web/src/app/login/page.tsx", `export default () => null;`);
    const report = findDeadLinks(root);
    expect(report.dead).toEqual([{ file: "apps/web/src/app/page.tsx", target: "/listings" }]);
    expect(report.routes).toEqual(["/", "/login"]);
  });

  it("accepts routes inside route groups and dynamic routes", () => {
    put("apps/web/src/app/page.tsx", `export default () => (<a href="/listings/12">x</a>);`);
    put("apps/web/src/app/(shop)/listings/[id]/page.tsx", `export default () => null;`);
    expect(findDeadLinks(root).dead).toEqual([]);
  });

  it("accepts a link to an API route handler and to a public file", () => {
    put("apps/web/src/app/page.tsx", `export default () => (<a href="/api/listings">x</a>);`);
    put("apps/web/src/app/api/listings/route.ts", `export async function GET() {}`);
    expect(findDeadLinks(root).dead).toEqual([]);
  });

  it("does not scan test files", () => {
    put("apps/web/src/app/page.tsx", `export default () => null;`);
    put("apps/web/src/app/page.test.tsx", `const x = '<a href="/nowhere">';`);
    expect(findDeadLinks(root).dead).toEqual([]);
  });

  it("builds a repair task that names the missing targets", () => {
    put("apps/web/src/app/page.tsx", `export default () => (<a href="/admin">x</a>);`);
    const task = linkFixTask(findDeadLinks(root));
    expect(task).toContain("/admin");
    expect(task).toContain("404");
  });
});
