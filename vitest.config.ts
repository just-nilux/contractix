import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["**/*.int.test.ts"],
        },
      },
      {
        // Integration tests hit the docker-compose Postgres/Redis and exercise
        // the mupdf WASM parser - forks pool keeps WASM instantiation stable.
        test: {
          name: "integration",
          include: ["packages/*/src/**/*.int.test.ts"],
          pool: "forks",
          setupFiles: ["./vitest.integration.setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
