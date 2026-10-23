import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// In dev and preview the API runs alongside (pnpm api:dev); production serves both same-origin.
const api = process.env.BALLAST_API_URL ?? "http://127.0.0.1:8787";
const proxy = { "/api": { target: api, changeOrigin: true } };

/**
 * Preloads exactly the two latin font files the first screen needs: Archivo (display and body)
 * and Bodoni Moda italic (the soundings). Everything else loads on first use.
 */
function preloadFonts(): Plugin {
  const wanted = [
    /archivo-latin-wdth-normal-[\w-]+\.woff2$/,
    /bodoni-moda-latin-opsz-italic-[\w-]+\.woff2$/,
  ];
  return {
    name: "ballast-preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => wanted.some((re) => re.test(f)));
        return files.map((f) => ({
          tag: "link",
          attrs: { rel: "preload", as: "font", type: "font/woff2", href: `/${f}`, crossorigin: "" },
          injectTo: "head" as const,
        }));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadFonts()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: {
    target: "es2022",
    sourcemap: true,
    // three.js and lightweight-charts load on demand, after the first paint.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      // Keep licence notices (MIT, GSAP standard licence) in the shipped files.
      output: { comments: { legal: true } },
    },
  },
});
