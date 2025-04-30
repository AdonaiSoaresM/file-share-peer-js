import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  base: '/file-share-peer-js/',
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

