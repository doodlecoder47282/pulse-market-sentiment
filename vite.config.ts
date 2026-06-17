import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Aggressive code-split: snapshot service chokes on 1.3MB single chunk.
    // Keep every chunk under ~400KB so HTTP/2 streams complete fast on mobile.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            // Conservative split: keep React + ecosystem together to avoid
            // TDZ / circular-import hazards. Only split self-contained heavy
            // libs (recharts is the big one).
            if (id.includes("recharts") || id.includes("victory-vendor")) return "vendor-charts";
            if (id.includes("@radix-ui")) return "vendor-radix";
            if (id.includes("lucide-react")) return "vendor-icons";
            // framer-motion is only used by the lazy LaunchSplash; isolate it so
            // it never gets pulled back into the entry/vendor critical path.
            if (id.includes("framer-motion") || id.includes("/motion-dom/") || id.includes("/motion-utils/")) return "vendor-motion";
            // react-markdown + remark/micromark stack is only used by lazy tab
            // panels (News, Trade Desk); split it out of the entry vendor chunk.
            if (
              id.includes("react-markdown") || id.includes("remark-") ||
              id.includes("micromark") || id.includes("mdast") ||
              id.includes("hast") || id.includes("unist") ||
              id.includes("/vfile") || id.includes("property-information")
            ) return "vendor-markdown";
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
