import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    exclude: ['node_modules/**', '.next/**'],
    // Modules that read lib/env/public.ts validate at import; tests run as a chipnet build.
    env: {
      NEXT_PUBLIC_ATPRICE_NETWORK: 'chipnet',
      NEXT_PUBLIC_API_URL: 'http://localhost:4000',
      NEXT_PUBLIC_BUILD_SHA: 'test',
    },
    projects: [
      { extends: true, test: { name: 'logic', include: ['**/*.test.ts'], environment: 'node' } },
      { extends: true, test: { name: 'dom', include: ['**/*.test.tsx'], environment: 'happy-dom' } },
    ],
  },
});
