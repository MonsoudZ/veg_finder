import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkMenus } from "../src/checker.js";
import { openSQLiteStore } from "../src/database.js";
import { announceCheckResults, createNotifier, summarizeCheck } from "../src/notifier.js";

const quiet = { log() {}, error() {}, warn() {} };

function capturingFetch(record) {
  return async (url, options) => {
    record.push({ url, body: JSON.parse(options.body) });
    return new Response("ok", { status: 200 });
  };
}

test("a clean cycle with an empty queue stays silent", () => {
  const summary = summarizeCheck([{ id: "a", name: "A", status: "ok" }], []);
  assert.equal(summary.shouldNotify, false);
});

test("a changed source names the restaurant and says what to do", () => {
  const summary = summarizeCheck(
    [{ id: "a", name: "Jelly Cafe", status: "changed" }, { id: "b", name: "B", status: "ok" }],
    [{ id: "a", name: "Jelly Cafe" }]
  );
  assert.equal(summary.shouldNotify, true);
  assert.match(summary.text, /Jelly Cafe/);
  assert.match(summary.text, /Official menu changed \(1\)/);
  assert.match(summary.text, /advanced auditedAt/);
  assert.deepEqual(summary.detail.changed, ["Jelly Cafe"]);
  assert.equal(summary.detail.reviewQueueSize, 1);
});

test("an unreachable source reports the error", () => {
  const summary = summarizeCheck(
    [{ id: "a", name: "Bar Nun", status: "failed", error: "HTTP 503" }],
    [{ id: "a", name: "Bar Nun" }]
  );
  assert.match(summary.text, /Source unreachable \(1\)/);
  assert.match(summary.text, /Bar Nun — HTTP 503/);
  assert.deepEqual(summary.detail.failed, [{ restaurant: "Bar Nun", error: "HTTP 503" }]);
});

test("an unreconciled backlog still alerts after a clean cycle", () => {
  const summary = summarizeCheck(
    [{ id: "a", name: "A", status: "ok" }],
    [{ id: "b", name: "B" }, { id: "c", name: "C" }]
  );
  assert.equal(summary.shouldNotify, true);
  assert.match(summary.text, /2 restaurants still awaiting review/);
});

test("a single restaurant reads as singular throughout", () => {
  const summary = summarizeCheck(
    [{ id: "a", name: "Bar Nun", status: "changed" }],
    [{ id: "a", name: "Bar Nun" }]
  );
  assert.match(summary.text, /1 restaurant needs review/);
  assert.match(summary.text, /This restaurant is already demoted/);
  assert.doesNotMatch(summary.text, /restaurants/);
});

test("the payload satisfies both Slack and Discord", async () => {
  const sent = [];
  const notifier = createNotifier({
    webhookURL: "https://hooks.example.com/abc",
    fetchImpl: capturingFetch(sent),
    logger: quiet
  });
  assert.equal(notifier.enabled, true);
  await notifier.send({ text: "hello", detail: { event: "menu_check" } });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.text, "hello");      // Slack
  assert.equal(sent[0].body.content, "hello");   // Discord
  assert.equal(sent[0].body.event, "menu_check");
});

test("a missing or unusable webhook disables alerts without throwing", async () => {
  for (const value of [undefined, "", "not-a-url", "http://insecure.example.com/hook"]) {
    const notifier = createNotifier({ webhookURL: value, logger: quiet });
    assert.equal(notifier.enabled, false, `expected ${value} to be rejected`);
    assert.equal(await notifier.send({ text: "x", detail: {} }), false);
  }
  // localhost over http stays allowed so the alert path is testable in development.
  assert.equal(
    createNotifier({ webhookURL: "http://127.0.0.1:9/hook", logger: quiet }).enabled, true
  );
});

test("a webhook outage never fails the check cycle that produced it", async () => {
  const rejecting = createNotifier({
    webhookURL: "https://hooks.example.com/abc",
    fetchImpl: async () => { throw new Error("connection refused"); },
    logger: quiet
  });
  assert.equal(await rejecting.send({ text: "x", detail: {} }), false);

  const erroring = createNotifier({
    webhookURL: "https://hooks.example.com/abc",
    fetchImpl: async () => new Response("nope", { status: 500 }),
    logger: quiet
  });
  assert.equal(await erroring.send({ text: "x", detail: {} }), false);
});

test("a real check cycle delivers one alert naming the demoted restaurants", async () => {
  const store = openSQLiteStore(join(mkdtempSync(join(tmpdir(), "vegfinder-alert-")), "c.sqlite"));
  await store.importSeed();
  await checkMenus(store, { fetchImpl: async () => new Response("<main>one</main>"), logger: quiet });
  const results = await checkMenus(store, {
    fetchImpl: async () => new Response("<main>two</main>"), logger: quiet
  });

  const sent = [];
  const delivered = await announceCheckResults(store, results, {
    notifier: createNotifier({
      webhookURL: "https://hooks.example.com/abc",
      fetchImpl: capturingFetch(sent),
      logger: quiet
    }),
    logger: quiet
  });

  assert.equal(delivered, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /10 restaurants need review/);
  assert.match(sent[0].body.text, /Jelly Cafe/);
  assert.equal(sent[0].body.reviewQueueSize, 10);
  await store.close();
});

test("an unconfigured webhook is reported rather than passing silently", async () => {
  const store = openSQLiteStore(join(mkdtempSync(join(tmpdir(), "vegfinder-noalert-")), "c.sqlite"));
  await store.importSeed();
  await checkMenus(store, { fetchImpl: async () => new Response("<main>one</main>"), logger: quiet });
  const results = await checkMenus(store, {
    fetchImpl: async () => new Response("<main>two</main>"), logger: quiet
  });

  const warnings = [];
  const delivered = await announceCheckResults(store, results, {
    notifier: createNotifier({ webhookURL: undefined, logger: quiet }),
    logger: { log() {}, warn: (message) => warnings.push(message) }
  });

  assert.equal(delivered, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Nobody will be told/);
  await store.close();
});
