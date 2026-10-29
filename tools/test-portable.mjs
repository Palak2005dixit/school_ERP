import process from "node:process";
import console from "node:console";
import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, TEST_DATABASE_ENGINE: "pglite" } },
);
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
