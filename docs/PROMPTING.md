# How to prompt the agent

This guide shows how to write prompts so the agent builds what you want without big problems. It is based on how this agent works: a **local model** (Qwen in LM Studio) with tools. It is capable, but it guesses when you leave gaps, it forgets when a task is too big, and it cannot see the screen.

The short version:

1. **One slice per prompt.** One concern, one result you can check.
2. **Name the stack and the paths.** Do not make it guess.
3. **End with a command that must pass.** That is how it knows it is done.
4. **Read the summary before the next prompt.** Never build on a red slice.

Everything below explains why, and how.

---

## 1. Before the first prompt

Do this once per project. It removes most of the problems later.

| Step | Why |
| --- | --- |
| Put the project in **git** (`git init`, first commit) | Auto mode can change many files. Git is your undo button. The agent warns when there is no repository. |
| Copy `docs/templates/AGENTS.fullstack.md` to the project root as `AGENTS.md` and edit it | The agent reads `AGENTS.md` on every task. Write your stack, folder layout, naming and rules there once, so you do not repeat them in every prompt. |
| In LM Studio: load the model and set the **context length** larger than prompt + `AI_MAX_TOKENS` | If the context is too small, replies are cut off and files come out half written, no matter what the agent does. |
| Start `npm run chat` (or `npm run chat:ui` for the dashboard) and answer the startup questions | Project folder, auto-write, auto-run. Use auto mode only on a project under git. |

What to put in `AGENTS.md` (keep it under about 60 lines):

- Stack with versions: "Next.js 16 App Router, TypeScript, Tailwind 4, NestJS 11, Prisma 7, PostgreSQL".
- Folder layout: "apps/web, apps/api, no npm workspaces, each app has its own package.json".
- The commands that prove it works: "`npm --prefix apps/api run build`, `npm --prefix apps/api test`, `npm --prefix apps/web run build`".
- Rules: "no secrets in code, no tokens in localStorage, no `next/font/google`, named exports only".
- Things the agent got wrong before. Add a line every time you correct the same mistake twice.

---

## 2. The anatomy of a good prompt

Use these six parts. Short prompts are fine as long as each part is there.

```
GOAL      What should exist when this is done (one sentence).
WHERE     The exact folders and files.
STACK     Only if AGENTS.md does not say it. Name versions when they matter.
RULES     Constraints and things that must NOT happen.
DONE WHEN The command(s) that must pass, and what you can check yourself.
```

### A worked example

Weak:

> Make a car marketplace with login and listings, make it look premium.

Why it fails: five features in one prompt, no stack, no paths, no check, and "premium" means nothing to a model that cannot see.

Strong (one of many slices):

> Add a listings page to apps/web. Create `apps/web/src/app/cars/page.tsx` (server component) that fetches `GET {API_URL}/cars` and renders a responsive grid of `CarCard` components. Create `apps/web/src/components/CarCard.tsx` with props `{ id, make, model, year, priceEur, imageUrl }`: image on top (aspect 4/3, `next/image`), make and model as the title, year and price below, price in bold. Use Tailwind classes only, the existing colour tokens from `globals.css`, 1 column on phone, 2 on tablet, 3 on desktop. Handle three states: loading skeleton, empty list ("No cars yet"), and error ("Could not load cars") with a retry link. Do not add a UI library. `npm --prefix apps/web run build` must pass.

What makes it work: exact files, exact props, explicit states, explicit responsive rule, a forbidden thing, and a command.

### Words that help, words that do not

| Instead of | Write |
| --- | --- |
| "make it nice / premium / modern" | "dark background `#0E1014`, accent teal, 8px grid, cards with 16px radius and a subtle border, Inter font, large price in the accent colour" |
| "add authentication" | "JWT access token (15 min) in an httpOnly cookie, refresh token rotation, `POST /auth/login`, `POST /auth/refresh`, a guard on `/cars` write routes" |
| "fix the bug" | the exact error output and the command that produced it |
| "improve performance" | "the listings query does N+1 on `owner`; use one query with `include`; add an index on `make, model`" |
| "like the other pages" | "follow `apps/web/src/app/users/page.tsx` for structure and naming" |

Pointing at an existing file is one of the strongest things you can do: the agent copies the conventions instead of inventing new ones.

---

## 3. Name the stack

