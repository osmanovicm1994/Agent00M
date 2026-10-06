import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The agent server only accepts browser WebSocket connections from this origin (src/server.ts).
  server: { port: 5173, strictPort: true },
});
