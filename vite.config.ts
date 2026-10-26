import { defineConfig } from "vite";

/** Slug = folder name under apps/ → Vite base `/<slug>/` for the combined Worker. */
const slug = "s-to-z";

export default defineConfig({
  base: `/${slug}/`,
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
  },
  server: {
    host: "127.0.0.1",
    port: 43154,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 43154,
    strictPort: true,
  },
});
