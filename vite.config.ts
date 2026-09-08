import path from "path"
import { execSync } from "node:child_process"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

function getCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim()
  } catch {
    return "unknown"
  }
}

export default defineConfig({
  base: '/file-share-peer-js/',
  define: {
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_COMMIT_HASH__: JSON.stringify(getCommitHash()),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: true, // Equivalent to --host CLI flag
    allowedHosts: [
        "5173-iftkc0ly0slrl9q52fsv5-8d0e504c.manus.computer",
        "ladybug-liked-chamois.ngrok-free.app"
    ]
  }
})

