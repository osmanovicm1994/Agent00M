# Modern CSS and Tailwind

Use the project's styling method (Tailwind, CSS Modules, styled-components, plain CSS). Never mix in a second one.

## Modern CSS (use before reaching for JS or a library)
- Design tokens as custom properties on :root, switched for dark mode via prefers-color-scheme or a class/data attribute; set color-scheme so native controls follow.
- Fluid sizing with clamp() for type and spacing; min()/max() instead of media-query ladders. Logical properties (margin-inline, padding-block, inset-inline) over left/right.
- Container queries (@container) for components that live in different widths; media queries for page-level layout.
- :has() for parent-aware states, :focus-visible for focus rings, :where() for zero-specificity resets, native nesting, text-wrap: balance on headings.
- Native elements first: dialog, popover attribute, details/summary, input type=date, loading="lazy". Add a library only when these cannot do the job.
- Specificity: flat selectors, no !important, no ID selectors for styling. @layer to order resets, base, components, utilities.

## Tailwind CSS
- Read the version in package.json. v4: CSS-first config. A single import of tailwindcss in the main CSS file, tokens in an @theme block (for example --color-brand-500), the Vite plugin @tailwindcss/vite or the PostCSS plugin; tailwind.config.js is optional and only used through @config. v3: tailwind.config.js with theme.extend.
- Use theme tokens and the default scale. Arbitrary values (w-[137px], text-[#3b82f6]) are a last resort; add a token instead when a value repeats.
- Mobile first: base classes for mobile, sm: md: lg: to scale up. Use dark: variants against the project's dark-mode strategy. Built-in container query variants exist in v4.
- Keep class lists readable: group by layout, spacing, type, color, state. Extract repeated patterns into a component, not into @apply sprawl. Merge conditional classes with the project's helper (clsx, cn, tailwind-merge) instead of string concatenation.
- States are classes too: hover:, focus-visible:, disabled:, aria-[expanded=true]:, data-[state=open]:. Always style focus-visible; never remove the outline without a replacement.
- Respect motion: motion-safe: / motion-reduce: for animations. Use size-*, gap-*, min-h-dvh instead of old patterns.
- When the project uses shadcn/ui or Radix, build on those primitives (they handle focus, keyboard and ARIA) and keep their file structure and cn helper.
