import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "ui",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./ui/src", import.meta.url)),
    },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8137",
      "/health": "http://127.0.0.1:8137",
    },
  },
});
