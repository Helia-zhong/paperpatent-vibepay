import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3002,
    strictPort: true,
    fs: { deny: ['.env', '.env.*', '**/*.{crt,pem,key}', '**/.git/**', '**/server/**', '**/data/**', '**/tests/**', '**/*.db*', '**/*.sqlite*'] },
  },
});
