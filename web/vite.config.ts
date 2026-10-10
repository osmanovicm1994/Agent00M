import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// `npm run chat:ui:lan` sets AGENT_UI_LAN=1 so the dashboard is also served to other devices on
// your Wi-Fi (e.g. your phone). Without it Vite stays on localhost only.
const lan = ["1", "on", "true", "yes"].includes(String((globalThis as any).process?.env?.AGENT_UI_LAN ?? "").trim().toLowerCase());

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The agent server only accepts browser WebSocket connections from known origins (src/server.ts).
  server: { port: 5173, strictPort: true, host: lan ? true : undefined },
});
