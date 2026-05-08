import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': root,
    },
  },
  test: {
    projects: [
      {
        resolve: {
          alias: {
            '@': root,
          },
        },
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'lib/**/*.test.ts',
            'db/**/*.test.ts',
            'tests/unit/**/*.test.ts',
          ],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: {
            '@': root,
          },
        },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: [
            'components/**/*.test.tsx',
            'tests/dom/**/*.test.tsx',
          ],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
});
