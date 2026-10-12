import { defineConfig } from "vitest/config";

// `npm run verify:postgres`: checks the simulator against a real Postgres (needs DATABASE_URL).
export default defineConfig({
  test: { include: ["verify/**/*.verify.ts"], testTimeout: 120_000 },
});
