# Writing Code That Works the First Time (every task that creates or changes code)

## Top rules
1. READ the source of truth for every name BEFORE you use it, in ONE `read_multiple_files` call: `prisma/schema.prisma` for tables, fields and enums; `src/components/ui/<name>.tsx` for a UI component's props; the file that exports a helper or type you import; `package.json` for installed packages and versions; the task's CONTRACT block for URLs and payloads.
2. COPY names exactly (case, singular/plural, enum values, prop names). Never write a field, prop, export, route or env name from memory or because it "sounds right". If the contract and the schema disagree, the schema wins: use its names and say so in your report.
3. IMPORT only what exists. Before `import { x } from "@/lib/y"` that file must exist and export `x`. If it does not, create it first, in its own write. `@/` means `src/` when the project has a `src/` folder; check `paths` in `tsconfig.json`.
4. ONE file per write, the WHOLE file, no placeholders (`// ...`, `TODO: implement`, `pass`). A stub must compile and be named in your report.
5. KEEP FILES SMALL: one component, one route handler, one helper per file, under about 150 lines. A file that fits in one `write_file` cannot be cut off in the middle. If a file must be longer: `write_file` the first ~150 lines, then `append_file` chunks of ~150 lines, never repeating lines.
6. ORDER: schema and types -> client generation -> lib and helpers -> API routes -> components -> pages -> tests. Write a file only after everything it imports exists.
7. CHECK as you go: after each layer run the project's typecheck (`npm run typecheck`, else `npx tsc --noEmit`). Fix errors in the files YOU wrote before starting the next layer. Never end with errors in your own files.

## Changing an existing file
- Read it first. A small change (one line, one block, a renamed field, an added import) is an `edit_file`: copy `old_string` exactly from the file with enough surrounding lines to be unique. Several small changes in one file are several `edit_file` calls, one per turn, not a rewrite.
- Only when most of the file changes: send the complete new content with `write_file`. Everything you do not mean to change stays exactly as it was: imports, exports, comments, order.
- Every name that was exported before is still exported afterwards (unless the task removes it).
- A type and the files that use it: change the definition first, then the users, then run the typecheck.
- A tool result that reports a placeholder, a cut-off or a syntax problem in what you just wrote: rewrite that file immediately, before anything else.

## Commands and environment
- Use the package manager the lockfile shows (package-lock.json = npm, pnpm-lock.yaml = pnpm, yarn.lock = yarn). Install a package only in the folder whose package.json needs it. Check the real version with `npm view <pkg> version` before pinning it.
- Do not search the whole tree with `find .` or `ls -R`: it walks node_modules. Use `find_files`, `grep` and `get_directory_tree`.
- A scratch folder (for example a scaffold test) is created outside the project, or you delete it yourself before you finish (`rm -r <that exact folder>`). Leftover `temp_*` folders with their own node_modules break searches and builds.
- Secrets never go into code: names only in `.env.example`.

## Done means
- The typecheck shows 0 errors in the files you touched, and the build or test that covers them passes.
- Report: the files written, the commands you ran with their real result, and what you did not verify.
