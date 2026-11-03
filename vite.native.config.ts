import { defineConfig, mergeConfig } from "vite";
import path from "node:path";
import webConfig from "./vite.config";

// Separate output: native sync cannot overwrite the running web build.
// envDir disables local env files; no local server env is loaded.
export default mergeConfig(webConfig, defineConfig({
  envDir: false,
  define: { "import.meta.env.VITE_NATIVE_BUILD": JSON.stringify("true") },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/native"),
    target: "safari15",
    cssTarget: "safari15",
  },
}));
