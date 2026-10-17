// Writes src/styles-text.generated.ts from src/styles.css, so the custom
// element can put the stylesheet into its shadow root without a bundler.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const css = await readFile(`${root}src/styles.css`, "utf8");
await writeFile(
  `${root}src/styles-text.generated.ts`,
  `// Generated from styles.css by scripts/styles-module.ts. Do not edit.\n\nexport const styles =\n  ${JSON.stringify(css)};\n`,
);
