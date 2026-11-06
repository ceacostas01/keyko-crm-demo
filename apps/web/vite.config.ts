import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * En desarrollo el frontend llama a `/api/...` en el mismo origen y Vite lo
 * reenvía a la API local (apps/api en :8787). Así no hay CORS y funciona igual
 * desde el celular en la misma red. En un despliegue separado se usa
 * `VITE_API_BASE_URL` y el proxy no interviene.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});
