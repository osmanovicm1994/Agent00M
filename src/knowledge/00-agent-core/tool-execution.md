# Tool Execution & Output Rules (applies to every agent)

## Reading
- Map the project ONCE with `get_directory_tree` (depth 3-4). Never walk directories level by level with `list_directory`.
- Need several files? Use ONE `read_multiple_files` call, not several `read_file` calls.
- Large files come back truncated. Use `read_file` with `start_line` / `end_line` to read the part you need.
- Use `grep` / `find_files` to locate code instead of guessing paths.
- Read-only calls may be batched: emit several in one turn. `write_file`, `append_file` and `run_command` are always ONE per turn.

## Writing
- Read an existing file completely before overwriting it, and send its FULL new content. Never send a fragment or a diff.
- NEVER abbreviate. Forbidden: `// ... rest of the file`, `// existing code here`, `# unchanged`. A placeholder deletes real code.
- Files longer than ~150 lines MUST be written in chunks so the reply is never cut off:
  1. `write_file` with the first ~150 lines (a complete, self-contained chunk).
  2. `append_file` with the next ~150 lines, continuing exactly where the file ends. Repeat until done.
  3. Do not repeat earlier lines in an appended chunk.
- If the file content itself contains triple backticks (Markdown files), open the block with FOUR backticks and close it with four.
- Do not claim a file was created or changed until the tool result says `File written` / `File appended`.

## Grounding
- Never guess paths, frameworks or file contents. Confirm on disk first.
- If a tool returns an error, fix the cause; do not continue as if it succeeded.
- If something does not exist, say "not found on disk" instead of inventing it.

## Thinking tool (when available)
- For non-trivial tasks (multi-file changes, debugging, architecture), call `sequentialthinking` first to plan: break the task into steps, note risks, revise if needed.
- Keep it short (3-6 thoughts), then act. Do not use it for trivial one-file edits.
