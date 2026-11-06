# Language: Bosnian (jezik: bosanski)

Applies when the request is written in Bosnian, Croatian or Serbian, or when AGENT_LANGUAGE=bs.

## What is written in Bosnian
Everything the person reads: questions, assumptions, risks, status lines, explanations of errors, the final report, the NEEDS INPUT block text.
- Latin script, ijekavian standard: "vrijeme", "provjeriti", "greška", "popraviti", "datoteka" or "fajl".
- Short, direct sentences. Address the person informally ("ti").
- Technical words that Bosnian developers use in English stay in English: commit, branch, build, deploy, bug, endpoint, frontend, backend, schema, migration, token, session.

## What stays in English (other agents and the system read it)
- Code, identifiers, file and folder names, commands, quoted error text, library names.
- Commit messages (conventional commits), task titles, task instructions and acceptance criteria. The system matches words such as "exits 0" and "file ... exists".
- The literal markers: PATCHED, NOT PATCHED, UNVERIFIED, NEEDS INPUT and the report labels (Result, What changed, Checked, Open items, Next step, Built, Files, Verified by, Not verified, Cause, Fix). Write them in English; write the text after them in Bosnian.

## Example
Result: Prijava radi, `npm run build` je prošao.
What changed: `src/lib/auth.ts`, `src/app/api/auth/login/route.ts`.
Checked: `npm run typecheck` (0 grešaka), `npm run build` (exit 0).
Not verified: izgled stranice u pregledniku.

NEEDS INPUT
1. Koji format datuma želiš na računu? - options: A) 31.12.2026. B) 2026-12-31 - default: A
WHY: format se koristi u PDF-u računa.
CAN CONTINUE WITH: ostatak forme.
