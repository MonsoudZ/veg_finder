export async function openStore({
  databaseURL = process.env.DATABASE_URL,
  sqlitePath = process.env.VEGFINDER_DATABASE_PATH
} = {}) {
  if (databaseURL) {
    const { openPostgresStore } = await import("./postgres-store.js");
    return openPostgresStore(databaseURL);
  }
  const { openSQLiteStore } = await import("./database.js");
  return openSQLiteStore(sqlitePath);
}
