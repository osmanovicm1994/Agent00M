# TypeScript and Build Errors: What Each One Means

| Error | Meaning | What to do |
| --- | --- | --- |
| TS2307 / "Module not found: Can't resolve" | module or file missing | Relative or `@/` path: `find_files` the target, create it or fix the path. `@/components/ui/<name>`: the UI component was never generated (see 03). Package: `npm ls <pkg>`, then `npm install <pkg>`. |
| TS2305 / TS2724 | no exported member | `grep -n "export" <file>` to see the real names. The installed version may differ from what you remember: `npm ls <pkg>`. |
| TS2339 | property does not exist on type | Read the definition of the type. Prisma: a result has ONLY the `select`ed fields (add the field to `select`). `Promise<...>` in the message means a missing `await` (`cookies()`, `headers()`, `params` in Next 15+). |
| TS2353 / TS2561 | unknown property in an object literal | Wrong field name. Open the schema or type and copy the name. |
| TS2322 / TS2769 | type not assignable (no overload matches) | Read what the target expects. For a component you used props it does not declare: open the component file. A wrong import (icon instead of component) also lands here. |
| TS2554 / TS2555 | expected N arguments, got M | Read the function signature. `new PrismaClient()` with no argument in Prisma 7 needs `{ adapter }` (see 04). |
| TS2345 | argument not assignable to parameter | Check `undefined` / `null` (`string | undefined`) and types inferred from zod. |
| TS2741 / TS2739 | missing properties | Add the listed properties, or read the required type and fix the object. |
| TS7006 / TS7031 | implicit any | Usually fallout: fix the error above it first. |
| TS2532 / TS18047 / TS18048 | possibly null or undefined | Narrow it (`if (!x) return ...`). Do not use `!` unless it is guaranteed. |
| TS2304 | cannot find name | Missing import or a typo. |
| TS2300 / TS2451 | duplicate identifier | Two declarations; often a chunked write that repeated lines. Remove one. |
| TS1005 / TS1109 / TS1128 | syntax error, expected token | The file is cut off or two chunks were joined badly. Read the end of the file and rewrite the whole file. |

## Build errors that are not tsc
- "doesn't have a root layout": `src/app/layout.tsx` is missing (see 03).
- "Failed to compile ... Type error": the same as the tsc errors above; fix the first one.
- P1012 / "Error validating" (Prisma): see 04.
- "Hydration failed": output differs between server and browser (dates, random values, `window`, locale).
- ESLint errors that stop the build: fix the code; do not disable the rule.
