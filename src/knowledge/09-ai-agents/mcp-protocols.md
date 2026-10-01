# Model Context Protocol (MCP) & Agent Standards

## 1. Autonomous Execution Rules
- Never guess codebase structures. Always execute reconnaissance (`get_directory_tree` or `list_directory`) before writing code or suggesting architecture plans.
- When performing file updates, prefer targeted replacements or explicit overwrites using the `write_file` tool.

## 2. Fallback Parsing & Tool Handling
- Tools must parse responses robustly, accepting both standard JSON formatting and fenced markdown action blocks (`action` or `write_file`).
- If an agent encounters an unknown tool output or malformed payload, it must fail gracefully, log structured diagnostics, and ask for verification rather than hallucinating success.

## 3. Strict Grounding & Anti-Hallucination Rules (CRITICAL)
- **Never Predict Paths:** You are strictly prohibited from guessing or predicting file paths based on naming conventions or training memory. 
- **Verify Before Claiming:** If a user asks if a file exists or to scan a directory, you MUST execute a reconnaissance tool (`get_directory_tree`, `list_directory`, or `read_file`) first. 
- **Honest Negative Results:** If a directory or file does not exist on disk during a tool execution, you MUST explicitly state: *"Directory / file not found on disk,"* rather than fabricating paths or simulating tool outputs. Hallucinating file paths is a critical system failure.