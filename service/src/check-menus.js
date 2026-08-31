import { checkMenus } from "./checker.js";
import { announceCheckResults, createNotifier } from "./notifier.js";
import { openStore } from "./store.js";

const store = await openStore();
await store.ensureSeeded();
const results = await store.runMenuCheckExclusive(() => checkMenus(store));
if (results !== null) {
  await announceCheckResults(store, results, { notifier: createNotifier() });
}
await store.close();

if (results?.some((result) => result.status === "failed")) {
  process.exitCode = 1;
}
