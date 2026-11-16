import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

// Multi-page, not a SPA. site.py is a plain static file server that already
// owns these URLs (/, /app/graph.html, redirects from the classic tree, tests
// that assert them), and every page is an independent surface — the graph is a
// canvas app, markets is charts. Separate entries keep those URLs byte-stable
// and mean each page ships only its own JS, with Rollup hoisting the shared
// React/runtime into one chunk both pages cache.
//
// Build output lands in ./dist, which is APP_DIR in site.py. It used to land
// in a sibling ../mirai, which read as a SECOND frontend folder rather than as
// this one's output — the app now lives in exactly one directory, source in
// src/ and the build beside it. dist IS committed, deliberately: the site is
// served straight from it, so a clone can run without a Node toolchain.
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') }
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        markets: resolve(__dirname, 'markets.html'),
        graph: resolve(__dirname, 'graph.html'),
        library: resolve(__dirname, 'library.html'),
        cron: resolve(__dirname, 'cron.html'),
        chats: resolve(__dirname, 'chats.html'),
        settings: resolve(__dirname, 'settings.html'),
        notices: resolve(__dirname, 'notices.html'),
        send: resolve(__dirname, 'send.html')
      }
    }
  },
  server: {
    // `bun run dev` talks to the real brain, so the UI is never developed
    // against fixtures — the API is the contract and it stays honest.
    proxy: {
      '/api': 'http://127.0.0.1:6769',
      '/library': 'http://127.0.0.1:6769'
    }
  }
})
