import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createServer } from 'vite';

test('development middleware refuses private server source and payment database paths', async t => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  t.after(() => vite.close());
  const app = express();
  app.use(vite.middlewares);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const file of ['/server/content.mjs', '/server/gateway.mjs', '/data/paperpatent.db']) {
    const response = await fetch(`${origin}${file}`);
    assert.equal(response.status, 403, `${file} must not bypass paid delivery access`);
  }
  const entry = await fetch(`${origin}/src/main.jsx`);
  assert.equal(entry.status, 200, 'public frontend remains available');
});
