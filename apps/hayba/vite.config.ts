import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri-friendly Vite config. devUrl in tauri.conf.json must match server.port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // Use a Hayba-specific port so we never collide with other Vite apps
    // (5173 is the default, owned by whoever launched it first).
    port: 5184,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
