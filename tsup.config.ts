import { defineConfig } from "tsup";

const shared = {
  format: ["esm"] as const,
  target: "node24" as const,
  sourcemap: false,
  splitting: false,
  external: ['googleapis', 'google-auth-library'],
};

export default defineConfig([
  {
    // Library entry — generates DTS for programmatic consumers
    ...shared,
    entry: ["src/index.ts"],
    clean: true,
    dts: true,
  },
  {
    // CLI binary — no DTS needed (not imported as a library)
    ...shared,
    entry: ["bin/deep-health.ts"],
    clean: false, // preserve library output from first build
    dts: false,
  },
]);
