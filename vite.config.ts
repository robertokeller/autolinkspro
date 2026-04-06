import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const DEV_API_PROXY_TARGET = String(process.env.VITE_DEV_API_PROXY_URL || "http://127.0.0.1:3116").trim();
const DEV_HOST = String(process.env.VITE_DEV_HOST || "127.0.0.1").trim();
const DEV_PORT = Number(process.env.VITE_DEV_PORT || "5173");
const HMR_HOST = String(process.env.VITE_HMR_HOST || "").trim() || undefined;
const HMR_PROTOCOL = String(process.env.VITE_HMR_PROTOCOL || "").trim() || undefined;
const HMR_PORT = Number(process.env.VITE_HMR_PORT || "0") || undefined;

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: DEV_HOST,
    port: DEV_PORT,
    strictPort: true,
    allowedHosts: true,
    open: false,
    hmr: {
      overlay: false,
      ...(HMR_HOST ? { host: HMR_HOST } : {}),
      ...(HMR_PROTOCOL ? { protocol: HMR_PROTOCOL } : {}),
      ...(HMR_PORT ? { port: HMR_PORT, clientPort: HMR_PORT } : {}),
    },
    proxy: {
      // Apenas endpoints da API - nunca rotas do React Router
      "^/auth/(signin|signup|signout|user|session|update-user)": { target: DEV_API_PROXY_TARGET, changeOrigin: true, rewrite: (p) => p },
      "/api/rest": { target: DEV_API_PROXY_TARGET, changeOrigin: true },
      "/functions/v1": { target: DEV_API_PROXY_TARGET, changeOrigin: true },
      "^/health$": { target: DEV_API_PROXY_TARGET, changeOrigin: true },
    },
  },
  preview: {
    host: DEV_HOST,
    port: DEV_PORT,
    strictPort: true,
    allowedHosts: true,
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
