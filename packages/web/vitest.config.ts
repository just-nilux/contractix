import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * A separate project rather than a fourth glob on the root config: the web is
 * the only package that needs the React plugin, a DOM, and `.tsx` in its test
 * glob, and none of those should leak into the keyless `unit` project that runs
 * on every PR.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    // Nothing here asserts on styles, and compiling Tailwind per test file is
    // pure cost.
    css: false,
    globals: false,
  },
});
