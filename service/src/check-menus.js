import { checkMenus } from "./checker.js";
import { ensureSeeded, openDatabase } from "./database.js";

const database = openDatabase(process.env.VEGFINDER_DATABASE_PATH);
ensureSeeded(database);
const results = await checkMenus(database);
database.close();

if (results.some((result) => result.status === "failed")) {
  process.exitCode = 1;
}
