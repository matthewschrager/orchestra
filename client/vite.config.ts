import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiPort = process.env.ORCHESTRA_PORT || "3847";
const apiTarget = `http://localhost:${apiPort}`;
const wsTarget = `http://localhost:${apiPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../server/static",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/ws": {
        target: wsTarget,
        ws: true,
      },
    },
  },
});
