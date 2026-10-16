// Real Chromium clicks against an owned, synthetic loopback service only.
import { fork, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { browserEnvironment, browserTools, browserFixture, waitForBrowserFixture } from "./browser-support.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const directory = join(root, "output", "verification", `browser-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
mkdirSync(directory, { recursive: true });
const env = browserEnvironment();
for (const key of ["NOVEL_PLAYWRIGHT_MODULE", "NOVEL_BROWSER_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key];
const report = { node: process.version, model: "loopback-mock", paidCalls: 0, realReaderResponses: 0, records: [], artifacts: directory };
const save = () => writeFileSync(join(directory, "results.json"), JSON.stringify(report, null, 2));
let fixture, fixtureExit, current, killTimer, interrupted = false;
const cancellation = new AbortController();
function capture(child, filename) {
  const log = join(directory, filename);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => appendFileSync(log, chunk));
  return new Promise(resolve => {
    child.once("error", error => resolve({ code: null, error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
function sendStop(child, type) {
  if (!child?.connected) return;
  try { child.send({ type }, () => {}); }
  catch (error) { if (error.code !== "ERR_IPC_CHANNEL_CLOSED") report.cleanupError = error.message; }
}
function stopSuite() {
  if (!current) return;
  sendStop(current, "stop-browser-suite");
  const child = current; clearTimeout(killTimer); killTimer = setTimeout(() => child.kill(), 10000);
}
const stop = () => { interrupted = true; cancellation.abort(new Error("Browser acceptance interrupted")); stopSuite(); sendStop(fixture, "stop-browser-fixture"); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
try {
  // Missing browser installation is a hard failure, not a skipped acceptance test.
  const { chromium } = await browserTools(env);
  cancellation.signal.throwIfAborted();
  let probe;
  try {
    probe = await chromium.launch({ executablePath: env.NOVEL_BROWSER_EXECUTABLE, headless: true, env, timeout: 10000 });
    report.browser = probe.version();
  } finally { await probe?.close(); }
  cancellation.signal.throwIfAborted();
  fixture = fork(join(root, "tests", "api.test.mjs"), [], { cwd: root, env: { ...env, NOVEL_BROWSER_VERIFY: "1" }, execArgv: [], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  fixtureExit = capture(fixture, "fixture.log");
  const ready = await waitForBrowserFixture(fixture, fixtureExit, cancellation.signal);
  const suiteEnv = { ...env, NOVEL_BROWSER_URL: ready.base, NOVEL_BROWSER_ARTIFACTS: ready.output, NOVEL_UI_REPORT_DIR: directory };
  await browserFixture(suiteEnv);
  report.fixture = { base: ready.base, output: ready.output }; save();
  console.log(`Isolated browser fixture: ${ready.base}; evidence: ${directory}`);
  const suites = [
    ["tests/rendered-html.test.mjs"],
    ["scripts/verify-ui.mjs"],
    ["scripts/verify-ui-edge.mjs"],
    ["scripts/verify-ui-race.mjs"],
    ["scripts/verify-ui-training.mjs"],
  ];
  for (const [index, args] of suites.entries()) {
    if (interrupted) throw new Error("Browser acceptance interrupted");
    const started = Date.now(), log = `suite-${index}.log`;
    current = spawn(process.execPath, args, { cwd: root, env: suiteEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopSuite(); }, 600000);
    const result = await capture(current, log); clearTimeout(timer); clearTimeout(killTimer); current = null;
    report.records.push({ command: [process.execPath, ...args], ...result, timedOut, elapsedMs: Date.now() - started, log }); save();
    console.log(`${result.code === 0 && !timedOut ? "PASS" : "FAIL"} node ${args.join(" ")}`);
  }
} catch (error) {
  report.error = error.message;
  console.error(error.message);
  console.error("For the default browser, run npm run browser:install after npm ci --ignore-scripts.");
} finally {
  stopSuite();
  if (fixture) {
    sendStop(fixture, "stop-browser-fixture");
    const timer = setTimeout(() => fixture.kill(), 10000);
    report.fixtureExit = await fixtureExit; clearTimeout(timer);
  }
  process.off("SIGINT", stop); process.off("SIGTERM", stop);
  report.passed = !interrupted && !report.error && !report.cleanupError && report.records.length === 5 && report.records.every(item => item.code === 0 && !item.timedOut) && report.fixtureExit?.code === 0;
  save(); console.log(`Browser verification ${report.passed ? "passed" : "failed"}: ${join(directory, "results.json")}`);
  process.exitCode = report.passed ? 0 : 1;
}
