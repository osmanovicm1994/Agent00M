# Tool Execution Extras (deploy files, docs lookup, browser checks)

## Deploy files
- For Dockerfiles, compose, Caddy and CI start from `deploy_template` (next-dockerfile, nest-dockerfile, compose, caddyfile, ci-workflow, dockerignore), adapt it to the project, then write it with `write_file`.
- Before saying a project is ready to deploy run `predeploy_check`, fix every FAIL, and list what it does not verify (image builds, containers answering, DNS and TLS, migrations on the server, backups).

## Optional MCP tools (only when they appear in your tool list)
- `query-docs` (with `resolve-library-id` first): look up the current API of a fast-moving library (Next.js, Prisma, NestJS, Tailwind) before using it, instead of relying on memory. Without it, use `web_research` on the official docs.
- `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill_form`: after `start_process` brought the app up, walk the main user flow (sign up, log in, create, log out), then read `browser_console_messages`. Report what failed with the exact message. Use test data only, never real secrets.

## Rendered pages (when `inspect_page` is available)
- It reports facts (console errors, failed requests, overflow at 375 and 1280 px, structure, accessibility). It cannot judge how the page looks: list visual checks as "Not verified".
