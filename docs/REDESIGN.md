# Dashboard redesign: dockable panels, live feed, project tree, design preview

Status: implemented, **not yet run**. Run the checks at the bottom first.

## What changed

| Area | Behavior |
| --- | --- |
| Panels | The wide-screen dashboard is a docking workspace. Drag a tab onto the middle of a panel to join it, onto an edge to split, onto a tab bar to reorder. Drag dividers to resize (arrow keys work too). `⋯` on a group pops a panel out as a floating window (Dock / ✕ in its title bar). Esc cancels a drag. |
| Layout | Header menus **Panels** and **Layout**. Presets: Coding, Design, Monitor. Saved in `localStorage` (`agent-ui-layout-v1`), exportable and importable as JSON in Settings. Damaged or hand-edited layouts are repaired by `validateLayout`. |
| Phone | Below 1024 px one panel at a time with the bottom bar (Live, Prompt, Project, Preview, Agents, More). |
| Live | Streams every event, keeps 5000 in memory, draws the newest 600 (button loads earlier ones). Follows the newest output like a terminal, pauses when you scroll up, "Jump to latest" resumes. Running command output follows its own newest line. Filters: All, Commands, Thinking, Files, Warnings. |
| Project tree | Full tree like `tree -I 'node_modules\|.git'`. Default ignore: `node_modules\|.git\|.agent_cache` (editable in Settings). Collapsible, filter, Tree/Text view with Copy, changed files highlighted live, only visible rows are drawn. Click a file to add it to the prompt. |
| Design preview | Pick an HTML file of the project (or a local dev server). Reloads when a file changes, follows the newest HTML the agent writes, device sizes, rotate, zoom, version compare. **Pick element**: click an element, describe the change, and it is sent to the agent with selector, HTML and source line. |
| Settings | One panel: agent switches, layout, tree ignore list, notifications, guide. |

## Files

Backend (`src/`)
- `core/event-types.ts`: `list_files` accepts `full` and `ignore`; new messages `files_changed` and `preview`.
- `core/file-tree.ts`: `ignore` patterns (`*`, `?`), `sanitizeIgnore`, `compileIgnore`, `DEFAULT_TREE_IGNORE`.
- `core/workspace-watch.ts` (new): debounced recursive `fs.watch`, reports relative paths only.
- `core/preview.ts` (new): safe path resolution, sandboxed responses, `<base>` and element-picker injection.
- `server.ts`: `GET /preview/<key>/<path>`, watcher shared by control connections, `list_files` options.

Web (`web/`)
- `vite.config.ts`: proxies `/preview` next to `/ws`.
- `src/layout/` (new): `model.ts` (pure, tested), `Workspace.tsx`, `useLayout.ts`.
- `src/components/`: `TreePanel`, `PreviewPanel`, `SettingsHub` (new); `LiveFeed` (rewritten).
- `src/Dashboard.tsx` (rewritten), `state.ts`, `useAgentSocket.ts`, `useStickToBottom.ts`, `prefs.ts`, `treeText.ts`, `preview/helpers.ts`.
- `vitest.config.mts` now also runs `web/src/**/*.test.ts`.

## Security notes

The preview route is a read-only HTTP window onto the project folder.
- Needs a random key sent only to token holders over the WebSocket.
- Rejects `..`, backslashes, any hidden segment (`.git`, `.env*`) and symlinks that leave the folder or point at hidden files; 8 MB limit.
- Every response carries `Content-Security-Policy: sandbox ...`: scripts run, but in an opaque origin that cannot read the dashboard's storage or token.
- Project HTML is shown in an iframe without `allow-same-origin`. Only the dev-server mode (your own localhost server) is trusted with its own origin.

## Next.js and other dev-server projects

A Next.js repo has no `.html` files: its pages are `.tsx` files that only render through a running server. Use **Dev server** mode.
- When the agent runs `npm run dev`, the address (`http://localhost:3000`) is read from the command output and opened automatically while **Follow agent** is on (not when you view the dashboard from another device).
- **Go to page** lists the pages found in `app/**/page.tsx` or `pages/` (route groups, slots and API routes are left out; dynamic pages like `/users/[id]` are disabled).
- Next hot reload updates the frame as the agent edits files.
- Dev-server mode is view only. Pick element works only for project HTML files, because it needs the script the dashboard injects into them.

## Limits

- Preview is for web UI. iOS/SwiftUI screens cannot render in a browser; the options are Simulator screenshots via `xcrun simctl`, or an HTML mock per screen. Not built.
- Version compare stores the HTML of each change; linked CSS and scripts always show the current files.
- Recursive `fs.watch` needs macOS, Windows or Node 20+ on Linux. Without it the dashboard refreshes after each file the agent writes.
- The file picker modal (Add files) still uses the old `FilesPanel`.

## Checks to run

```bash
cd "/Users/mustafaosmanovic/testLocalMustafa/WEB PROJECT/AGENT"
npm test
npx tsc --noEmit -p tsconfig.json
cd web && npx tsc --noEmit && npm run build
```

Then `npm run chat:ui` and try: drag a tab, change a preset, ask the design agent for an `index.html`, open Design preview, use Pick element.
