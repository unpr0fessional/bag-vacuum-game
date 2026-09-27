'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createGameServer } = require('./serve.cjs');

(async () => {
  const server = createGameServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const child = spawn(process.execPath, [path.join(__dirname, 'browser-check.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, GAME_URL: `http://127.0.0.1:${server.address().port}/` },
  });
  let shuttingDown = false;
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill();
    server.closeAllConnections();
    server.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  child.once('error', error => { console.error(error); process.exitCode = 1; stop(); });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
    server.closeAllConnections();
    server.close();
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
