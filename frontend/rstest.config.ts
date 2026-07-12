import { defineConfig } from '@rstest/core';
import { pluginReact } from '@rsbuild/plugin-react';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [pluginReact()],
  include: ['src/**/*.test.{ts,tsx}'],
  testEnvironment: 'jsdom',
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
