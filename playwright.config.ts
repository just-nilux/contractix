import { defineConfig, devices } from "@playwright/test";

/**
 * One browser-level smoke test over the whole stack.
 *
 * `pnpm dev` is the server command because `scripts/dev.ts` already starts the
 * API, the worker and Vite together - exactly the three processes the flow
 * needs, and the same entry point a developer uses. (`vite preview` is not an
 * option: `server.proxy` does not apply to preview, so the `/api` prefix would
 * need a second proxy config that nothing else uses.)
 *
 * `workers: 1` because the flow adopts the demo corpus, and `POST /demo/adopt`
 * is limited to three per hour per IP. Parallel workers would spend the budget
 * on themselves.
 */
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Generation is a real model call on a keyed run; the default 30 s is tight.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
