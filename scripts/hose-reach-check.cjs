// Independent spatial reach audit. Uses live rig anchors and the real hose solver;
// never relocates the game's items or changes the source/build under test.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const THREE = require(path.join(root, 'vendor/three.min.js'));
global.THREE = THREE; global.window = global;
require(path.join(root, 'fixed-hose.js'));
const V3 = THREE.Vector3;
const modules = [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean);
let playwright;
for (const name of modules) { try { playwright = require(name); break; } catch {} }
if (!playwright) throw new Error('Playwright is required.');
const base = process.env.GAME_URL || 'http://127.0.0.1:8766/';
const lengths = (process.env.HOSE_LENGTHS || '2.4,2.5,2.6').split(',').map(Number);
const output = process.env.HOSE_REACH_OUTPUT || path.join(root, 'review/hose-reach-check.json');

async function capture() {
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/qa.js*', route => route.fulfill({ body: '', contentType: 'application/javascript' }));
    const url = new URL(base); url.searchParams.set('qa', '1');
    await page.goto(url.href);
    await page.waitForFunction(() => window.GAME?.assets.ready, null, { timeout: 30000 });
    const snapshot = await page.evaluate(() => {
      const G = GAME, V = THREE.Vector3;
      const random = Math.random; let seed = 0x712be1;
      Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      const targets = [];
      try {
        for (let level = 0; level < G.LEVELS.length; level++) {
          G.start(level);
          G.items.forEach((item, index) => targets.push({ group: 'spawn', name: `L${level + 1}:${item.key}:${index}`, target: [item.mesh.position.x, surfaceHeightAt(item.mesh.position.x, item.mesh.position.z) + G.CONFIG.hose.hover, item.mesh.position.z] }));
        }
      } finally { Math.random = random; }
      const t = G.CONFIG.table;
      for (let ix = 0; ix <= 24; ix++) for (let iz = 0; iz <= 16; iz++) {
        const x = t.x - t.w / 2 + .12 + ix / 24 * (t.w - .24);
        const z = t.z - t.d / 2 + .12 + iz / 16 * (t.d - .24);
        targets.push({ group: 'table-grid', name: `table:${ix}:${iz}`, target: [x, surfaceHeightAt(x, z) + G.CONFIG.hose.hover, z] });
      }
      // An item fully off the tabletop can rest in this unwalkable strip.
      for (const x of [-G.CONFIG.room.halfW + .05, -G.CONFIG.room.halfW + .12]) for (let iz = 0; iz <= 12; iz++) {
        const z = t.z - t.d / 2 + iz / 12 * t.d;
        targets.push({ group: 'left-floor', name: `floor:${x.toFixed(2)}:${iz}`, target: [x, G.CONFIG.hose.hover, z] });
      }
      G.start(0); G.input.keys.clear(); G.player.pos.set(.65, 0, 1.8); G.player.yaw = 0; G.aim(.65, .8);
      for (let i = 0; i < 12; i++) G.step(1 / 60);
      const anchors = [];
      for (const fill of [0, 1]) {
        G.game.fill = G.game.capacity * fill; G.step(0);
        G.scene.updateMatrixWorld(true);
        const relative = object => object.getWorldPosition(new V()).sub(G.player.pos).toArray();
        const axis = G.hero.armL.hand.userData.gripAxis.clone().transformDirection(G.hero.armL.hand.matrixWorld);
        anchors.push({ name: fill ? 'full-bag' : 'empty-bag', outlet: relative(G.bag.outlet), hand: relative(G.hero.armL.hand), axis: axis.toArray() });
      }
      return { version: G.version, config: G.CONFIG, obstacles: obstacles.map(b => ({ ...b })), anchors, targets };
    });
    if (errors.length) throw new Error(errors.join('\n'));
    return snapshot;
  } finally { await browser.close(); }
}

