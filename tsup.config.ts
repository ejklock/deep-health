import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "bin/deep-health.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: true,
  sourcemap: false,
  splitting: false,
});
