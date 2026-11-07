import { describe, it, expect } from "vitest";
import { matchKnownFixes } from "./known-fixes";

// Output copied from a real run (barbershop booking app, Next 16 + Prisma 7).
const TYPECHECK = `src/app/(customer)/book/page.tsx(11,23): error TS2307: Cannot find module '@/components/ui/label' or its corresponding type declarations.
src/app/(customer)/book/page.tsx(151,69): error TS2322: Type '{ children: Element[]; }' is not assignable to type 'IntrinsicAttributes & SelectProps & RefAttributes<HTMLSelectElement>'.
  Property 'onValueChange' does not exist on type 'IntrinsicAttributes & SelectProps & RefAttributes<HTMLSelectElement>'. Did you mean 'onVolumeChange'?
src/app/(customer)/book/page.tsx(188,19): error TS2322: Type '(date: Date | undefined) => void' is not assignable to type 'ReactEventHandler<SVGSVGElement>'.
src/lib/auth.ts(14,38): error TS2339: Property 'get' does not exist on type 'Promise<ReadonlyRequestCookies>'.
Error: customer/login/page.tsx doesn't have a root layout. To fix this error, make sure every page has a root layout.`;

const ids = (cmd: string, out: string, max = 10) => matchKnownFixes(cmd, out, max).map((f) => f.id);

describe("known fixes for Next.js and UI component errors", () => {
  it("recognises every class of error in a mixed typecheck output", () => {
    expect(ids("npm run typecheck", TYPECHECK)).toEqual(
      expect.arrayContaining(["next-async-request-api", "next-no-root-layout", "ui-component-missing", "ui-component-api-mismatch"]),
    );
  });

  it("names the missing component in the fix", () => {
    const fix = matchKnownFixes("npm run typecheck", TYPECHECK, 10).find((f) => f.id === "ui-component-missing");
    expect(fix?.title).toContain("label");
    expect(fix?.steps.join(" ")).toContain("npx shadcn@latest add label");
  });

  it("does not fire on an ordinary missing property", () => {
    expect(ids("npm run typecheck", "src/a.ts(1,1): error TS2339: Property 'x' does not exist on type 'Foo'.")).toEqual([]);
  });

  it("returns up to three fixes by default", () => {
    expect(matchKnownFixes("npm run typecheck", TYPECHECK).length).toBe(3);
  });
});
