# UI Quality Standards (frontend)

## 1. Match the existing system first
- Read the project's components, theme/token files and global CSS before writing UI. Reuse its tokens (colors, spacing, radii, type scale, shadows) and its components. Never hard-code a hex value or pixel size when a token exists.
- No design system yet: define tokens once (CSS variables, or the Tailwind theme) and reference only those. Do not add a second styling approach or UI library next to the existing one.
- Before creating a component, search for one that already does the job (find_files / grep). Extend it with a variant instead of duplicating it.

## 2. Accessibility (non-negotiable, WCAG 2.2 AA)
- Contrast: text 4.5:1 (large text and UI boundaries 3:1). Never use color alone to show state (add icon, text or shape).
- Semantic HTML first: real button, a, label, nav, main, ul, table, dialog. Never a clickable div. Headings in order, one h1 per page.
- Everything works with the keyboard: logical tab order, visible :focus-visible style, Escape closes overlays, focus moves into a dialog and returns on close.
- Images: meaningful alt, or alt="" when decorative. Icon-only buttons get an accessible name (aria-label). Inputs have a visible label.
- Touch targets at least 44x44 px (WCAG 2.2 minimum is 24x24). Respect prefers-reduced-motion; keep motion 150-300ms and purposeful.
- ARIA only when no native element does the job; first rule of ARIA is to not need it. Status and errors: role="status" / role="alert" or aria-live.

## 3. Layout and responsiveness
- Mobile first, scale up. No horizontal scroll at 320px. Test mentally at 320, 768, 1280 widths and at 200% text zoom.
- Use grid/flex, gap, min/max/clamp and a spacing scale (4/8/12/16/24/32/48). No fixed pixel widths for content, no magic margins.
- Use dvh/svh instead of vh for full-height mobile layouts. Respect safe areas on notched devices.

## 4. Every data-driven view has every state
- Loading (skeleton or spinner, no layout jump), empty (explains what to do next), error (plain message plus retry), success, and disabled/in-progress for buttons that start async work.
- Keep the user's input when a request fails. Never show raw exception text or server payloads.

## 5. Visual hierarchy and content
- Two font families at most and a defined type scale. Body text 16px minimum, line-height 1.4-1.6, line length about 45-75 characters.
- One primary action per view; secondary actions visually quieter. Consistent radius, shadow and spacing everywhere.
- Support dark mode when the project does (tokens switch, not duplicated components). Copy is short, plain and consistent.

## 6. Testability
- Stable data-testid on elements UI tests must reach (never styling or copy based). Prefer role and label queries in tests. Ids are not user-facing text and do not change with language.
