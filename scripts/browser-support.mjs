import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isPathInside } from "../lib/portable-paths.mjs";

// Child processes must not inherit production credentials, data paths or proxies.
export function browserEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(OPENAI|NOVEL|MODEL|ANTHROPIC|AZURE_OPENAI|GEMINI|GOOGLE_API_KEY|HF_TOKEN|HUGGING_FACE_HUB_TOKEN|NODE_OPTIONS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)/i.test(key)));
}

export async function browserFixture(env = process.env) {
  const base = env.NOVEL_BROWSER_URL;
  assert.match(base || "", /^http:\/\/127\.0\.0\.1:\d+$/, "Browser QA requires the isolated loopback fixture URL");
  assert.ok(env.NOVEL_BROWSER_ARTIFACTS, "Browser QA requires its isolated fixture directory");
  const artifacts = await realpath(resolve(env.NOVEL_BROWSER_ARTIFACTS));
  const verification = await realpath(resolve("output/verification"));
  assert.ok(isPathInside(verification, artifacts), "Refuse browser writes outside output/verification");
  const health = await fetch(base + "/api/health", { signal: AbortSignal.timeout(10000) });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("X-Novel-Verification"), "loopback-mock", "Refuse browser writes against a production service");
  return { base, artifacts };
}

export async function browserTools(env = process.env) {
  if (!env.NOVEL_PLAYWRIGHT_MODULE) return import("@playwright/test");
  const { chromium } = await import(pathToFileURL(env.NOVEL_PLAYWRIGHT_MODULE).href);
  const { expect } = await import(pathToFileURL(join(env.NOVEL_PLAYWRIGHT_MODULE, "../test.mjs")).href);
  return { chromium, expect };
}

export function waitForBrowserFixture(child, exited, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer); child.off("message", message); signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(value);
    };
    const message = value => { if (value?.type === "browser-fixture-ready") finish(null, value); };
    const aborted = () => finish(signal.reason || new Error("Browser acceptance interrupted"));
    const timer = setTimeout(() => finish(new Error("Isolated fixture startup timed out; see fixture.log")), 180000);
    child.on("message", message); signal.addEventListener("abort", aborted, { once: true });
    exited.then(result => finish(new Error(`Isolated fixture exited before acceptance: ${JSON.stringify(result)}`)));
    if (signal.aborted) aborted();
  });
}

// IPC lets the coordinator close Chromium gracefully on Windows as well as Unix.
export function managedBrowser(browser) {
  const stop = () => { process.exitCode = 1; void browser.close().catch(() => {}); };
  const message = value => { if (value?.type === "stop-browser-suite") stop(); };
  process.on("message", message); process.once("disconnect", stop);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  browser.once("disconnected", () => {
    process.off("message", message); process.off("disconnect", stop);
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    if (process.connected) process.disconnect();
  });
  return browser;
}
