import { defineConfig } from '@rstest/core';
import { pluginReact } from '@rsbuild/plugin-react';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [pluginReact()],
  include: ['src/**/*.test.{ts,tsx}'],
  setupFiles: ['./src/test/setup.ts'],
  testEnvironment: 'jsdom',
  testTimeout: 15000,
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
