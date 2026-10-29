import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The backend (`rcmd serve` / the desktop app's embedded server) listens on 8822 by default.
const backend = 'http://127.0.0.1:8822';
const apiProxy = {
  '/api': {
    target: backend,
    ws: true,
    changeOrigin: false,
  },
};

export default defineConfig({
  base: './',
  plugins: [react()],
  clearScreen: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2021',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xterm')) return 'xterm';
          // language packages and their parsers stay in per-language lazy chunks
          if (id.includes('@codemirror/language-data') || id.includes('@codemirror/lang-') || id.includes('@codemirror/legacy-modes')) return undefined;
          if (/@lezer[\\/](common|highlight|lr)[\\/]/.test(id)) return 'codemirror';
          if (id.includes('@lezer')) return undefined;
          if (id.includes('@codemirror') || id.includes('@uiw') || id.includes('crelt') || id.includes('style-mod') || id.includes('w3c-keyname')) return 'codemirror';
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) return 'react';
          if (id.includes('lucide-react')) return 'icons';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
});
