// Measures what each public entry adds to a page after minification, and
// fails when an entry grows past its budget. Run after `npm run build`.
//
//   node scripts/size.ts [--json]
//
// Each entry is bundled the way an application bundler would see it, with
// React external where the package declares it as a peer dependency. The
// standalone custom element is measured as built, because pages load that
// file as it is.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { build, type Rollup } from "vite";

interface Entry {
  name: string;
  source?: string;
  file?: string;
  external?: string[];
  budgetGzip: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const react = ["react", "react-dom", "react-dom/client", "react/jsx-runtime"];

// Budgets in gzipped bytes, roughly 15 percent above the measurement in
// README.md. Raise one only with the reason in the commit message.
const entries: Entry[] = [
  {
    name: "engine: createViewer, detectSupport, apiFetcher",
    source: `export { apiFetcher, createViewer, detectSupport } from "@medalbot/viewer-engine";`,
    budgetGzip: 29_500,
  },
  {
    name: "engine: everything in the main entry",
    source: `export * from "@medalbot/viewer-engine";`,
    budgetGzip: 30_000,
  },
  {
    name: "ui: MedalbotViewer (React external)",
    source: `export { MedalbotViewer } from "@medalbot/viewer-ui";`,
    external: react,
    budgetGzip: 50_500,
  },
  {
    name: "ui/element (React external)",
    source: `import "@medalbot/viewer-ui/element";`,
    external: react,
    budgetGzip: 61_000,
  },
  {
    name: "ui/standalone (React included)",
    file: "packages/viewer-ui/dist/standalone/medalbot-viewer.js",
    budgetGzip: 141_000,
  },
];

async function bundle(source: string, external: string[]): Promise<Uint8Array> {
  const scratch = join(root, "node_modules", ".size-entries");
  await mkdir(scratch, { recursive: true });
  const input = join(scratch, `entry-${Math.random().toString(36).slice(2)}.js`);
  await writeFile(input, `${source}\n`);

  try {
    const result = (await build({
      configFile: false,
      logLevel: "silent",
      root: scratch,
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        write: false,
        target: "es2023",
        minify: "esbuild",
        rollupOptions: {
          input,
          external,
          preserveEntrySignatures: "exports-only",
          output: { format: "es" },
        },
      },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs.flatMap((output) => output.output).filter((item) => item.type === "chunk");

    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.code)));
  } finally {
    await rm(input, { force: true });
  }
}

const rows: Array<{ name: string; bytes: number; gzip: number; budgetGzip: number }> = [];

for (const entry of entries) {
  const bytes =
    entry.file === undefined
      ? await bundle(entry.source ?? "", entry.external ?? [])
      : await readFile(join(root, entry.file));
  rows.push({
    name: entry.name,
    bytes: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    budgetGzip: entry.budgetGzip,
  });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const kb = (value: number) => `${(value / 1000).toFixed(1)} KB`;

  for (const row of rows) {
    console.log(`${row.name.padEnd(52)} ${kb(row.bytes).padStart(10)} ${kb(row.gzip).padStart(10)} gzip (budget ${kb(row.budgetGzip)})`);
  }
}

const over = rows.filter((row) => row.gzip > row.budgetGzip);

if (over.length > 0) {
  console.error(`Over budget: ${over.map((row) => row.name).join(", ")}`);
  process.exitCode = 1;
}
