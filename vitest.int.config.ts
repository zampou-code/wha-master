import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.int.test.ts"],
    globalSetup: ["tests/int-setup.ts"],
    fileParallelism: false,
  },
});
