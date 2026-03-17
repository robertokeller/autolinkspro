import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const DEV_API_PROXY_TARGET = String(process.env.VITE_DEV_API_PROXY_URL || "http://127.0.0.1:3116").trim();

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
    open: false,
    hmr: {
      overlay: false,
      host: "localhost",
      protocol: "ws",
    },
    proxy: {
      // Apenas endpoints da API — nunca rotas do React Router
      "^/auth/(signin|signup|signout|user|session|update-user)": { target: DEV_API_PROXY_TARGET, changeOrigin: true, rewrite: (p) => p },
      "/api/rest":     { target: DEV_API_PROXY_TARGET, changeOrigin: true },
      "/functions/v1": { target: DEV_API_PROXY_TARGET, changeOrigin: true },
      "^/health$":     { target: DEV_API_PROXY_TARGET, changeOrigin: true },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
  },
  plugins: [react()],
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
