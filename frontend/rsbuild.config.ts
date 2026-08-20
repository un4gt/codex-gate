import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';

export default defineConfig({
  plugins: [
    pluginReact({
      reactCompiler: true,
    }),
    pluginTailwindcss({
      optimize: true,
    }),
  ],
  source: {
    entry: {
      index: './src/main.tsx',
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  server: {
    host: '0.0.0.0',
    port: 4173,
    // 生产环境下控制台由后端的 STATIC_DIR 同源提供，后端不发 CORS 头。
    // 开发时把 /api 代理到后端，前端 apiBase 填 dev server 自身地址即可。
    proxy: {
      '/api': process.env.LITTLE_GATE_ORIGIN ?? 'http://127.0.0.1:8080',
    },
  },
  html: {
    template: './index.html',
  },
  output: {
    target: 'web',
    distPath: {
      root: 'dist',
    },
  },
});
