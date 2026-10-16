import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Bm25, buildBrief, designSearchSchema, findDataDir, loadDesignSystem, parseCsv, runDesignSearch, tokenize } from "./design-search.tool";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "design-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

function fixture(): string {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "stacks"));
  fs.writeFileSync(
    path.join(dir, "styles.csv"),
    [
      "Style ID,Style Category,Aliases,Keywords,Best For,Type,AI Prompt Keywords,Primary Colors,Effects & Animation,Do Not Use For,Accessibility,CSS/Technical Keywords,Design System Variables,Status",
      'glass,Glassmorphism,Glass,"frosted, blur, translucent, modern","SaaS, fintech dashboards",General,blur layers,"White, blue",blur 12px,"Print",risk:medium,backdrop-filter: blur,--blur: 12px,active',
      'old,Skeuomorphism,,"leather, texture","Nostalgia",General,texture,Brown,none,Everything,risk:low,textures,--x: 1,deprecated',
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "products.csv"),
    [
      "No,Product Type,Keywords,Primary Style Recommendation,Secondary Styles,Landing Page Pattern,Dashboard Style (if applicable),Color Palette Focus,Key Considerations",
      '1,Fintech App,"bank, money, fintech, payments",Glassmorphism + Flat Design,Minimalism,Hero + Features + CTA,Data-Dense,Trust blue,"Security first, clear numbers."',
      '2,Beauty Spa,"spa, beauty, salon, booking",Soft UI,Minimalism,Hero + Booking,n/a,Pastel,Calm and elegant.',
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "colors.csv"),
    [
      "No,Product Type,Primary,On Primary,Secondary,On Secondary,Accent,On Accent,Background,Foreground,Card,Card Foreground,Muted,Muted Foreground,Border,Destructive,On Destructive,Ring,Notes",
      "1,Fintech App,#0B5FFF,#FFFFFF,#3B82F6,#000000,#16A34A,#000000,#F8FAFC,#0F172A,#FFFFFF,#0F172A,#E2E8F0,#475569,#CBD5E1,#DC2626,#FFFFFF,#0B5FFF,Trust blue + green",
      "2,Beauty Spa,#E8B4B8,#000000,#F5E1E3,#000000,#B08968,#000000,#FFF8F6,#3B2F2F,#FFFFFF,#3B2F2F,#F3E7E4,#6B5B5B,#EAD7D3,#DC2626,#FFFFFF,#E8B4B8,Soft rose",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "typography.csv"),
    [
      "No,Font Pairing Name,Category,Heading Font,Body Font,Mood/Style Keywords,Best For,Google Fonts URL,CSS Import,Tailwind Config,Notes",
      '1,Modern Professional,Sans + Sans,Poppins,Open Sans,"modern, professional, clean","SaaS, fintech, startups",https://x,@import url(x);,"fontFamily: { heading: [Poppins] }",Readable',
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "landing.csv"),
    [
      "Pattern ID,Pattern Name,Aliases,Keywords,Section Order,Primary CTA Placement,Color Strategy,Conversion Optimization",
      'hero,Hero + Features + CTA,,"hero, features, cta","1. Hero, 2. Features, 3. CTA",Above the fold,Contrast CTA,Single clear action',
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "ux-guidelines.csv"),
    [
      "No,Category,Issue,Platform,Description,Do,Don't,Code Example Good,Code Example Bad,Severity",
      "1,Accessibility,Focus states,Web,Keyboard users need visible focus,Use focus-visible rings,Remove outlines,x,y,High",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "stacks", "nextjs.csv"),
    [
      "No,Category,Guideline,Description,Do,Don't,Code Good,Code Bad,Severity,Docs URL,Applies To,Status,Verified At",
      "1,Routing,Use server components,Fetch data on the server,Keep client components small,Mark everything use client,const x = 1,const y = 2,High,u,a,active,d",
      "2,Routing,Pages router getServerSideProps,Legacy data loading,Migrate,Keep,old,old,Low,u,a,deprecated,d",
    ].join("\n"),
  );
  return dir;
}

describe("parseCsv", () => {
  it("handles quoted commas, doubled quotes, line breaks in quotes, CRLF and a BOM", () => {
    const rows = parseCsv('﻿a,b\r\n1,"x, y"\r\n2,"say ""hi""\nthere"\r\n');
    expect(rows).toEqual([
      { a: "1", b: "x, y" },
      { a: "2", b: 'say "hi"\nthere' },
    ]);
  });
});

