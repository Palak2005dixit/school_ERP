import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: "node --import tsx tools/browser-server.ts",
      url: "http://127.0.0.1:4000/api/health",
      timeout: 120000,
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -w @erp/web -- --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      timeout: 30000,
      reuseExistingServer: false,
    },
  ],
});