A small local model picks its stack from habit, often an older one. The matching standards are only loaded when the stack is recognised. Recognition comes from two places:

- the **words of the task**: a prompt that says Next.js, Prisma, Docker or Playwright loads those standards;
- the **files already in the project**: `package.json` with Next, Nest or Prisma, `.csproj`, `Package.swift`, `build.gradle` and so on.

So: in a brand-new, empty project the first prompts must name the stack (or `AGENTS.md` must). Once the app exists on disk, the standards load by themselves.

Standards exist for Next.js, NestJS, Prisma, JWT, R2, Docker, CI, Playwright, Appium, C#, Python FastAPI, iOS (SwiftUI) and Android (Compose). A stack without one still works, but without the agent's own guidance.

Check what it detected: the terminal prints `Detected stack standards: ...` at the start of every task. If your stack is missing from that line, rephrase the prompt or fix `AGENTS.md` before going on.

---

## 4. Slice the work

A whole app does not fit in one prompt. The agent is reliable on **one slice at a time**. A good slice:

- touches one area (one module, one page, one table);
- can be verified by one command;
- is small enough to finish in a few dozen steps.

### A good order for a full-stack app

1. **Scaffold**: both apps, root scripts, `.gitignore`, build passes.
2. **Health endpoint** and typed config (env validation).
3. **Database**: Prisma schema, first migration.
4. **Auth**: users, login, refresh, guard.
5. **Core resource**: CRUD with ownership checks, pagination, tests.
6. **Uploads / integrations**.
7. **Design system** (tokens, base components), then **pages**, one page per prompt.
8. **Docker, CI, end-to-end tests, README**.

The ready-made prompts for this order are the `task` fields in `bench/fullstack/spec.json`. Copy one, rename things for your app.

### Rules of thumb

- If your prompt has the word "and" three times, split it.
- If the answer to "how will I know it works?" is not a command, add one.
- Do not send the next prompt while the current slice is red. The next slice would build on a broken one, and the model will "fix" the wrong thing.

---

## 5. Pick the right mode

| You want | Use | Notes |
| --- | --- | --- |
| A normal task, agent chosen for you | just type the prompt | The router picks `dev`, `api`, `db`, `design`, `qa`, `debug` and so on from the words. |
| A specific specialist | `/use <id>` or `run -a <id>` | Use `debug` for failures, `db` for schema work, `design` for UI. |
| A new project skeleton, installs, migrations, native builds | `/use infra` or `run -a infra` | The Infrastructure agent runs the real toolchain (npm, prisma, docker compose, xcodegen, pod install, xcodebuild, gradlew, flutter, cargo, go) in the folder that owns each manifest and proves each step by its exit code. It writes no feature code. In `/team` the Project Manager puts an infra task first when one is needed. Name the exact command in your prompt. |
| Several parts of one feature (API + DB + UI) | `/team` | A Project Manager plans, engineers build, a read-only Safety Reviewer checks. You approve the plan first (unless auto mode is on). |
| The same, but faster | `/team` plus `/parallel` | Independent tasks run at the same time, each only allowed to write inside its own folders. Needs auto-write and auto-run. |
| Failed commands fixed by themselves | `/auto-debug` | The Debug Agent runs when a command fails, then the command is re-run. Needs auto-write and auto-run. |
| Current facts (latest API, version, docs) | `/research` | Needs a Gemini key. Sends your question and a file-name overview to Google. |

The same switches are in the dashboard, in the Prompt panel.

### When team mode is worth it

Use `/team` when the task needs more than one kind of work: "add checkout with API, DB and UI". For one file or one bug, a single agent is faster and less likely to wander.

### Writing prompts for parallel runs

The Project Manager splits your task and gives every part a **write scope** (the folders it may write) and what it must wait for. You help it by making the split obvious:

> Add comments to posts. Database: add a `Comment` model in `apps/api/prisma/schema.prisma` and a migration. API: `apps/api/src/comments/` with `POST /posts/:id/comments` and `GET /posts/:id/comments`, depending on the schema. Web: a comments section in `apps/web/src/app/posts/[id]/`, depending on the API.

What this does: the database task goes first and publishes the schema as a contract, then the API and web tasks can follow it. If the plan has overlapping folders or a cycle, it falls back to one task after another, and tells you why.

