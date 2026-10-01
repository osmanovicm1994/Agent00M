# UI / UX Design Standards

## 1. Match the Existing System First
- Read the project's existing components, theme / token files and CSS before proposing anything. Reuse its tokens (colors, spacing, radii, type scale); never hard-code new hex values or pixel sizes when a token exists.
- If there is no design system, define tokens once (CSS variables or the Tailwind theme) and reference them everywhere.

## 2. Accessibility (non-negotiable)
- Text contrast at least 4.5:1 (3:1 for large text and UI boundaries). Never rely on color alone to convey state.
- Every interactive element is keyboard reachable with a visible focus style. Use real `<button>`, `<a>`, `<label>`, not clickable `<div>`s.
- Images have meaningful `alt` (empty `alt=""` when decorative); inputs have associated labels; touch targets are at least 44x44px.
- Respect `prefers-reduced-motion` and keep animations short (150-300ms) and purposeful.

## 3. Layout & Responsiveness
- Mobile first; scale up with breakpoints. No horizontal scroll at 320px width.
- Use a consistent spacing scale (e.g. 4 / 8 / 12 / 16 / 24 / 32) and CSS grid / flexbox rather than fixed widths.
- Provide loading, empty, error and disabled states for every data-driven component, not just the happy path.

## 4. Typography & Visual Hierarchy
- Limit to two font families and a defined type scale. Body text 16px minimum with 1.4-1.6 line height.
- One primary action per view; secondary actions visually quieter.

## 5. Testability
- Give interactive elements stable `data-testid` (web) / accessibility identifiers (mobile) so UI tests never depend on styling or copy.
