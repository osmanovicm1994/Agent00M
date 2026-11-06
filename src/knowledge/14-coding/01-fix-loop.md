# Fixing Errors Fast Without Looping

## The loop (max 2 attempts per error, max 6 tool calls of looking)
1. COPY the FIRST error line: code, file, line, message. Later errors are usually fallout.
2. CLASSIFY it with `02-ts-error-codes.md`. If a KNOWN FIX is attached to the tool result, apply it exactly.
3. LOOK only where the error points: `read_file` that file with `start_line` / `end_line` around the line, plus the ONE source of truth (schema, component file, exporting module). Never list or read inside `node_modules`.
4. FIX every error of the same class in that file in ONE whole-file write.
5. RE-RUN the same command and count the errors. The number must go DOWN.
6. The same error again means your cause was wrong. Attempt 2 must test a DIFFERENT cause (another file, a version, a config). After attempt 2: stop and report.

## Many errors at once (typecheck, build)
- Group by file and fix in dependency order: missing module or export (TS2307, TS2305) -> schema and generated client -> lib -> API routes -> components -> pages. Missing modules cause cascades of implicit-any and type errors, so they come first.
- More than about 15 errors: fix one group, re-run, and read the NEW first error. Do not plan all fixes from the old list.
- A package export that "does not exist" although it should (for example `parseISO` in date-fns): run `npm ls <pkg>`. A broken or partial install is the usual cause: `npm install <pkg>@<version from package.json>` once. Do not write your own replacement.
- Errors in files you did not touch and that existed before your task: do not fix them silently. Name them in your report.

## Never
- `// @ts-ignore`, `as any`, `eslint-disable`, deleting or skipping tests, deleting `node_modules` or lockfiles, `--force`, blind version bumps.
- Repeating a command, a listing or a read. The system stops an agent that repeats itself.

## When you cannot continue: ask, do not loop
Stop after attempt 2, or earlier when the fix needs something only the person has (a value, a secret, a choice, a running service). Finish what does not depend on the answer, then end your reply with:

NEEDS INPUT
1. <one-line question> - options: A) ... B) ... - default: A
WHY: <what is blocked, with the first error line>
TRIED: <the 2 attempts, one line each>
CAN CONTINUE WITH: <what you do meanwhile>

At most 3 questions, each answerable with one word. Never ask what you can read from disk.
