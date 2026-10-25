# Scaffolding Next.js and NestJS apps (non-interactive, exact commands)

A scaffolder cannot ask questions here (no input) and a refused command ends the step. Use exactly this order.

## Rules
- Create the PARENT folder first: `mkdir -p apps`. `create-next-app` checks that the parent of the target is writable and says "The application path is not writable" when `apps/` does not exist yet. Do not create `apps/web` yourself: the scaffolder creates it, and an empty folder is fine.
- Use `npx --yes <tool>@<major> ...` (the majors in `13-delivery/02-versions-2026.md`). Never `npm install -g` (it is a risky command: it asks, and in unattended runs the answer is no).
- The folder name becomes the npm package name: it must be lowercase without spaces. Scaffold into `apps/web`, never into `.` inside a capitalised folder ("name can no longer contain capital letters").
- Pass every choice as a flag. If a flag is rejected ("unknown option"), run `npx --yes <tool> --help` once and use the flag names it lists. Do not retry the same command.
- The install takes minutes. Do not lower the command timeout.
- After scaffolding: `get_directory_tree` on the new app, then run its own build once (`npm --prefix apps/web run build`) BEFORE adding features, so a later failure is known to be yours.

## Web (Next.js, App Router, TypeScript, Tailwind)
```
mkdir -p apps
npx --yes create-next-app@16 apps/web --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --disable-git --yes
```
- The flags are `--use-npm` and `--disable-git` (checked with `--help`; `--package-manager` and `--no-git` do not exist). The root is already a git repository.
- The scaffold ships `AGENTS.md` and offline docs in `node_modules/next/dist/docs/`: read those for any Next API you are unsure about. Its `next.config.ts` has `cacheComponents: true`, so a page that reads data needs `<Suspense>` (see `13-delivery/03-recipe-nextjs-prisma-auth.md`). Its layout imports Google fonts: replace them when the build is offline.
- With `--src-dir` the app lives in `apps/web/src/app/` (layout in `apps/web/src/app/layout.tsx`). Without it, `apps/web/app/`. Use the layout that exists on disk.
- Do not use `next/font/google` when the machine may be offline (build downloads the font). Use a system font stack or `next/font/local`.

## API (NestJS, TypeScript)
```
mkdir -p apps
cd apps && npx --yes @nestjs/cli@latest new api --package-manager npm --skip-git --skip-install
npm --prefix apps/api install
```
- Install in a second step on purpose: the Nest CLI hides the reason when its own install fails ("Packages installation failed"). `npm --prefix apps/api install` prints it. If it reports ERESOLVE (peer dependency conflict), say which packages conflict and try `npm --prefix apps/api install --legacy-peer-deps` once.
- The Nest CLI creates `apps/api` with `src/main.ts`, `src/app.module.ts`, a unit test setup (`npm --prefix apps/api test`; the template may use vitest or jest, check `package.json`) and a `build` script (`npm --prefix apps/api run build`).
- `--skip-git` matters: the project root is already a git repository.
- Never run `cd ..` or `cd ../..`: it leaves the project, so the command asks for approval, and an unattended run declines it. Use `cd apps && <command>` only for the one command, and run everything else from the project root with `npm --prefix apps/<name> ...`. If a command left you in `apps/`, start the next command with the path from the project root, not with `cd ..`.

## Root of the monorepo
- Each app keeps its OWN `package.json`, `node_modules` and `package-lock.json`. Do not add npm `workspaces` unless the task asks for them: hoisting breaks the per-app lockfile the Docker templates copy.
- Root `package.json` holds only scripts that forward to the apps:
  `"dev:api": "npm --prefix apps/api run start:dev"`, `"dev:web": "npm --prefix apps/web run dev"`, `"build": "npm --prefix apps/api run build && npm --prefix apps/web run build"`, `"test": "npm --prefix apps/api test"`.
- Root `.gitignore`: `node_modules`, `.next`, `dist`, `.env`, `.env.*`, `!.env.example`.

## When the scaffold fails
- Read the error. "not writable" = the parent folder is missing (`mkdir -p apps`). "unknown option" = check `--help`. "ENOTFOUND/network" = say so and stop; do not hand-write a fake scaffold.
- Never write a placeholder such as "[N chars written to ...]" or a stub into a file to make a check pass.