Honest limit: a local model serves requests one after another or a few at a time, so parallel runs overlap mostly the *waiting* (installs, builds, tests), not the thinking. Do not expect a four-times speed-up.

### What auto-debug can and cannot do

It reacts to a failed command (missing package, wrong import, schema error, build error), asks the Debug Agent to fix that one failure, and re-runs the command. It is the same model with the same knowledge, so it cannot fix something the model does not know. If it reports "no safe patch", read the finding: it usually tells you what is missing. Risky commands and commands outside the project are never re-run automatically.

**It gives up after 5 attempts on the same command** (`AGENT_AUTO_DEBUG_ATTEMPTS`). There is no sixth try: the run stops and prints a **Project Failure & Triage Report** with four sections: system telemetry and architecture (stack, folders looked at, attempts used), execution log and blockers (the failing command and its exact output), root cause analysis (what each attempt did), and required user intervention (at most two direct questions). Answer those questions in your next prompt, with the new fact, and the agent continues from there.

---

## 6. UI and design prompts

The model cannot see pictures, so "make it look good" produces generic output, and sometimes no styling at all. Give it facts.

### Give a design brief, not an adjective

Include:

- **Palette**: background, surface, text, accent (hex values).
- **Typography**: font family, a size scale (for example 14 / 16 / 20 / 32), weights.
- **Spacing and shape**: 8px grid, radius, border, shadow level.
- **Layout**: columns per breakpoint, max width, header and footer content.
- **Components and states**: button variants, card, input, empty, loading, error.
- **Reference**: `/image path/to/screenshot.png` turns a picture into a text design brief that is added to every following task. Look at that brief (`/image show`) and correct it if it is wrong.

### Build the foundation first, then pages

1. A prompt for the **design foundation**: tokens in `globals.css` (`@theme` for Tailwind 4), base components (Button, Card, Input), layout shell.
2. Check that the page is **actually styled** (see below).
3. Then **one page per prompt**, each referring to the foundation: "use the existing `Button` and `Card`, do not write new colours".

### Make sure styling is really wired up

A Next.js app with Tailwind 4 needs four things, or it renders as plain unstyled HTML without any error: `tailwindcss` and `@tailwindcss/postcss` installed, a `postcss.config.mjs`, `@import "tailwindcss";` at the top of `globals.css`, and the layout importing `globals.css`. The design agent now runs the `check_styles` tool to verify this. You can say it in the prompt too:

> Run `check_styles` and fix every FAIL before you report.

If a page looks like plain HTML, paste `globals.css`, `layout.tsx`, `package.json` and a directory listing into a debug task. It is almost always the pipeline, not the components.

### Ask for what it can verify

`check_styles` proves the styling pipeline exists. `inspect_page` (needs a running dev server URL, or a static `.html` file; run `npx playwright install chromium` once) reports console errors, failed requests, horizontal overflow at phone and desktop width, and accessibility problems. Start the dev server yourself and give the URL:

> The dev server runs at http://localhost:3000. Run `inspect_page` on `/cars` and fix every console error, failed request and overflow it reports.

Neither tool judges beauty. Look at the page yourself and send concrete corrections: "the card title is 12px, make it 20px semibold; the grid has no gap; the header is not sticky".

---

## 7. Fixing bugs

The best debug prompt has four parts: **what you ran, what you expected, the exact output, and what changed since it last worked.**

> `npm --prefix apps/api test` fails after I added the Comment model. Expected: all tests pass. Output:
> ```
> <paste the real error, at least the first error and its stack>
> ```
> Last working state: commit `abc123`. Only change the minimum needed; do not rewrite the module.

Tips:

- Paste the **first** error, not the last. Later errors are usually consequences.
- Use `/use debug` or `run -a debug`. It is told to reproduce, find the cause, fix, and prove the fix.
- With auto-debug on, a command that still fails after 5 debug attempts ends the run with a **triage report** (section 5). Answer its questions; do not just re-send the same prompt.
- If it fails the same way three times it must stop and give a **stuck report** (what it tried, what it believes is missing). Read it. It tells you what to supply: a version, a config file, a doc page.
- Version problems (Prisma 7, ESM vs CommonJS, Tailwind 4) are the most common loops. Say the exact version you want in the prompt.
- Do not ask the agent to "try something else" without information. Give it a new fact.

