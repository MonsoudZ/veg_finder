import { openStore } from "./store.js";

const store = await openStore();
await store.close();
console.log("Database migrations applied.");
