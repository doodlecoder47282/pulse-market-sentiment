import { defineConfig, mergeConfig } from "vite";
import path from "node:path";
import webConfig from "./vite.config";

// Separate output: native sync cannot overwrite the running web build.
// envDir deliberately points to an empty folder; no local server env is loaded.
export default mergeConfig(webConfig, defineConfig({
  envDir: false,
  define: { "import.meta.env.VITE_NATIVE_BUILD": JSON.stringify("true") },
  build: { outDir: path.resolve(import.meta.dirname, "dist/native") },
}));
