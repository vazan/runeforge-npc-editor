import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Port fixe : tauri.conf.json (build.devUrl) y fait reference.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
