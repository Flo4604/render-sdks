// Loads a published item through the render API in headless Chrome with
// WebGPU and checks that the viewer becomes ready. Skipped unless all three
// variables are set, because it needs a closure key and a published closure:
//
//   VIEWER_API_URL   the render API origin, for example https://render.medalbot.cc
//   VIEWER_API_KEY   a closure:read key that allows the origin http://127.0.0.1
//   VIEWER_ITEM      defindex-paintindex-paintseed-paintwear of a published closure
//
// It also skips when Chrome starts but finds no WebGPU adapter with the
// engine's required features.

import assert from "node:assert/strict";
import test from "node:test";

import { launchChrome, servePage, settledStatus } from "./harness.ts";

test("the element loads a published closure and becomes ready", { timeout: 600_000 }, async (t) => {
  const api = process.env.VIEWER_API_URL;
  const apiKey = process.env.VIEWER_API_KEY;
  const item = process.env.VIEWER_ITEM;

  if (api === undefined || apiKey === undefined || item === undefined) {
    t.skip("VIEWER_API_URL, VIEWER_API_KEY and VIEWER_ITEM are not set, so there is no closure to load");

    return;
  }

  const browser = await launchChrome(["--enable-unsafe-webgpu"]);

  if (typeof browser === "string") {
    t.skip(browser);

    return;
  }

  t.after(() => browser.close());
  const server = await servePage({ api, "api-key": apiKey, item });
  t.after(() => server.close());
  const page = await browser.newPage();
  await page.goto(server.url);
  const status = await settledStatus(page, 300_000);

  if (status === "unsupported") {
    t.skip("Chrome has no WebGPU adapter with the required features on this machine");

    return;
  }

  assert.equal(status, "ready");
});
