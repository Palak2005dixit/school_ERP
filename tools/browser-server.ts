import { startTestDatabase } from "../packages/db/src/test-database";
process.env.TEST_DATABASE_ENGINE = "pglite";
process.env.NODE_ENV = "test";
const database = await startTestDatabase();
process.env.DATABASE_URL = database.url;
const { buildApp } = await import("../apps/api/src/app");
const { closePool } = await import("../apps/api/src/db");
const app = await buildApp();
await app.listen({ port: 4000, host: "127.0.0.1" });
async function stop() {
  await app.close();
  await closePool();
  await database.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
