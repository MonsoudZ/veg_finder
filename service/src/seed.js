import { importSeed, openDatabase } from "./database.js";

const database = openDatabase(process.env.VEGFINDER_DATABASE_PATH);
importSeed(database);
database.close();
console.log("Catalog seed imported.");
