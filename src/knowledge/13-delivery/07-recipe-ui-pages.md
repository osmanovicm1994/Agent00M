# Recipe: the pages of a data app (login, list, wizard, print view, admin)

Checked in a real build on Next 16.4.3 (`cacheComponents` on), React 19, Tailwind 4, react-hook-form 7, zod 4. The starter page `src/app/page.tsx` ("To get started, edit...") and the title "Create Next App" in `layout.tsx` must be REPLACED: a build that still shows them is not done. Replace the home page with a redirect: `import { redirect } from "next/navigation"; export default function Home() { redirect("/items"); }` and set `metadata.title` to the product name.

## Rule for every page that reads data or the session
Put the reading in an async component inside `<Suspense>`; the page itself stays synchronous. Without it `next build` fails under `cacheComponents`.
```tsx
async function ItemTable() {
  const actor = await requireActor();
  const rows = await prisma.item.findMany({ where: ownerFilter(actor), orderBy: { createdAt: "desc" } });
  if (rows.length === 0) return <p>Nothing here yet. <Link href="/items/new" className="underline">Create the first one</Link>.</p>;
  return <table className="w-full text-left text-sm">{/* head + rows, each row a Link to /items/<id> */}</table>;
}
export default function ItemsPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Items</h1>
      <Suspense fallback={<p>Loading…</p>}><ItemTable /></Suspense>
    </section>
  );
}
```
Every list has three states: loading (Suspense fallback), empty (a sentence with the action), data.

## Layout with navigation `src/app/(app)/layout.tsx`
Server component. `Nav` is an async component in `<Suspense>` (it calls `requireActor()`), shows the Users link only when `actor.role === "ADMIN"`, the name, and a client `SignOutButton` (`signOut({ callbackUrl: "/login" })` from `next-auth/react`). Give `header` and `nav` `print:hidden`.

## Login `src/app/login/page.tsx` + `login-form.tsx`
Page: heading + `<LoginForm />`. Form (`"use client"`): `useForm({ resolver: zodResolver(loginSchema) })`, labelled inputs (`htmlFor`/`id`), `autoComplete="username"` and `"current-password"`, `aria-invalid`, errors in `<p role="alert">`, submit with `const res = await signIn("credentials", { ...values, redirect: false }); if (!res || res.error) setError("Wrong email or password"); else { router.push("/items"); router.refresh(); }`. Never say which of the two was wrong.

## Multi-step wizard (one form, one schema)
```tsx
"use client";
const STEPS: { label: string; fields: (keyof ItemInput)[] }[] = [
  { label: "Details", fields: ["title"] },
  { label: "Amount", fields: ["amount"] },
];
// one useForm with zodResolver(fullSchema); on "Next": if (await trigger(STEPS[step].fields)) setStep(step + 1);
// last step: POST the whole object to /api/items, show server errors in role="alert", then router.push(`/items/${data.id}`)
```
Show the step list as `<ol aria-label="Steps">` with `aria-current="step"`; Back button on steps > 0; submit disabled while saving; number inputs use `register("amount", { valueAsNumber: true })`. The same zod schema validates on the server; the client never sends the owner.

## Detail + print view `src/app/(app)/items/[id]/page.tsx`
`params` is a Promise. Async `Document` component in `<Suspense>`: `const { id } = await params; const actor = await requireActor(); const row = await prisma.item.findUnique({ where: { id } }); if (!row || (actor.role !== "ADMIN" && row.userId !== actor.id)) notFound();` (missing and "not yours" look the same to a USER).
Print = the browser's print dialog, no PDF library: a client `PrintButton` calling `window.print()`; the sheet is `<article className="mx-auto max-w-[210mm] bg-white p-8 shadow print:max-w-none print:p-0 print:shadow-none">`; navigation and buttons `print:hidden`; in `globals.css` `@page { size: A4; margin: 15mm; }`, and `break-inside-avoid` on blocks that must not split (signature boxes). Signature row: a grid of two `border-t pt-2` cells.

## Admin page
`requireAdmin()` inside the Suspense component, a table of users (name, email, role, active), a client form that POSTs `/api/admin/users`, list refreshed with `router.refresh()`.

## Done means (check, do not claim)
`npm run build` exits 0; `src/app/page.tsx` has no "To get started"; every route in the request exists as a `page.tsx`; each form field has a label.
