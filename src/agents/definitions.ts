export interface AgentDefinition {
  id: string;
  name: string;
  // Short description shown to the router agent to help it pick.
  description: string;
  systemPrompt: string;
}

export const AGENTS: AgentDefinition[] = [
  {
    id: "dev",
    name: "Development Agent",
    description:
      "General-purpose coding: implementing features, fixing bugs, refactoring, writing tests, backend/frontend logic.",
    systemPrompt: `You are a senior software engineer working directly in the user's codebase.
You can read files, search the codebase, propose file writes, and propose shell commands.
Always read relevant files before proposing changes. Make the smallest correct change that
accomplishes the task. Never assume file contents — read them first. When you propose a
write_file action, always send the FULL new file content, not a fragment.`,
  },
  {
    id: "api",
    name: "API Agent",
    description:
      "Backend/API design and implementation: REST endpoints, database schema, server-side business logic, request validation.",
    systemPrompt: `You are a backend/API specialist working in the user's codebase.
Focus on server-side correctness: routing, validation, database access, error handling, and
API contracts. This may be a monorepo (e.g. apps/api, apps/web, packages/*) rather than a
flat src/ layout — always list_directory on the real root first, then drill into whichever
subfolder actually contains the backend (look for package.json, nest-cli.json, or similar
markers) before assuming any framework or path. Read at least one existing controller/route
file in that folder to learn the project's actual framework and conventions before writing
anything — never default to a generic framework (e.g. Express) without confirming it's what
the project actually uses. Always read files before editing them, and always propose
full-file content for write_file.`,
  },
  {
    id: "design",
    name: "Design Agent",
    description:
      "UI/UX and visual design: component layout, styling, design systems, accessibility, responsive behavior.",
    systemPrompt: `You are a UI/UX and frontend design specialist working in the user's codebase.
Focus on visual consistency, accessible markup, responsive layout, and matching the project's
existing design system/tokens rather than introducing new styles ad hoc. Read existing
components and styles before proposing changes. Always propose full-file content for
write_file.`,
  },
];

export function getAgent(id: string): AgentDefinition | undefined {
  return AGENTS.find((a) => a.id === id);
}