describe("Bm25", () => {
  it("ranks the matching document first and ignores unknown words", () => {
    const b = new Bm25(["frosted glass blur", "leather texture", "flat clean minimal"]);
    expect(b.rank("blur glass")[0].index).toBe(0);
    expect(b.rank("zzzz")).toEqual([]);
    expect(tokenize("E-commerce a11y")).toEqual(["ecommerce", "accessibility"]);
  });
});

describe("runDesignSearch", () => {
  it("builds a brief with product fit, style, colour tokens, typography and page pattern", () => {
    const out = runDesignSearch({ query: "fintech payments dashboard" }, fixture());
    expect(out).toContain("Fintech App");
    expect(out).toContain("Glassmorphism");
    expect(out).toContain("Primary #0B5FFF");
    expect(out).toContain("Heading: Poppins");
    expect(out).toContain("Hero + Features + CTA");
    expect(out).toContain("design-system/MASTER.md");
  });

  it("searches one domain and never returns deprecated styles", () => {
    const dir = fixture();
    expect(runDesignSearch({ query: "frosted blur", domain: "style" }, dir)).toContain("Glassmorphism");
    expect(runDesignSearch({ query: "leather texture", domain: "style" }, dir)).toContain("No match");
    expect(runDesignSearch({ query: "keyboard focus", domain: "ux" }, dir)).toContain("Focus states");
  });

  it("searches a stack, hides deprecated rows unless asked, and lists stacks for an unknown one", () => {
    const dir = fixture();
    expect(runDesignSearch({ query: "server components data", stack: "nextjs" }, dir)).toContain("Use server components");
    expect(runDesignSearch({ query: "getServerSideProps", stack: "nextjs" }, dir)).not.toContain("Legacy data loading");
    expect(runDesignSearch({ query: "getServerSideProps legacy", stack: "nextjs" }, dir)).toContain("Legacy data loading");
    expect(runDesignSearch({ query: "x", stack: "cobol" }, dir)).toContain("Available: nextjs");
    expect(runDesignSearch({ query: "x", stack: "../etc" }, dir)).toContain("unknown stack");
  });

  it("skips the page pattern when the product has no landing page", () => {
    const dir = fixture();
    const products = path.join(dir, "products.csv");
    fs.writeFileSync(
      products,
      [
        "No,Product Type,Keywords,Primary Style Recommendation,Secondary Styles,Landing Page Pattern,Dashboard Style (if applicable),Color Palette Focus,Key Considerations",
        '1,Fintech Dashboard,"fintech, dashboard",Glassmorphism,Minimalism,N/A - Dashboard focused,Data-Dense,Trust blue,Accuracy.',
      ].join("\n"),
    );
    const out = buildBrief(dir, "fintech dashboard");
    expect(out).toContain("Fintech Dashboard");
    expect(out).not.toContain("## Page pattern");
  });

  it("reports bad input and a missing catalog without throwing", () => {
    expect(runDesignSearch({ query: " " }, fixture())).toContain("TOOL ERROR");
    expect(runDesignSearch({ query: "x", domain: "nope" }, fixture())).toContain("unknown domain");
    expect(runDesignSearch({ query: "x" }, null)).toContain("not available");
    expect(buildBrief(fixture(), "zzzz qqqq")).toContain("No design data matched");
    expect(designSearchSchema.name).toBe("design_search");
  });
});

describe("loadDesignSystem", () => {
  it("loads, labels and truncates the project's MASTER.md; empty when absent", () => {
    const root = tmp();
    expect(loadDesignSystem(root)).toBe("");
    fs.mkdirSync(path.join(root, "design-system"));
    fs.writeFileSync(path.join(root, "design-system", "MASTER.md"), "Primary #123456\n" + "x".repeat(5000));
    const s = loadDesignSystem(root, 100);
    expect(s).toContain("DESIGN SYSTEM");
    expect(s).toContain("Primary #123456");
    expect(s).toContain("[...truncated]");
  });
});

describe("vendored catalog (skipped when the uupm pack is not on this machine)", () => {
  const dir = findDataDir();
  it.skipIf(!dir)("answers a real brief", () => {
    const out = runDesignSearch({ query: "saas dashboard" }, dir);
    expect(out).toContain("## Colour tokens");
    expect(out.length).toBeLessThan(6000);
  });
});
