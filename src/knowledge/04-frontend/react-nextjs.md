# React & Next.js Standards

Check the versions in package.json and follow the project's router (App Router or Pages) and conventions. `modern-frontend.md` has the component, form, performance and security rules; this file is the framework specifics.

## 1. Next.js App Router
- Server Components by default: fetch data (database, internal APIs) directly in them to keep client bundles small.
- `"use client"` only at the lowest leaf that needs state, effects, browser APIs or event handlers. Do not mark a whole page or layout as client.
- Mutations through Server Actions (validate input and check authorization inside every action, as for any endpoint) or route handlers when an external client needs an API.
- Use the framework: `next/link`, `next/image`, `next/font`, the metadata API, `loading.tsx`, `error.tsx`, `not-found.tsx`. In recent versions `params`, `searchParams`, `cookies()` and `headers()` are async: await them.
- Server-only code (secrets, database) never gets imported into a client component; keep it in server modules.

## 2. TypeScript and data flow
- Explicit prop interfaces; `any` is not allowed. Type data at the boundary (zod parse or typed client) rather than casting.
- Avoid prop drilling: compose with `children`, use context for truly global values, and the project's state library (Zustand, Redux, Jotai) only for shared client state. Server data belongs to the data layer (server components, TanStack Query), not copied into global state.

## 3. Styling
- Use the project's styling method (usually Tailwind). Stay on the theme scale; arbitrary values only as a last resort. See `10-design/css-and-tailwind.md`.

## 4. Testing hooks
- Stable `data-testid` on elements that end-to-end tests must reach; prefer role and label queries in component tests.
