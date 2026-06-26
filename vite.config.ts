import { defineConfig, type PluginOption } from 'vite';
import legacy from '@vitejs/plugin-legacy';
import { resolve } from 'path';
import { copyFileSync } from 'node:fs';

const copyManifestPlugin: PluginOption = {
  name: 'copy-manifest',
  apply: 'build',
  closeBundle() {
    copyFileSync(
      resolve(__dirname, 'public/manifest.json'),
      resolve(__dirname, 'dist/manifest.json'),
    );
  },
};

export default defineConfig({
  plugins: [
    legacy({
      targets: ['Chrome >= 108', 'Edge >= 112', 'Safari >= 16'],
      polyfills: ['es.array.iterator', 'es.string.iterator'],
    }),
    copyManifestPlugin,
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        popup: resolve(__dirname, 'src/popup/index.ts'),
        options: resolve(__dirname, 'src/options/index.ts'),
        simulcastOffscreen: resolve(__dirname, 'src/offscreen/simulcast-audio.ts'),
        simulcastPlayer: resolve(__dirname, 'src/player/simulcast-player.ts'),
      },
      output: {
        entryFileNames: (chunkInfo: { name: string }) => {
          if (chunkInfo.name === 'background') {
            return 'background.js';
          }
          if (chunkInfo.name === 'popup') {
            return 'popup.js';
          }
          if (chunkInfo.name === 'options') {
            return 'options.js';
          }
          if (chunkInfo.name === 'simulcastOffscreen') {
            return 'simulcast-offscreen.js';
          }
          if (chunkInfo.name === 'simulcastPlayer') {
            return 'simulcast-player.js';
          }
          return '[name].js';
        },
        chunkFileNames: '[name].[hash].js',
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  publicDir: 'public',
  server: {
    port: 3000,
    strictPort: true,
    hmr: false,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
