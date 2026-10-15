# Modern Frontend Engineering

Check the real versions in package.json before using any API below; follow the project when it differs.

## 1. Components
- Small, typed, single-purpose. Props are an explicit interface; compose with children and slots instead of boolean-flag explosions. Variants via a typed prop (variant, size) or the project's variant helper (cva, tailwind-variants).
- Model UI state as a discriminated union (status: "loading" | "error" | "success" with data), not several booleans that can contradict each other.
- Derive values during render. Do not copy props into state, and do not use useEffect for derived data or event handling. Effects are for syncing with something outside React.
- Stable keys from data ids, never array indexes for dynamic lists. Memoize (useMemo, useCallback, memo) only after measuring a problem.
- Colocate: component, its styles, its test and its types live together. Shared primitives go in the project's existing ui/components folder.

## 2. React 19 / Next.js (when react or next is installed)
- React 19: ref is a normal prop (no forwardRef for new components); use useActionState, useFormStatus and useOptimistic for forms and mutations; the use hook reads promises and context.
- Next.js App Router: Server Components by default; "use client" only at the lowest leaf that needs state, effects or browser APIs. Fetch on the server, pass data down. Mutations through Server Actions. In recent Next versions params, searchParams, cookies() and headers() are async: await them.
- Use the framework: next/image (width/height or fill, priority for the LCP image), next/font, next/link, the metadata API, loading.tsx / error.tsx / not-found.tsx for route states.
- Vite/SPA: lazy-load routes (React.lazy + Suspense), one data layer (TanStack Query or the project's), error boundaries around async areas.

## 3. Forms
- Real label per input, correct type, autocomplete and inputmode. Validate on the client for speed and again on the server for truth. Show errors next to the field (aria-invalid, aria-describedby), keep typed values, disable the submit while pending to block double submits.
- Use the validation library already in the project (zod, react-hook-form ...) before adding another.

## 4. Performance (Core Web Vitals: LCP, INP, CLS)
- Reserve space for images, embeds and async content to avoid layout shift. Lazy-load below-the-fold images, give the LCP image priority.
- Split code at route and heavy-widget boundaries. Check bundle impact before adding a dependency; prefer what is installed or the platform (native dialog, Intl, CSS) over a new package.
- Long lists (hundreds of rows) are paginated or virtualized. Do not animate layout properties; animate transform and opacity.

## 5. TypeScript and quality
- strict mode, no any, no unchecked casts or non-null assertions to silence an error. Type API data at the boundary (zod parse or a typed client).
- Follow the project's ESLint/Prettier setup; fix lint errors instead of disabling rules. No console.log, commented-out code or TODO placeholders left behind.

## 6. Security
- Never dangerouslySetInnerHTML with untrusted content (sanitize first). Anything in a NEXT_PUBLIC_ / VITE_ variable is public: no secrets in client code. External links with target="_blank" get rel="noopener noreferrer".
