# Next.js App Router and UI Component Pitfalls (seen in real runs)

## Async request APIs (Next 15 and 16)
- `cookies()`, `headers()` and `draftMode()` return Promises: `const store = await cookies(); store.get("session")`. The function that calls them must be `async`. Error: "Property 'get' does not exist on type 'Promise<ReadonlyRequestCookies>'".
- `params` and `searchParams` are Promises too: `export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; }`. Route handlers: `(req: Request, { params }: { params: Promise<{ id: string }> })`.

## Layouts and routes
- `src/app/layout.tsx` MUST exist and return `<html lang="en"><body>{children}</body></html>`. Without it every page fails with "doesn't have a root layout". Create it once; do not delete the starter layout.
- A route group `(customer)` adds no URL segment and needs no layout of its own. `src/app/page.tsx` and `src/app/(customer)/page.tsx` are BOTH "/": never create both.
- Every link, button and menu item must lead to a page that exists. After building pages, list `src/app/**/page.tsx` and compare with the links.
- A file that uses hooks, state or event handlers starts with `"use client"`. Server-only code (Prisma, `cookies()`, `server-only`) is never imported by a client component.

## UI components (shadcn style)
- Before you import `@/components/ui/<name>`, check the file exists (`find_files`). If it does not: `npx shadcn@latest add <name> --yes` (needs `components.json`); without `components.json`, write the small component yourself with native elements.
- READ the component file before you use it. The same name has different props in different libraries: a Radix select uses `onValueChange` and `<SelectTrigger><SelectValue placeholder="..." /></SelectTrigger>`; a native select wrapper uses `value`, `onChange` and `<option>` children. Use only the props the file declares.
- Name clash: `Calendar` from `lucide-react` is an ICON (it takes SVG props only). The date picker is `Calendar` from `@/components/ui/calendar` (`mode="single" selected={date} onSelect={setDate}`). Import the icon as `CalendarIcon`.
- Forms: react-hook-form with the zod resolver; show the error text next to each field; a submit button disabled while pending.

## Libraries
- Use the exports the INSTALLED version has: check `package.json`, and when unsure `grep -n "export" node_modules/<pkg>/dist/index.d.ts` (one targeted read, not a listing).
- Date work: `date-fns` (`parseISO`, `format`, `addMinutes`); store UTC in the database, convert at the edge.
