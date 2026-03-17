import { defineConfig, splitVendorChunkPlugin } from "vite";
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
  plugins: [react(), splitVendorChunkPlugin()],
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react") || id.includes("react-dom") || id.includes("react-router-dom")) {
              return "vendor-react";
            }
            if (id.includes("@tanstack/react-query")) {
              return "vendor-query";
            }
            if (id.includes("recharts")) {
              return "vendor-charts";
            }
            if (id.includes("framer-motion")) {
              return "vendor-motion";
            }
            if (id.includes("@radix-ui")) {
              return "vendor-radix";
            }
            if (id.includes("date-fns")) {
              return "vendor-date";
            }
            return "vendor";
          }
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
