import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  sourcemap: true,
  clean: true,
  // Workspace source packages must be bundled (they ship TS, not JS).
  noExternal: [/^@contractix\//],
});
