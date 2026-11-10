import 'dotenv/config';
import express from 'express';
import { createApp } from './app.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDemo = process.env.DEMO_MODE === 'true';
if (publicDemo) delete process.env.AI_API_KEY;
const app = createApp({ dbPath: process.env.DATABASE_PATH || 'data/paperpatent.db', forceSimulator: publicDemo });
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(root, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 3002);
app.listen(port, '0.0.0.0', () => console.log(`PaperPatent VibePay ready at http://localhost:${port}`));
