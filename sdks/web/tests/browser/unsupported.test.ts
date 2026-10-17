// The custom element in headless Chrome without WebGPU: it must show the
// unsupported state and make no request to the API. Needs Chrome, not a GPU
// and not any closure data.

import assert from "node:assert/strict";
import test from "node:test";

import { launchChrome, servePage, settledStatus } from "./harness.ts";

test("the element shows the unsupported state when the browser has no WebGPU", async (t) => {
  const browser = await launchChrome([]);

  if (typeof browser === "string") {
    t.skip(browser);

    return;
  }

  t.after(() => browser.close());
  const server = await servePage({
    api: "http://127.0.0.1:9/never-called",
    "api-key": "closure-read-key",
    item: "7-801-661-1036831949",
  });
  t.after(() => server.close());
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on("request", (request) => {
    requests.push(request.url());
  });
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true });
  });
  await page.goto(server.url);

  assert.equal(await settledStatus(page, 30_000), "unsupported");

  const notice = await page.evaluate(
    () => document.querySelector("medalbot-viewer")?.shadowRoot?.querySelector('[part="unsupported"]')?.textContent ?? null,
  );
  assert.ok(notice !== null && notice.length > 0, "the unsupported region has text");
  assert.deepEqual(
    requests.filter((url) => url.includes("never-called")),
    [],
    "the element must not call the API without WebGPU",
  );
});
