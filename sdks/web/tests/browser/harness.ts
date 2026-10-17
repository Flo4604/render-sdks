// Serves the built standalone custom element on a local page and opens it in
// headless Chrome. Build first (`npm run build`). Tests skip, with the reason,
// when Chrome cannot start; set CHROME_PATH to use a specific binary.

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Browser, chromium, type Page } from "playwright-core";

const standalone = fileURLToPath(new URL("../../packages/viewer-ui/dist/standalone/", import.meta.url));

export interface PageServer {
  url: string;
  close: () => Promise<void>;
}

// The page holds one <medalbot-viewer> with the given attributes.
export async function servePage(attributes: Record<string, string>): Promise<PageServer> {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const element = Object.entries(attributes)
    .map(([name, value]) => `${name}="${escape(value)}"`)
    .join(" ");
  const page = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="/medalbot-viewer.css">
<script type="module" src="/medalbot-viewer.js"></script></head>
<body><medalbot-viewer ${element} style="display:block;width:640px;height:480px"></medalbot-viewer></body></html>`;
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html" }).end(page);

      return;
    }

    if (path === "/medalbot-viewer.js" || path === "/medalbot-viewer.css") {
      const type = path.endsWith(".js") ? "text/javascript" : "text/css";
      readFile(join(standalone, path.slice(1))).then(
        (bytes) => {
          response.writeHead(200, { "content-type": type }).end(bytes);
        },
        () => {
          response.writeHead(404).end();
        },
      );

      return;
    }

    response.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, "127.0.0.1", done);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  };
}

// Chrome from CHROME_PATH or the installed stable channel, or the reason it
// could not start.
export async function launchChrome(args: string[]): Promise<Browser | string> {
  const executablePath = process.env.CHROME_PATH;

  try {
    return await chromium.launch({
      headless: true,
      args,
      ...(executablePath === undefined ? { channel: "chrome" } : { executablePath }),
    });
  } catch (error) {
    return `Chrome did not start: ${String(error).split("\n")[0]}`;
  }
}

// Waits until the viewer reaches a final status and returns it.
export async function settledStatus(page: Page, timeout: number): Promise<string> {
  const handle = await page.waitForFunction(
    () => {
      const host = document.querySelector("medalbot-viewer")?.shadowRoot;
      const status = host?.querySelector<HTMLElement>(".mv")?.dataset.status;

      return status === "ready" || status === "unsupported" || status === "error" ? status : null;
    },
    undefined,
    { timeout, polling: 100 },
  );

  return (await handle.jsonValue()) as string;
}
