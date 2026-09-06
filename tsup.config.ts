import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  target: "es2022",
  splitting: false,
  sourcemap: true,
  external: ["express"],
  // Browser bundle: exclude Node built-ins, usable in React/Vite SPAs
  esm: {
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
  },
});
