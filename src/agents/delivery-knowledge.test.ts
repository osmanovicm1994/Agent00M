import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { maxTaskFiles, selectTaskKnowledge } from "./orchestration";
import { matchKnownFixes } from "../core/known-fixes";

const DIR = path.join(__dirname, "..", "knowledge", "13-delivery");
const read = (name: string) => fs.readFileSync(path.join(DIR, name), "utf8");
const FILES = [
  "00-roadmap.md",
  "01-git-versioning.md",
  "02-versions-2026.md",
  "03-recipe-nextjs-prisma-auth.md",
  "04-local-infra-ci.md",
  "05-known-fixes.md",
  "06-recipe-auth-rbac-nextauth.md",
  "07-recipe-ui-pages.md",
  "08-recipe-monorepo-db-package.md",
  "09-records-and-legal-documents.md",
  "10-plan-template.md",
];

const BUILD =
  "Create a new full-stack app from scratch: Next.js with Prisma on Postgres, login and registration with react-hook-form and zod, " +
  "Docker for the database, and git branches with commits and a changelog.";

describe("13-delivery knowledge files", () => {
  it("exist and stay small enough for a local model (under 7 KB each)", () => {
    for (const f of FILES) {
      const text = read(f);
      expect(text.length, f).toBeGreaterThan(1500);
      expect(text.length, f).toBeLessThan(7000);
    }
  });

  it("agree with each other on the pins that broke real runs", () => {
    const versions = read("02-versions-2026.md");
    const recipe = read("03-recipe-nextjs-prisma-auth.md");
    const fixes = read("05-known-fixes.md");
    for (const text of [versions, fixes]) expect(text).toContain("@hookform/resolvers@5");
    for (const text of [recipe, fixes]) expect(text).toContain("prisma/config");
    expect(versions).toContain("prisma@7");
    expect(versions).toContain("--use-npm");
    expect(versions).toContain("--disable-git");
    expect(recipe).toContain("process.env.DATABASE_URL ??");
    expect(recipe).toContain("<Suspense");
  });

  it("tells the agent that schema comments are // and the datasource url is gone", () => {
    const recipe = read("03-recipe-nextjs-prisma-auth.md");
    expect(recipe).toMatch(/NEVER `#`/);
    expect(recipe).toContain("no `url` in the datasource");
  });

  it("states the git and version rules", () => {
    const git = read("01-git-versioning.md");
    for (const s of ["git init -b main", "Conventional Commits", "SemVer", "CHANGELOG.md", "npm ci", ".nvmrc", "feature/", "task/"]) {
      expect(git, s).toContain(s);
    }
  });

  it("has a phase gate for every phase of the roadmap", () => {
    const roadmap = read("00-roadmap.md");
    const phases = roadmap.match(/^## Phase \d/gm) ?? [];
    const gates = roadmap.match(/^GATE:/gm) ?? [];
    expect(phases.length).toBeGreaterThanOrEqual(7);
    expect(gates.length).toBe(phases.length);
  });
});

describe("delivery knowledge reaches the right tasks", () => {
  const picks = (task: string, agent = "dev") => selectTaskKnowledge(task, agent, 40).map((p) => p.path);

  it("a from-scratch build gets the roadmap, versions and recipe, with the build protocol still first", () => {
    const all = picks(BUILD);
    for (const f of ["13-delivery/00-roadmap.md", "13-delivery/02-versions-2026.md", "13-delivery/03-recipe-nextjs-prisma-auth.md", "13-delivery/01-git-versioning.md"]) {
      expect(all, f).toContain(f);
    }
    expect(selectTaskKnowledge(BUILD, "dev")[0].path).toBe("12-fullstack/00-build-protocol.md");
  });

  it("the infra agent gets them too", () => {
    expect(picks(BUILD, "infra")).toContain("13-delivery/00-roadmap.md");
  });

  it("a Docker task gets the local infrastructure and CI file", () => {
    expect(picks("Add a docker compose file for the database", "dev")).toContain("13-delivery/04-local-infra-ci.md");
  });

  it("does not leak into unrelated tasks or agents without code", () => {
    expect(picks("rename the variable foo to bar")).toEqual([]);
    expect(picks("Create a new iOS app in SwiftUI with a login screen")).not.toContain("13-delivery/03-recipe-nextjs-prisma-auth.md");
    expect(picks(BUILD, "research")).toEqual([]);
  });

  it("keeps the file cap", () => {
    expect(maxTaskFiles()).toBe(5);
    expect(selectTaskKnowledge(BUILD, "dev")).toHaveLength(5);
  });
});

describe("recipes for accounts, roles, pages and records reach the right agents", () => {
  const picks = (task: string, agent: string) => selectTaskKnowledge(task, agent, 40).map((p) => p.path);
  const RBAC = "Implement login with NextAuth credentials; roles ADMIN and USER; a USER only sees their own rows.";

  it("the NextAuth and roles recipe goes to api, db, dev and qa tasks about accounts", () => {
    for (const agent of ["api", "db", "dev", "qa"]) expect(picks(RBAC, agent), agent).toContain("13-delivery/06-recipe-auth-rbac-nextauth.md");
    expect(picks("Implement NextAuth login", "research")).toEqual([]);
  });

  it("recognises the two roles written in capitals even without a library name", () => {
    expect(picks("Roles: ADMIN sees everything, USER only own records", "api")).toContain("13-delivery/06-recipe-auth-rbac-nextauth.md");
    expect(picks("the admin user list page", "dev")).not.toContain("13-delivery/06-recipe-auth-rbac-nextauth.md");
  });

  it("the pages recipe goes to design, dev and qa, not to the api agent", () => {
    const t = "Build the multi-step wizard, the print preview and the admin page";
    expect(picks(t, "design")).toContain("13-delivery/07-recipe-ui-pages.md");
    expect(picks(t, "api")).not.toContain("13-delivery/07-recipe-ui-pages.md");
  });

  it("the packages/db recipe loads only when the request names that layout", () => {
    expect(picks("Put the Prisma schema in packages/db and import it from apps/web", "db")).toContain("13-delivery/08-recipe-monorepo-db-package.md");
    expect(picks("Create a monorepo with a web and an api app", "dev")).not.toContain("13-delivery/08-recipe-monorepo-db-package.md");
  });

  it("the legal-records rules go to builders of agreements and invoices", () => {
    expect(picks("Store each vehicle sale agreement and its invoice", "db")).toContain("13-delivery/09-records-and-legal-documents.md");
    expect(picks("Store each vehicle sale agreement and its invoice", "research")).toEqual([]);
    expect(picks("define the API contract between the two services", "api")).not.toContain("13-delivery/09-records-and-legal-documents.md");
  });

  it("the pins in the recipes agree with the versions table", () => {
    const versions = read("02-versions-2026.md");
    const rbac = read("06-recipe-auth-rbac-nextauth.md");
    expect(versions).toContain("next-auth@4.24.15");
    expect(rbac).toContain("next-auth@4.24.15");
    expect(rbac).toContain("NO `@types/bcryptjs`");
    expect(rbac).toContain("ownerFilter");
    expect(read("07-recipe-ui-pages.md")).toContain("<Suspense");
  });

  it("the packages/db recipe says plainly that it was not built end to end", () => {
    expect(read("08-recipe-monorepo-db-package.md")).toContain("NOT built end to end");
  });
});

describe("the debug agent is small and carries the known fixes", () => {
  it("has a short prompt, a tiny thinking budget and the known-fixes standard", async () => {
    const { getAgent } = await import("./definitions");
    const debug = getAgent("debug")!;
    expect(debug.thinkingBudget).toBeLessThanOrEqual(2);
    expect(debug.systemPrompt).toContain("13-delivery/05-known-fixes.md");
    expect(debug.systemPrompt).toContain("PATCHED");
    expect(debug.systemPrompt.length).toBeLessThan(11_500);
  });

  it("the infra agent carries the known fixes and the versions table", async () => {
    const { getAgent } = await import("./definitions");
    const infra = getAgent("infra")!;
    expect(infra.systemPrompt).toContain("13-delivery/05-known-fixes.md");
    expect(infra.systemPrompt).toContain("13-delivery/02-versions-2026.md");
  });
});

describe("the matcher and the knowledge file describe the same failures", () => {
  it("every id the knowledge table covers has a matching rule for its typical output", () => {
    const samples: Array<[string, string, string]> = [
      ["npx prisma validate", "Error code: P1012\nerror: This line is not a valid field or attribute definition.\n34 |   a String   # note", "prisma-hash-comment"],
      ["npx prisma validate", "The datasource property `url` is no longer supported in schema files", "prisma7-datasource-url"],
      ["npm install zod", "npm error code ERESOLVE\nnpm error Could not resolve dependency:\nnpm error peer x", "npm-eresolve"],
      ["npx create-next-app .", 'Could not create a project called "Foo" because of npm naming restrictions', "scaffold-name"],
      ["npm run build", "Failed to fetch Geist from Google Fonts.", "next-google-fonts"],
      ["npm install bcryptjs @types/bcryptjs", "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@types%2fbcryptjs - Not found\nnpm error 404  '@types/bcryptjs@*' is not in this registry.", "types-package-404"],
      ["npm install next-auth@4.24.7", "npm error code ERESOLVE\nnpm error Could not resolve dependency:\nnpm error peer next@\"^12.2.5 || ^13 || ^14 || ^15\" from next-auth@4.24.7", "next-auth-peer-next16"],
    ];
    for (const [cmd, out, id] of samples) expect(matchKnownFixes(cmd, out).map((f) => f.id), id).toContain(id);
  });
});
