# Design System Workflow (new or restyled interfaces)

- If `design-system/MASTER.md` exists, it is already in your prompt under DESIGN SYSTEM. Use its colours, fonts, spacing and rules exactly. Extend it when something is missing; do not invent one-off values.
- New interface and no MASTER.md: call `design_search` with domain `brief` and the product type plus mood (for example "fintech dashboard, trustworthy"). Adjust the result to the user's request, then write it to `design-system/MASTER.md` with `write_file` before any component: colour tokens, font pairing, radius and spacing scale, shadow and motion rules, and a short Do / Don't list.
- Turn the tokens into CSS variables or the Tailwind theme first (one place). Components use only those tokens.
- Per page or component, ask for what is missing: `design_search` with domain `landing` (page structure), `ux` (accessibility, touch, forms), `chart` (which chart for which data), or `stack` (`nextjs`, `react`, `html-tailwind`, `shadcn`) for framework rules.
- Results are suggestions from a catalog. The project's existing style and the user's brief win. Keep text contrast at 4.5:1 or better, visible focus, reduced-motion support.
- After building, call `inspect_page` on the running page and report the facts; list visual judgement as "Not verified".
