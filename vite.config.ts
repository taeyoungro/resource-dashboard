import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Development only. In production nothing proxies anything: `npm run build` produces dist/ and
// the same Node process that answers /api serves it, so the browser talks to one origin.
//
// The target is the local server from `npm run server`, which needs AWS credentials. On a laptop
// that means an assumed opt-SolutionDashboard session in the environment; on the instance it is
// the instance profile and the dev server is not involved at all.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const serverUrl = env.OPT_DEV_SERVER_URL ?? "http://127.0.0.1:8080";

  return {
    plugins: [react()],
    build: {
      outDir: "dist",
      // Fingerprinted names are what let the server cache assets/ forever and index.html never.
      sourcemap: false,
    },
    server: {
      port: 5173,
      proxy: {
        // No rewrite. The server owns the /api prefix, so the path is the same on both sides and
        // there is one less difference between development and the instance.
        "/api": { target: serverUrl, changeOrigin: false },
      },
    },
  };
});
