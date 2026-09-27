'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const staging = path.join(root, '.dist-build-tmp');
const destination = path.join(root, 'dist');
const runtime = ['index.html', 'game.js', 'fixed-hose.js', 'visuals.js', 'look.css', '.nojekyll'];
const assetFiles = ['assets/balcony-v2.jpg', 'assets/face-albedo.jpg', 'assets/README.md'];
const directories = ['assets/models', 'assets/textures'];
const vendorFiles = ['vendor/three.min.js', 'vendor/GLTFLoader.js', 'vendor/THREE-LICENSE.txt'];

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
try {
  for (const relative of [...runtime, ...assetFiles, ...vendorFiles, ...directories]) {
    const target = path.join(staging, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(root, relative), target, { recursive: true });
  }
  fs.copyFileSync(path.join(root, 'scripts/launch.command'), path.join(staging, 'Играть.command'));
  fs.chmodSync(path.join(staging, 'Играть.command'), 0o755);
  fs.copyFileSync(path.join(root, 'scripts/release-start.txt'), path.join(staging, 'ЗАПУСК.txt'));
  // Stamp actual resource URLs, not just the page's ?release= parameter. A
  // content-derived revision also covers builds made without a version bump.
  const fingerprint = crypto.createHash('sha256');
  const fingerprintDirectory = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) fingerprintDirectory(absolute);
      else { fingerprint.update(path.relative(staging, absolute)); fingerprint.update(fs.readFileSync(absolute)); }
    }
  };
  fingerprintDirectory(staging);
  const revision = fingerprint.digest('hex').slice(0, 16);
  const htmlPath = path.join(staging, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8').replace(
    /((?:src|href)=")(look\.css|(?:vendor\/)?[\w.-]+\.js)(?:\?[^"\s]*)?"/g,
    (_, prefix, resource) => `${prefix}${resource}?v=${revision}"`
  );
  fs.writeFileSync(htmlPath, html);
  const manifest = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, relative + '/');
      else {
        const data = fs.readFileSync(absolute);
        manifest.push({ path: relative, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
      }
    }
  };
  walk(staging);
  fs.writeFileSync(path.join(staging, 'release-manifest.json'), JSON.stringify({ version: require('../package.json').version, revision, files: manifest }, null, 2) + '\n');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(staging, destination);
  const bytes = manifest.reduce((total, file) => total + file.bytes, 0);
  console.log(`Built ${manifest.length} files (${(bytes / 1024 / 1024).toFixed(1)} MB) in dist/`);
} catch (error) {
  fs.rmSync(staging, { recursive: true, force: true });
  throw error;
}
