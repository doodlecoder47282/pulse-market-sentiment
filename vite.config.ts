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
            if (id.includes("recharts") || id.includes("d3-") || id.includes("victory-vendor")) return "vendor-charts";
            if (id.includes("@radix-ui")) return "vendor-radix";
            if (id.includes("@tanstack")) return "vendor-tanstack";
            if (id.includes("lucide-react")) return "vendor-icons";
            if (id.includes("date-fns") || id.includes("dayjs")) return "vendor-date";
            if (id.includes("framer-motion") || id.includes("motion-")) return "vendor-motion";
            if (id.includes("plotly") || id.includes("three") || id.includes("d3-force")) return "vendor-3d";
            if (id.includes("react-dom") || id.includes("scheduler")) return "vendor-react-dom";
            if (id.includes("/react/") || id.includes("react-is")) return "vendor-react";
            // Split the long-tail vendor bucket by first letter to keep each
            // chunk small enough for the snapshot service stream limit.
            const m = id.match(/node_modules\/(?:@[^/]+\/)?([^/]+)/);
            const name = m ? m[1] : "x";
            const first = (name[0] || "x").toLowerCase();
            if (first <= "f") return "vendor-misc-a";
            if (first <= "m") return "vendor-misc-b";
            if (first <= "s") return "vendor-misc-c";
            return "vendor-misc-d";
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
