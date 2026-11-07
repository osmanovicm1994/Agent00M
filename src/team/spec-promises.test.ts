import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { checklistBlock, detectLayout, expandBraces, extractPromises, layoutBlock, layoutViolation, missingPromises, promiseFixTask } from "./spec-promises";

let root: string;
const put = (rel: string, text = "x"): void => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "promises-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const SPEC = [
  "Single app at repository root (do not create `apps/web` unless this repository is already a monorepo).",
  "",
  "```text",
  "src/",
  "  app/",
  "    (customer)/                 # public/customer site; own layout and navigation",
  "      page.tsx",
  "      services/page.tsx",
  "      book/page.tsx",
  "    admin/                       # private admin site",
  "      layout.tsx",
  "      login/page.tsx",
  "      page.tsx                    # dashboard",
  "    api/",
  "      auth/{register,login,logout,session}/route.ts",
  "      bookings/[bookingId]/route.ts",
  "      admin/{bookings,services,opening-hours}/route.ts",
  "  components/",
  "    customer/",
  "    admin/",
  "  lib/",
  "    db.ts",
  "    env.ts",
  "prisma/",
  "  schema.prisma",
  "  migrations/",
  "  seed.ts",
  "```",
  "",
  "- `POST /api/auth/register` body `{name}` → 201.",
  "- `GET /api/availability?serviceId=...&date=YYYY-MM-DD` → slots.",
  "- `PATCH /api/admin/services/:id` and `GET /api/admin/dashboard?date=YYYY-MM-DD`.",
].join("\n");

describe("detectLayout", () => {
  it("reads the repository root from the request", () => {
    expect(detectLayout(SPEC)).toBe("root");
    expect(detectLayout("Do not create apps/web, put the app at the project root")).toBe("root");
    expect(layoutBlock("root")).toContain("Do NOT create apps/web");
  });
  it("reads apps/web and says nothing when the request names no layout", () => {
    expect(detectLayout("Build the app in apps/web with Prisma")).toBe("apps-web");
    expect(detectLayout("Build a barbershop app")).toBeNull();
    expect(layoutBlock(null)).toBe("");
  });
});

describe("extractPromises", () => {
  it("expands braces", () => {
    expect(expandBraces("auth/{a,b}/route.ts")).toEqual(["auth/a/route.ts", "auth/b/route.ts"]);
    expect(expandBraces("x/route.ts")).toEqual(["x/route.ts"]);
  });

  it("reads the file tree with its indentation, comments and braces", () => {
    const p = extractPromises(SPEC);
    expect(p.files).toEqual(
      expect.arrayContaining([
        "src/app/(customer)/page.tsx",
        "src/app/(customer)/services/page.tsx",
        "src/app/admin/layout.tsx",
        "src/app/admin/login/page.tsx",
        "src/app/admin/page.tsx",
        "src/app/api/auth/login/route.ts",
        "src/app/api/auth/session/route.ts",
        "src/app/api/bookings/[bookingId]/route.ts",
        "src/app/api/admin/opening-hours/route.ts",
        "src/lib/db.ts",
        "prisma/schema.prisma",
        "prisma/seed.ts",
      ]),
    );
    expect(p.files).not.toContain("src/app/page.tsx");
    expect(p.dirs).toEqual(expect.arrayContaining(["src/components/customer/", "src/components/admin/", "prisma/migrations/"]));
    expect(p.dirs).not.toContain("src/app/");
  });

  it("collects endpoints without query strings", () => {
    const p = extractPromises(SPEC);
    expect(p.endpoints).toEqual(["GET /api/admin/dashboard", "GET /api/availability", "PATCH /api/admin/services/:id", "POST /api/auth/register"]);
  });

  it("ignores code blocks that are not project trees", () => {
    expect(extractPromises("```prisma\nmodel User {\n  id String\n}\n```").files).toEqual([]);
  });

  it("builds a checklist for the planner, empty when the spec lists nothing", () => {
    expect(checklistBlock(extractPromises(SPEC))).toContain("src/app/admin/page.tsx");
    expect(checklistBlock({ files: [], dirs: [], endpoints: [] })).toBe("");
  });
});

describe("missingPromises", () => {
  it("lists what the disk does not have and accepts what it does", () => {
    const p = extractPromises(SPEC);
    put("src/app/(customer)/page.tsx");
    put("src/app/admin/page.tsx");
    put("src/lib/db.ts");
    put("src/app/api/auth/register/route.ts");
    put("src/app/api/admin/services/route.ts");
    put("src/app/api/availability/route.ts");
    const missing = missingPromises(root, p, "root");
    expect(missing).toContain("file src/app/admin/layout.tsx");
    expect(missing).toContain("file prisma/seed.ts");
    expect(missing).toContain("endpoint GET /api/admin/dashboard");
    expect(missing).not.toContain("file src/lib/db.ts");
    expect(missing).not.toContain("endpoint POST /api/auth/register");
    expect(missing).not.toContain("endpoint PATCH /api/admin/services/:id"); // served by services/route.ts
    expect(missing).not.toContain("endpoint GET /api/availability");
  });

  it("accepts another code extension and a dynamic folder for :id", () => {
    put("src/app/admin/page.jsx");
    put("src/app/api/admin/services/[id]/route.js");
    const missing = missingPromises(root, { files: ["src/app/admin/page.tsx"], dirs: [], endpoints: ["PATCH /api/admin/services/:id"] }, "root");
    expect(missing).toEqual([]);
  });

  it("with the root layout, an app under apps/web does not count", () => {
    put("apps/web/src/lib/db.ts");
    expect(missingPromises(root, { files: ["src/lib/db.ts"], dirs: [], endpoints: [] }, "root")).toEqual(["file src/lib/db.ts"]);
    expect(missingPromises(root, { files: ["src/lib/db.ts"], dirs: [], endpoints: [] }, "apps-web")).toEqual([]);
  });

  it("reports an app scaffolded under apps/ when the request says root", () => {
    put("apps/web/package.json", "{}");
    expect(layoutViolation(root, "root")).toContain("apps/web");
    expect(layoutViolation(root, "apps-web")).toBeNull();
    put("package.json", "{}");
    expect(layoutViolation(root, "root")).toBeNull();
  });
});

describe("promiseFixTask", () => {
  it("names the most important items first and says how many follow", () => {
    const text = promiseFixTask(Array.from({ length: 20 }, (_, i) => `file f${i}.ts`), "root", 1, 5);
    expect(text).toContain("20 missing");
    expect(text).toContain("- file f0.ts");
    expect(text).not.toContain("- file f5.ts");
    expect(text).toContain("15 more follow");
    expect(text).toContain("Do not create apps/web");
  });
});
