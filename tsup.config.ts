import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "bin/deep-health.ts"],
  format: ["esm"],
  target: "node24",
  clean: true,
  dts: true,
  sourcemap: false,
  splitting: false,
  external: ['googleapis', 'google-auth-library'],
});
