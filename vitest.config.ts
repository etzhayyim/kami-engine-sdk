import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({ hot: false, compilerOptions: { runes: true } })],
  // Resolve Svelte's browser (client) build so component mount tests work under
  // jsdom; without this vitest pulls the SSR build and `mount` is unavailable.
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
});
