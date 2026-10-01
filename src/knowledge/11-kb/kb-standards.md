# Knowledge Base Documentation Standards

## 1. Evidence Only
- Every statement must come from files you actually read. Cite the source path next to the claim (e.g. `(src/core/executor.ts)`).
- Mark anything you could not verify as "Unverified" rather than guessing. Never invent endpoints, tables, env vars or commands.

## 2. Required Sections
1. **Overview**: what the project does, main technologies, entry points.
2. **Architecture**: layers / modules, how they interact, data flow. A short ASCII or Mermaid diagram is welcome.
3. **Directory Map**: important folders and what lives in each (skip generated code and vendored folders).
4. **Key Components**: purpose, public interface and dependencies of each important module.
5. **Configuration**: environment variables (names and meaning only, NEVER values or secrets), config files.
6. **Setup & Commands**: install, build, run, test, taken from package manifests / scripts / README.
7. **Conventions & Gotchas**: naming, patterns, known pitfalls found in the code.

## 3. Style
- Concise, scannable Markdown: headings, short paragraphs, tables for lists of endpoints / env vars / commands.
- Code blocks get a language tag. Use exact identifiers from the code.
- Never copy secrets, tokens or credentials from `.env*` files into documentation.

## 4. Output
- Write to `docs/KNOWLEDGE_BASE.md` unless the task names another path. Long documents are written in chunks (`write_file` then `append_file`); because the document contains code fences, open the block with four backticks.
