# Next.js (App Router) Practices

Confirm the installed major version first; APIs and defaults change between majors. Follow the existing project over this file. Details on components and forms: `04-frontend/modern-frontend.md`.

## Creating the app
- `npx create-next-app@latest <dir> --help` lists the flags. Pass every option (TypeScript, Tailwind, ESLint, App Router, `src/` dir, import alias, package manager) so no prompt appears; `--yes` accepts defaults.

## Structure
- `app/` routes with `layout.tsx`, `page.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`. Route groups `(marketing)` / `(app)` separate layouts. Shared UI in `components/`, server-only logic in `lib/` or `server/`, never imported from client components.
- Keep the API in the NestJS app. The web app calls it through one typed client module (base URL from env, typed responses, error mapping), not scattered `fetch` calls.

## Data and caching
- Fetch in Server Components. Be explicit about caching and revalidation for each request (the defaults differ by version): static, time-based, or on-demand with tags. Per-user data is never cached across users.
- Mutations: Server Actions or calls to the API. Validate input again on the server (zod), check the user's session in every action, and return typed results with field errors. Call `revalidatePath` / `revalidateTag` after a mutation.
- In recent majors `params`, `searchParams`, `cookies()` and `headers()` are asynchronous: await them.

## Auth in the web app
- Keep tokens in httpOnly, secure, SameSite cookies set by the API or a route handler, not in localStorage. Protect routes in middleware (optimistic redirect) AND in the server code that reads the data. Never trust a client-side role flag.

## Config, performance, quality
- Only `NEXT_PUBLIC_` variables reach the browser: no secrets there. Validate env at startup.
- `next/image` with dimensions, `next/font`, dynamic import for heavy client widgets, metadata API for titles and Open Graph.
- Error and empty states for every data view; accessible forms. Verify with `npm run typecheck`, `npm run lint`, `npm run build` (the build catches many server/client boundary mistakes).
