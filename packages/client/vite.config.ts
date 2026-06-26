import { defineConfig } from 'vite';

// 5180 は Memoria が使うので Pagus client は 4320 を使う。
// Cloudflare Tunnel (pagus.vtn-game.com) からのアクセスを許可し、
// WS は同一オリジン /ws を game server (4310) へ proxy する
// → ローカルでもトンネル越しでも client は location.host/ws に繋げばよい。
export default defineConfig({
  server: {
    port: 4320,
    host: true, // 0.0.0.0 で待受 (Cloudflare Tunnel が IPv4 localhost で届く)。
    allowedHosts: ['pagus.vtn-game.com', 'localhost'],
    proxy: {
      '/ws': { target: 'ws://localhost:4310', ws: true },
      // push 購読 / 通知経由の投票も同一オリジンで game server (4310) へ。
      '/api': { target: 'http://localhost:4310' },
    },
  },
});