---

## 8. Reading the result

Every run ends with a summary. Read three things:

| Section | What to check |
| --- | --- |
| **Files** | Are these the files you expected? Anything outside the paths you named? |
| **Verified by** | Which commands ran and what they showed. "It should work" is not verification. |
| **Not verified** | What the agent could not prove (looks, real database, third-party services). That part is on you. |

Then do your own check: run the command from "Done when", open the page, look at `git diff`. Commit the slice if it is green, so the next slice starts from a known state.

If the summary claims something that is not true (a file that does not exist, a test that was not run), say so with the evidence: "You said X. `ls` shows no such file. Do it."

---

## 9. Common mistakes and the fix

| Mistake | What happens | Do this instead |
| --- | --- | --- |
| One giant prompt for the whole app | It does the first part, skims the rest, and ships placeholders | Slice it (section 4) |
| No "must pass" command | It stops after writing files, untested | End with the exact command |
| Stack not named in an empty project | Old or different libraries | `AGENTS.md` or name it in the prompt |
| "Make it look good" | Generic or unstyled UI | Design brief and a foundation first (section 6) |
| Moving on while red | Errors pile up, the model fixes the wrong layer | Fix or revert the slice first |
| Pasting only "it doesn't work" | It guesses | Paste the command and the real output |
| Letting it install whatever it likes | Two UI libraries, two state libraries | "Do not add dependencies" or "only add X" |
| Auto mode on a folder without git | A bad run is hard to undo | `git init` and commit first |
| Repeating a correction every prompt | Wasted tokens and drift | Put the rule into `AGENTS.md` |

---

## 10. If it goes wrong

1. **Stop it.** Ctrl+C stops the running command (and, in a parallel team run, the whole team). Ctrl+C again when idle exits. In the dashboard, use the Stop button.
2. **Look at what changed**: `git status` and `git diff`.
3. **Decide**: keep (if mostly right), or `git restore .` / `git checkout .` to throw the slice away.
4. **Retry smaller**: split the prompt, name the files, add the missing fact the stuck report asked for.
5. **Change the specialist**: `/use debug` for a failure, `/use logic` for a design or reasoning problem, `/use db` for schema trouble.

When the same kind of mistake appears again and again, it is not the model being stubborn: a rule is missing. Write it into `AGENTS.md`.

---

## 11. Copy-paste templates

### New feature slice

```
GOAL: <what exists when done>
WHERE: <folders and files to create or change>
FOLLOW: <an existing file to copy conventions from>
RULES: <what must not happen; no new dependencies unless named>
DONE WHEN: `<command>` passes. <anything I can check by hand>
```

### Bug report

```
I ran: <command>
Expected: <what should happen>
Got:
<exact output, first error first>
Changed since it worked: <commit, dependency, file>
Fix with the smallest change. Prove it by running <command> again.
```

### UI page

```
GOAL: page <route> in <app path>.
LAYOUT: <columns per breakpoint, header/footer, max width>
CONTENT: <exact fields, labels, example text>
STATES: loading, empty, error, and <other>.
STYLE: use existing tokens/components from <files>; no new colours or libraries.
VERIFY: run check_styles, then `npm --prefix apps/web run build`. Dev server: <url>, run inspect_page on <route>.
```

### Team task (parallel)

```
/team
Add <feature>.
Database: <schema change, file>. 
API: <module folder, endpoints, depends on database>.
Web: <page folder, depends on API>.
Each part must build: <commands>.
```

### Refactor, safely

```
Refactor <module> without changing behaviour.
First run `<test command>` and note the result. Change only files under <folder>.
Run the same command after: the results must match. List every file you touched.
```

---

## 12. Quick checklist before you press Enter

- [ ] The project is in git and the last slice is committed.
- [ ] One concern in this prompt.
- [ ] Paths are named, or an existing file to copy from is named.
- [ ] The stack is in `AGENTS.md` or in the prompt.
- [ ] Things that must not happen are written down.
- [ ] The prompt ends with a command that must pass.
- [ ] For UI: a design brief, and `check_styles` / `inspect_page` are asked for.
- [ ] For several parts: `/team`, with the order and the folders obvious.
- [ ] For a platform step (install, migrate, native build): the exact command and the folder to run it in.
- [ ] I know how I will check the result myself.
