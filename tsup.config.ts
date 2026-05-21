import { defineConfig } from "tsup";

const shared = {
  format: ["esm"] as const,
  target: "node26" as const,
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
  {
    // SEA (Single Executable Application) bundle — CJS only, all deps inlined.
    // Node.js 26 SEA requires CJS; ESM is not supported in stable SEA.
    // googleapis and google-auth-library remain external (optional deps loaded
    // via dynamic import with try/catch — not required for core functionality).
    entry: ["bin/deep-health.ts"],
    format: ["cjs"],
    outDir: "dist-sea",
    noExternal: [/.*/],
    external: ['googleapis', 'google-auth-library'],
    splitting: false,
    sourcemap: false,
    clean: false,
    dts: false,
    target: "node26",
    define: {
      'process.env.CLI_NAME': JSON.stringify(process.env['CLI_NAME'] || 'deep-health'),
      'process.env.NPM_DEFAULT_FIXER': JSON.stringify(process.env['NPM_DEFAULT_FIXER'] || 'osv-then-audit'),
    },
  },
]);
