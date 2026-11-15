import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/target/**"],
    environment: "node",
  },
});
