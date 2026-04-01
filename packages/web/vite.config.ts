import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@sriinnu/tokmeter-core": resolve(__dirname, "../core/src/index.ts"),
    },
  },
  server: {
    port: 3000,
  },
});
