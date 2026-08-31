import { checkMenus } from "./checker.js";
import { proposeChangesForResults } from "./menu-changes.js";
import { announceCheckResults, createNotifier } from "./notifier.js";
import { openStore } from "./store.js";

const store = await openStore();
await store.ensureSeeded();
const results = await store.runMenuCheckExclusive(() => checkMenus(store));
if (results !== null) {
  // Detection and interpretation, in that order and as separate steps. No model
  // client is passed: a check cycle runs over every restaurant whose source
  // moved, and acquiring one here would turn a routine cycle into a bill nobody
  // asked for. Menus with no dietary legend produce a proposal saying so, which
  // `npm run propose` can then take further.
  await proposeChangesForResults(store, results);
  await announceCheckResults(store, results, { notifier: createNotifier() });
}
await store.close();

if (results?.some((result) => result.status === "failed")) {
  process.exitCode = 1;
}
