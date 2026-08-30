import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const defaultDatabasePath = resolve(serviceRoot, "data/vegfinder.sqlite");
export const defaultSeedPath = resolve(serviceRoot, "data/catalog.seed.json");
