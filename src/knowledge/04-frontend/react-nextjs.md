# React & Next.js Standards

## 1. Next.js App Router Architecture
- Default to React Server Components (RSC). Data fetching (e.g., PostgreSQL queries) should occur directly in Server Components to minimize client payloads.
- Use the `"use client"` directive strictly at the lowest possible leaf nodes in the component tree—only where hooks (`useState`, `useEffect`) or DOM event listeners (`onClick`) are required.
- Replace traditional API routes with Server Actions for form submissions and mutations.

## 2. TypeScript & Data Flow
- Define strict interfaces for all component props. `any` is strictly banned.
- Limit prop drilling. Use React Context or Zustand for global state, but prefer passing data via composition (`children` prop) when solving layout issues.

## 3. Styling & uupm Integration
- Use Tailwind CSS. Avoid arbitrary values; stick to the design system scale.
- Integrate UI components seamlessly following the component library patterns in the `uupm` design folder.