function connectedPositions(config, obstacles) {
  const radius = config.player.radius, step = .04;
  const xs = [], zs = [];
  for (let x = -config.room.halfW + radius; x <= config.room.halfW - radius + 1e-6; x += step) xs.push(x);
  for (let z = -config.room.halfD + radius; z <= config.room.halfD - radius + 1e-6; z += step) zs.push(z);
  const valid = new Set();
  for (let i = 0; i < xs.length; i++) for (let j = 0; j < zs.length; j++) {
    if (obstacles.every(b => Math.hypot(xs[i] - Math.max(b.minX, Math.min(b.maxX, xs[i])), zs[j] - Math.max(b.minZ, Math.min(b.maxZ, zs[j]))) >= radius - 1e-8)) valid.add(i * zs.length + j);
  }
  const start = [...valid].reduce((best, k) => {
    const d = Math.hypot(xs[Math.floor(k / zs.length)] - config.player.startX, zs[k % zs.length] - config.player.startZ);
    return d < best.d ? { d, k } : best;
  }, { d: Infinity });
  const queue = [start.k], seen = new Set(queue);
  for (let at = 0; at < queue.length; at++) {
    const k = queue[at], i = Math.floor(k / zs.length), j = k % zs.length;
    for (const [ni, nj] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
      if (ni < 0 || nj < 0 || ni >= xs.length || nj >= zs.length) continue;
      const next = ni * zs.length + nj;
      if (valid.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return { points: queue.map(k => [xs[Math.floor(k / zs.length)], zs[k % zs.length]]), isolated: valid.size - seen.size, spacing: step };
}

function rotate(array, yaw, x = 0, z = 0) {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  return new V3(x + c * array[0] + s * array[2], array[1], z - s * array[0] + c * array[2]);
}

(async () => {
  const snapshot = await capture(), { config, obstacles, anchors, targets } = snapshot;
  const space = connectedPositions(config, obstacles);
  const solver = new global.FixedLengthHoseCurve();
  const rearLength = config.hose.rearLength ?? 1.25, gripLength = config.hose.gripLength ?? .17;
  const solve = (anchor, pose, target, length) => {
    const [x, z, yaw] = pose;
    const hand = rotate(anchor.hand, yaw, x, z), axis = rotate(anchor.axis, yaw);
    if (axis.dot(new V3(-Math.sin(yaw), 0, -Math.cos(yaw))) < 0) axis.negate();
    const result = solver.solve({ outlet: rotate(anchor.outlet, yaw, x, z), hand, axis, front: new V3(-Math.sin(yaw), 0, -Math.cos(yaw)), target, length, rearLength, gripLength });
    return { error: result.tip.distanceTo(target), lengthError: Math.abs(result.length - length), frontLength: result.frontLength, pose };
  };
  // Build candidates using inexpensive geometric distance first. Include the
  // nearest reachable pose for each of 16 headings, so the solver tests real
  // grip direction constraints rather than a single favourable body heading.
  const candidates = targets.map(({ target }) => anchors.map(anchor => {
    const best = [];
    for (let heading = 0; heading < 16; heading++) {
      const yaw = heading * Math.PI / 8, offset = rotate(anchor.hand, yaw);
      let distance = Infinity, pose;
      for (const [x, z] of space.points) {
        const d = (x + offset.x - target[0]) ** 2 + (z + offset.z - target[2]) ** 2;
        if (d < distance) { distance = d; pose = [x, z, yaw]; }
      }
      best.push(pose);
    }
    return best;
  }));
  const result = { version: snapshot.version, source: base, solver: 'FixedLengthHoseCurve', rearLength, gripLength, walkablePositions: space.points.length, disconnectedPositions: space.isolated, gridSpacing: space.spacing, anchors, candidates: [] };
  for (const length of lengths) {
    let maxLengthError = 0;
    const groups = {}, failures = [], witnesses = [];
    for (let ti = 0; ti < targets.length; ti++) {
      const entry = targets[ti], target = new V3(...entry.target);
      groups[entry.group] ||= { targets: 0, reachable: 0, worstRemainingDistance: 0 };
      groups[entry.group].targets++;
      let worstError = 0, witness = null;
      for (let ai = 0; ai < anchors.length; ai++) {
        let best = { error: Infinity };
        for (const pose of candidates[ti][ai]) {
          const attempt = solve(anchors[ai], pose, target, length);
          maxLengthError = Math.max(maxLengthError, attempt.lengthError);
          if (attempt.error < best.error) best = attempt;
          if (attempt.error < .001) break;
        }
        if (best.error >= worstError) { worstError = best.error; witness = { anchor: anchors[ai].name, ...best }; }
      }
      groups[entry.group].worstRemainingDistance = Math.max(groups[entry.group].worstRemainingDistance, worstError);
      if (worstError < .001) groups[entry.group].reachable++;
      else failures.push({ ...entry, ...witness });
      if (entry.group === 'left-floor' && entry.target[2] > -.56 && entry.target[2] < -.54) witnesses.push({ ...entry, ...witness });
    }
    const far = new V3(config.table.x - config.table.w / 2 + .12, config.table.h + config.hose.hover, config.table.z - config.table.d / 2 + .12);
    let startBest = { error: Infinity };
    for (const anchor of anchors) for (let heading = 0; heading < 16; heading++) {
      const attempt = solve(anchor, [config.player.startX, config.player.startZ, heading * Math.PI / 8], far, length);
      if (attempt.error < startBest.error) startBest = attempt;
    }
    result.candidates.push({ length, groups, maxLengthError, farItemFromStart: { remainingDistance: startBest.error, outsideSuctionRadius: startBest.error > config.suction.pullRadius, target: far.toArray() }, failures, leftFloorWitnesses: witnesses });
    console.log(JSON.stringify(result.candidates.at(-1)));
  }
  result.recommended = result.candidates.find(candidate => !candidate.failures.length && candidate.farItemFromStart.outsideSuctionRadius)?.length ?? null;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`Recommended: ${result.recommended}; report: ${output}`);
  if (result.recommended == null) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
