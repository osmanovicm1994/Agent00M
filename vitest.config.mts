import { defineConfig } from "vitest/config";

// Unit tests live next to the code as src/**/*.test.ts. The web/ dashboard and the vendored knowledge
// folder (src/knowledge/uupm is a nested git clone) are not part of this test run.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "_to_delete", "web", "src/knowledge/**"],
  },
});
