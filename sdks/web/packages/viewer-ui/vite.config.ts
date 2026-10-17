// The standalone bundle: <medalbot-viewer> with React included, for a plain
// HTML page that loads one script. Bundler users import the package instead.
// An app build rather than library mode, because library mode keeps
// whitespace in ES output.

import { defineConfig } from "vite";

export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist/standalone",
    emptyOutDir: true,
    target: "es2023",
    copyPublicDir: false,
    rollupOptions: {
      input: "src/element.ts",
      preserveEntrySignatures: "exports-only",
      output: { format: "es", entryFileNames: "medalbot-viewer.js" },
    },
  },
});
