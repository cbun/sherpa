import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/http.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  platform: "node",
  target: "node22",
  external: ["node:sqlite"]
});
