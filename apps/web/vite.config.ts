import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev and preview the API runs alongside (pnpm api:dev); production serves both same-origin.
const api = process.env.BALLAST_API_URL ?? "http://127.0.0.1:8787";
const proxy = { "/api": { target: api, changeOrigin: true } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: {
    target: "es2022",
    sourcemap: true,
    // lightweight-charts loads on demand, after the first paint.
    chunkSizeWarningLimit: 400,
  },
});
