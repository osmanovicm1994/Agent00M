# React & Next.js Standards

Check the versions in package.json and follow the project's router (App Router or Pages) and conventions. `modern-frontend.md` has the component, form, performance and security rules; this file is the framework specifics.

## 1. Next.js App Router
- Server Components by default: fetch data (database, internal APIs) directly in them to keep client bundles small.
- `"use client"` only at the lowest leaf that needs state, effects, browser APIs or event handlers. Do not mark a whole page or layout as client.
- Mutations through Server Actions (validate input and check authorization inside every action, as for any endpoint) or route handlers when an external client needs an API.
- Use the framework: `next/link`, `next/image`, `next/font`, the metadata API, `loading.tsx`, `error.tsx`, `not-found.tsx`. In recent versions `params`, `searchParams`, `cookies()` and `headers()` are async: await them.
- Server-only code (secrets, database) never gets imported into a client component; keep it in server modules.

## 1b. Route handlers (app/api/**/route.ts)
- The folder defines the params. `app/api/users/route.ts` (`/api/users`) exports `GET` (list) and `POST` and takes no params. One record lives in `app/api/users/[id]/route.ts` with `GET`, `PUT`, `DELETE`.
- Dynamic handlers: `export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; ... }`. `params` is a Promise in Next 15/16.
- One file never exports two functions with the same method name. Never merge "list" and "get one" into one `GET`.
- Every route imports auth from ONE helper (for example `requireUser` / `requireAdmin` in `src/lib/auth`) and the database from ONE client file. Do not write `await import(...)` inside handlers and do not invent helpers: read `src/lib/auth` first and use what exists.
- Validate with `schema.safeParse(body)` and return `parsed.error.issues` (Zod 4 has no `.errors`). In `catch`, `error` is `unknown`: check `error instanceof Error`.
- `.next/types/validator.ts` errors are caused by the exports of your route or page file. Fix that file; never edit `.next`.

## 2. TypeScript and data flow
- Explicit prop interfaces; `any` is not allowed. Type data at the boundary (zod parse or typed client) rather than casting.
- Avoid prop drilling: compose with `children`, use context for truly global values, and the project's state library (Zustand, Redux, Jotai) only for shared client state. Server data belongs to the data layer (server components, TanStack Query), not copied into global state.

## 3. Styling
- Use the project's styling method (usually Tailwind). Stay on the theme scale; arbitrary values only as a last resort. See `10-design/css-and-tailwind.md`.

## 4. Testing hooks
- Stable `data-testid` on elements that end-to-end tests must reach; prefer role and label queries in component tests.
