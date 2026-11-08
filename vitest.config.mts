import { defineConfig } from "vitest/config";

// Unit tests live next to the code as src/**/*.test.ts. Pure logic of the web/ dashboard (layout model, tree text,
// URL detection) is tested too, as web/src/**/*.test.ts; those files must not import React or the DOM. The
// vendored knowledge folder (src/knowledge/uupm is a nested git clone) is not part of this test run.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist", "_to_delete", "src/knowledge/**"],
  },
});
