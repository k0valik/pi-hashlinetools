import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["profiling/**", "node_modules/**"],
  },
});
