import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Served from https://<user>.github.io/pg-race-lab/ on GitHub Pages.
export default defineConfig({
  base: "/pg-race-lab/",
  plugins: [react()],
  test: { include: ["tests/**/*.test.ts"] },
});
