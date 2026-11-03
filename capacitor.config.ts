import type { CapacitorConfig } from "@capacitor/cli";

// Never set server.url to a preview or embed access tokens here.
const config: CapacitorConfig = {
  appId: "com.batcave.terminal",
  appName: "Batcave",
  webDir: "dist/native",
  backgroundColor: "#090b0e",
  server: { hostname: "localhost", iosScheme: "capacitor" },
  ios: {
    contentInset: "never",
    preferredContentMode: "mobile",
    backgroundColor: "#090b0e",
  },
};

export default config;
