import { describe, expect, it } from "vitest";
import { encodePath, extractLocalUrls, findSourceLine, fitScale, isHtmlPath, mergeUrls, nextRoutes, WEB_FILE, withRoute } from "./helpers";

describe("extractLocalUrls", () => {
  it("finds a Vite address, also inside colour codes", () => {
    const text = "  \u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n";
    expect(extractLocalUrls(text)).toEqual(["http://localhost:5173/"]);
  });

  it("normalizes 0.0.0.0, strips trailing punctuation, dedupes", () => {
    const text = "ready on http://0.0.0.0:3000, also http://127.0.0.1:3000/app. and http://localhost:3000 http://localhost:3000";
    expect(extractLocalUrls(text)).toEqual(["http://localhost:3000", "http://127.0.0.1:3000/app"]);
  });

  it("ignores remote hosts and ports that are not numbers", () => {
    expect(extractLocalUrls("see https://example.com:443/x and http://localhost:abc")).toEqual([]);
  });
});

describe("mergeUrls", () => {
  it("puts new addresses first without duplicates and respects the cap", () => {
    expect(mergeUrls(["a", "b"], ["c", "a"])).toEqual(["a", "c", "b"]);
    expect(mergeUrls(["a"], [])).toEqual(["a"]);
    expect(mergeUrls(["1", "2", "3"], ["4"], 3)).toEqual(["4", "1", "2"]);
  });
});

describe("findSourceLine", () => {
  const source = ["<!doctype html>", "<html>", "<body>", '  <div class="card p-4">', '    <button id="buy" class="btn">Buy</button>', "  </div>", "</body>", "</html>"].join("\n");

  it("finds the opening tag by exact text", () => {
    expect(findSourceLine(source, '<button id="buy" class="btn">Buy</button>')).toBe(5);
    expect(findSourceLine(source, '<div class="card p-4"><button>x</button></div>')).toBe(4);
  });

  it("falls back to the id, then to the first class", () => {
    expect(findSourceLine(source, '<button class="btn" id="buy" disabled="">Buy</button>')).toBe(5);
    expect(findSourceLine(source, '<div class="p-4 card" data-x="1">')).toBe(4);
  });

  it("returns null when the element is not in the source or the html is not a tag", () => {
    expect(findSourceLine(source, "<section>generated</section>")).toBeNull();
    expect(findSourceLine(source, "just text")).toBeNull();
  });
});

describe("small helpers", () => {
  it("recognizes html and web files", () => {
    expect(isHtmlPath("a/b.HTML")).toBe(true);
    expect(isHtmlPath("a.tsx")).toBe(false);
    expect(WEB_FILE.test("x/app.css")).toBe(true);
    expect(WEB_FILE.test("README.md")).toBe(false);
  });

  it("encodes each path segment", () => {
    expect(encodePath("mock/a b/ü.html")).toBe("mock/a%20b/%C3%BC.html");
  });

  it("scales a screen to fit, never above 1", () => {
    expect(fitScale(390, 844, 1000, 422)).toBeCloseTo(0.5);
    expect(fitScale(100, 100, 1000, 1000)).toBe(1);
    expect(fitScale(0, 100, 10, 10)).toBe(1);
  });
});

const f = (path: string) => ({ path, type: "file" });

describe("nextRoutes", () => {
  it("finds the pages of an App Router project like the barbershop tree", () => {
    const entries = [
      f("src/app/layout.tsx"),
      f("src/app/api/auth/login/route.ts"),
      f("src/app/api/users/route.ts"),
      f("src/app/dashboard/page.tsx"),
      f("src/app/login/page.tsx"),
      f("src/app/profile/page.tsx"),
      f("src/app/register/page.tsx"),
      f("src/app/settings/page.tsx"),
      f("src/app/users/[id]/page.tsx"),
      f("src/app/users/new/page.tsx"),
      f("src/app/users/page.tsx"),
      f("src/components/user-form.tsx"),
      f("src/generated/prisma/client.ts"),
    ];
    expect(nextRoutes(entries).map((r) => [r.route, r.dynamic])).toEqual([
      ["/dashboard", false],
      ["/login", false],
      ["/profile", false],
      ["/register", false],
      ["/settings", false],
      ["/users", false],
      ["/users/new", false],
      ["/users/[id]", true],
    ]);
  });

  it("puts / first, drops route groups, slots, intercepting and private folders", () => {
    const entries = [
      f("app/page.tsx"),
      f("app/(marketing)/about/page.tsx"),
      f("app/@modal/photo/page.tsx"),
      f("app/feed/(.)photo/page.tsx"),
      f("app/_private/page.tsx"),
      f("app/blog/[slug]/page.tsx"),
    ];
    expect(nextRoutes(entries).map((r) => r.route)).toEqual(["/", "/about", "/blog/[slug]"]);
  });

  it("reads the Pages Router, without api routes and special files", () => {
    const entries = [f("pages/index.tsx"), f("pages/about.tsx"), f("pages/blog/index.tsx"), f("pages/blog/[id].tsx"), f("pages/_app.tsx"), f("pages/api/hello.ts")];
    expect(nextRoutes(entries).map((r) => r.route)).toEqual(["/", "/about", "/blog", "/blog/[id]"]);
  });

  it("works for a monorepo app and ignores look-alike folders elsewhere", () => {
    const entries = [f("apps/web/src/app/orders/page.tsx"), f("src/components/pages/card.tsx"), f("docs/app/page.tsx")];
    expect(nextRoutes(entries).map((r) => r.route)).toEqual(["/orders"]);
  });

  it("ignores folders and returns nothing for a project without pages", () => {
    expect(nextRoutes([{ path: "src/app/x/page.tsx", type: "dir" }])).toEqual([]);
    expect(nextRoutes([f("index.html"), f("src/main.ts")])).toEqual([]);
  });
});

describe("withRoute", () => {
  it("keeps the server and replaces path, query and hash", () => {
    expect(withRoute("http://localhost:3000/login?x=1#top", "/users")).toBe("http://localhost:3000/users");
    expect(withRoute("http://127.0.0.1:5173", "/")).toBe("http://127.0.0.1:5173/");
  });

  it("returns null for something that is not an address", () => {
    expect(withRoute("not a url", "/x")).toBeNull();
  });
});
