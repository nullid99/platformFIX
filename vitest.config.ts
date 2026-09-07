import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors tsconfig.json's "@/*" -> "./*" — needed for the one test so far that imports
  // server code (stream-service.test.ts) rather than a dependency-free app/domain module.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    exclude: ["**/node_modules/**", "**/e2e/**"],
  },
});
