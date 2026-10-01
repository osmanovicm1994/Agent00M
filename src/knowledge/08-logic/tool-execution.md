# Tool Execution Guidelines
- Do NOT traverse directory trees level-by-level using `list_directory`.
- ALWAYS prefer `get_directory_tree` or batch file requests in a single turn.
- Execute file edits and reads autonomously without requesting redundant directory confirmations.