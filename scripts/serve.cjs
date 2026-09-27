'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function createGameServer(root = path.resolve(__dirname, '..')) {
  root = path.resolve(root);
  return http.createServer(async (req, res) => {
    const respond = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : text);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return respond(405, 'Method not allowed');
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return respond(400, 'Invalid path'); }
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) {
      return respond(403, 'Forbidden');
    }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const allowed = /^(?:index\.html|game\.js|visuals\.js|look\.css|qa\.js|release-manifest\.json)$/.test(relative)
      || /^(?:assets|vendor|review)\//.test(relative);
    if (!allowed) return respond(404, 'Not found');
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) return respond(403, 'Forbidden');
    let stat;
    try { stat = await fs.promises.stat(file); }
    catch { return respond(404, 'Not found'); }
    if (!stat.isFile()) return respond(404, 'Not found');
    const cacheAsset = /^(assets|vendor)\//.test(relative);
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    res.setHeader('Cache-Control', cacheAsset ? 'public, max-age=3600' : 'no-cache');
    res.setHeader('ETag', etag);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      return res.end();
    }
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.writeHead(200);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

module.exports = { createGameServer };

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  const root = path.resolve(__dirname, '..', option('--dir', '.'));
  const port = Number(option('--port', process.env.PORT || '8765'));
  const host = option('--host', '127.0.0.1');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error('No game build found. Run npm run build before npm run preview.');
  const server = createGameServer(root);
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose another with --port.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`Game: http://${host}:${server.address().port}/`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
