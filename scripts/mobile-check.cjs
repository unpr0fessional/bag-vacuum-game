// Browser regression: native multi-touch input, deterministic simulation, real WebGL.
// Optional GAME_URL, PLAYWRIGHT_MODULE, CHROME_PATH, QA_OUTPUT.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let playwright;
for (const entry of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(entry); break; } catch {}
}
if (!playwright) throw new Error('Playwright is required.');
const base = process.env.GAME_URL || 'http://127.0.0.1:8766/';
const output = process.env.QA_OUTPUT || path.resolve(__dirname, '../review');
fs.mkdirSync(output, { recursive: true });
const checks = [], errors = [], measurements = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const check = async (name, run) => {
  try { const detail = await run(); checks.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
  console.log(`${checks.at(-1).passed ? 'PASS' : 'FAIL'} ${name}${checks.at(-1).error ? ': ' + checks.at(-1).error : ''}`);
};
const step = (page, count = 1) => page.evaluate(n => { for (let i = 0; i < n; i++) GAME.step(1 / 60); GAME.render(); }, count);
const centre = async (page, selector) => {
  const box = await page.locator(selector).boundingBox();
  assert(box && box.width > 0 && box.height > 0, `${selector} is not visible`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height };
};
class Fingers {
  constructor(session) { this.session = session; this.points = new Map(); }
  async send(type) { await this.session.send('Input.dispatchTouchEvent', { type, touchPoints: [...this.points].map(([id, p]) => ({ id, x: p.x, y: p.y, radiusX: 3, radiusY: 3, force: 1 })) }); }
  async down(id, p) { this.points.set(id, p); await this.send('touchStart'); }
  async move(id, p) { this.points.set(id, p); await this.send('touchMove'); }
  async up(id) { this.points.delete(id); await this.send('touchEnd'); }
  async cancel() { if (!this.points.size) return; this.points.clear(); await this.send('touchCancel'); }
  async tap(p) { await this.down(9, p); await this.up(9); }
}
const state = page => page.evaluate(() => ({
  pos: GAME.player.pos.toArray(), yaw: GAME.camState.yaw, pitch: GAME.camState.pitch,
  move: { ...GAME.input.mobileMove }, suction: GAME.input.mobileSuction,
  mouse: GAME.input.mouseDown, grounded: GAME.player.grounded,
  game: GAME.game.state, aim: GAME.input.mouseNdc.toArray(), hasAim: GAME.input.hasAim,
}));
const released = s => Math.hypot(s.move.x || 0, s.move.y || 0) < .00001 && !s.suction && !s.mouse;
async function reset(page, fingers) {
  await fingers.cancel();
  await page.evaluate(() => {
    GAME.start(0); GAME.player.pos.set(.38, 0, 1.35);
    GAME.camState.yaw = 0; GAME.camState.pitch = .35; GAME.camState.distance = 2;
  });
  await step(page, 30);
}
async function geometry(page) {
  return page.evaluate(() => {
    const hero = GAME.hero.realMesh, pos = hero.geometry.attributes.position;
    const v = new THREE.Vector3(), box = new THREE.Box3();
    GAME.scene.updateMatrixWorld(true); if (hero.isSkinnedMesh) hero.skeleton.update();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i); if (hero.isSkinnedMesh) hero.boneTransform(i, v);
      v.applyMatrix4(hero.matrixWorld); if (!v.toArray().every(Number.isFinite)) throw new Error('Character contains non-finite animated vertices');
      box.expandByPoint(v);
    }
    for (let node = hero; node; node = node.parent) if (!node.visible) throw new Error('Character visibility disabled');
    let hoseLength = 0;
    for (let i = 1; i < GAME.hoseCurve.points.length; i++) hoseLength += GAME.hoseCurve.points[i].distanceTo(GAME.hoseCurve.points[i - 1]);
    return { size: box.getSize(v).toArray(), hoseLength, declaredLength: GAME.CONFIG.hose.length };
  });
}
async function visiblePixels(page) {
  return page.evaluate(() => {
    const mesh = GAME.hero.realMesh, r = GAME.renderer;
    const target = new THREE.WebGLRenderTarget(200, Math.round(200 / GAME.camera.aspect));
    const prior = { target: r.getRenderTarget(), viewport: r.getViewport(new THREE.Vector4()), scissor: r.getScissor(new THREE.Vector4()), scissorTest: r.getScissorTest(), visible: mesh.visible, shadow: mesh.castShadow };
    try {
      r.setRenderTarget(target); r.setScissorTest(false); mesh.castShadow = false;
      const before = new Uint8Array(target.width * target.height * 4), after = new Uint8Array(before.length);
      r.render(GAME.scene, GAME.camera); r.readRenderTargetPixels(target, 0, 0, target.width, target.height, before);
      mesh.visible = false; r.render(GAME.scene, GAME.camera); r.readRenderTargetPixels(target, 0, 0, target.width, target.height, after);
      let pixels = 0;
      for (let i = 0; i < before.length; i += 4) if (Math.max(Math.abs(before[i] - after[i]), Math.abs(before[i + 1] - after[i + 1]), Math.abs(before[i + 2] - after[i + 2])) > 12) pixels++;
      return pixels;
    } finally {
      mesh.visible = prior.visible; mesh.castShadow = prior.shadow;
      r.setRenderTarget(prior.target); r.setViewport(prior.viewport); r.setScissor(prior.scissor); r.setScissorTest(prior.scissorTest); target.dispose();
    }
  });
}
async function assertLayout(page) {
  const result = await page.evaluate(() => {
    const rect = id => {
      const el = document.getElementById(id), b = el?.getBoundingClientRect(), style = el && getComputedStyle(el);
      return b && style.display !== 'none' && style.visibility !== 'hidden' && b.width && b.height ? { id, x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom } : null;
    };
    return { w: innerWidth, h: innerHeight, controls: ['move-stick', 'mobile-suction', 'mobile-jump', 'mobile-reset', 'mobile-help-toggle', 'pause'].map(rect).filter(Boolean), hud: ['order', 'stats', 'fill', 'pip'].map(rect).filter(Boolean), bodyWidth: document.documentElement.scrollWidth };
  });
  assert(result.controls.some(c => c.id === 'move-stick') && result.controls.some(c => c.id === 'mobile-suction'), 'Movement or suction control hidden');
  for (const c of result.controls) {
    assert(c.width >= 47.9 && c.height >= 47.9, `${c.id} has a small touch target ${c.width}×${c.height}`);
    assert(c.x >= -.1 && c.y >= -.1 && c.right <= result.w + .1 && c.bottom <= result.h + .1, `${c.id} lies outside viewport`);
    for (const hud of result.hud) {
      const intersection = Math.max(0, Math.min(c.right, hud.right) - Math.max(c.x, hud.x)) * Math.max(0, Math.min(c.bottom, hud.bottom) - Math.max(c.y, hud.y));
      assert(intersection < 1, `${c.id} overlaps ${hud.id}`);
    }
  }
  assert(result.bodyWidth <= result.w + 1, 'Page overflows horizontally');
  return result;
}
async function openGame(browser, viewport, deterministic = true, mobile = true) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  if (deterministic) await context.route('**/qa.js*', route => route.fulfill({ contentType: 'application/javascript', body: '// Mobile QA drives simulation explicitly.' }));
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`); });
  await page.addInitScript(() => {
    window.__touchAudit = [];
    document.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') window.__touchAudit.push({ trusted: event.isTrusted, id: event.pointerId, target: event.target.id, tag: event.target.tagName, class: String(event.target.className), x:event.clientX,y:event.clientY }); }, true);
    window.__pointerAudit=[];
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','click']) document.addEventListener(type,event=>{window.__pointerAudit.push({type,id:event.pointerId,target:event.target.id,tag:event.target.tagName,x:event.clientX,y:event.clientY});if(window.__pointerAudit.length>60)window.__pointerAudit.shift();},true);
  });
  const url = new URL(base); if (deterministic) url.searchParams.set('qa', '1'); url.searchParams.set('mobilecheck', Date.now());
  await page.goto(url.href, { waitUntil: 'load' });
  await page.waitForFunction(() => window.GAME?.assets.ready, null, { timeout: 90000 });
  const fingers = new Fingers(await context.newCDPSession(page));
  return { context, page, fingers };
}

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  try {
    const session = await openGame(browser, { width: 390, height: 844 });
    const { page, fingers } = session;
    await check('phone: touch starts the level and shows usable controls', async () => {
      assert(await page.locator('#overlay').isVisible(), 'Start menu missing');
      await page.screenshot({ path: path.join(output, 'mobile-intro-390x844.png') });
      await fingers.tap(await centre(page, '#overlay .btns button:first-child'));
      await page.waitForFunction(() => GAME.game.state === 'playing');
      assert(await page.evaluate(() => GAME.mobileControls?.enabled), 'Mobile control mode was not enabled');
      await step(page, 2);
      const coach = page.locator('#mobile-coach');
      if (await coach.isVisible()) await fingers.tap(await centre(page, '#mobile-help-toggle'));
      return assertLayout(page);
    });
    await check('phone: analogue stick moves relative to the camera and stops on release', async () => {
      await reset(page, fingers); const c = await centre(page, '#move-stick');
      await fingers.down(1, c); await fingers.move(1, { x: c.x, y: c.y - c.height * .17 });
      const half = await state(page); assert(Math.hypot(half.move.x, half.move.y) > .05 && Math.hypot(half.move.x, half.move.y) < .85, 'Stick is not analogue');
      const before = half.pos; await step(page, 12); const after = await state(page);
      assert(after.pos[2] < before[2] - .03 && Math.abs(after.pos[0] - before[0]) < .03, 'Forward stick did not move toward camera forward');
      await fingers.up(1); assert(released(await state(page)), 'Released stick stays active');
      const stop = (await state(page)).pos; await step(page, 10);
      assert(Math.hypot(...(await state(page)).pos.map((n, i) => n - stop[i])) < .00001, 'Movement continued after release');
      await page.evaluate(() => { GAME.camState.yaw = Math.PI / 2; });
      await fingers.down(1, c); await fingers.move(1, { x: c.x, y: c.y - c.height * .35 });
      const rotated = (await state(page)).pos; await step(page, 8); await fingers.up(1);
      assert((await state(page)).pos[0] < rotated[0] - .08, 'Movement ignored rotated camera');
    });
    await check('phone: scene swipe orbits camera without suction; a tap aims', async () => {
      await reset(page, fingers); const before = await state(page);
      await fingers.down(2, { x: 260, y: 365 }); await fingers.move(2, { x: 325, y: 420 });
      const during = await state(page); assert(!during.suction && !during.mouse, 'Camera swipe started suction');
      assert(Math.abs(during.yaw - before.yaw) > .05 && Math.abs(during.pitch - before.pitch) > .05, 'Swipe ignored yaw or pitch');
      await fingers.up(2); const ended = await state(page);
      await fingers.tap({ x: 200, y: 370 }); const tapped = await state(page);
      assert(tapped.hasAim && !tapped.suction && !tapped.mouse, 'Scene tap did not aim separately from suction');
      assert(Math.abs(tapped.yaw - ended.yaw) < .00001, 'Tap moved camera');
    });
    await check('phone: suction is held only while pressed; jump does not repeat while held', async () => {
      await reset(page, fingers); const s = await centre(page, '#mobile-suction');
      await fingers.down(2, s); assert((await state(page)).suction, 'Suction press ignored');
      await fingers.up(2); assert(!(await state(page)).suction, 'Suction stayed on after release');
      const j = await centre(page, '#mobile-jump'); await fingers.down(3, j);
      await step(page, 14); assert((await state(page)).pos[1] > .3, 'Jump did not leave the floor');
      await step(page, 60); const landed = await state(page); assert(landed.grounded && landed.pos[1] === 0, 'Held jump repeated or failed to land');
      await fingers.up(3);
    });
    await check('phone: movement, camera and suction support three simultaneous fingers', async () => {
      await reset(page, fingers); const stick = await centre(page, '#move-stick'), suction = await centre(page, '#mobile-suction');
      const before = await state(page);
      await fingers.down(1, stick); await fingers.move(1, { x: stick.x + stick.width * .32, y: stick.y });
      await fingers.down(2, suction); await fingers.down(3, { x: 250, y: 390 });
      await fingers.move(3, { x: 315, y: 410 }); await page.waitForTimeout(50); await step(page, 12);
      const active = await state(page);
      assert(active.suction && Math.hypot(active.move.x, active.move.y) > .5, 'One control cancelled another finger');
      assert(Math.abs(active.yaw - before.yaw) > .08, 'Camera ignored third finger: ' + JSON.stringify({before,active,events:await page.evaluate(()=>window.__pointerAudit.slice(-20))}));
      assert(Math.hypot(active.pos[0] - before.pos[0], active.pos[2] - before.pos[2]) > .15, 'Concurrent movement ignored');
      const g = await geometry(page); assert(Math.abs(g.hoseLength - 2.5) < .0001 && g.declaredLength === 2.5, 'Hose changed length on mobile');
      assert(g.size[1] > 1.2 && g.size[1] < 2.2, 'Animated character collapsed');
      await fingers.cancel(); assert(released(await state(page)), 'Touch cancel leaves controls held');
      const pixels = await visiblePixels(page); assert(pixels > 20, 'Character disappears during multi-touch movement');
      return { ...g, visiblePixels: pixels };
    });
    await check('phone: pause, resume, blur and restart clear held input', async () => {
      const engage = async () => { const c = await centre(page, '#move-stick'); await fingers.down(1, c); await fingers.move(1, { x: c.x + c.width * .3, y: c.y }); await fingers.down(2, await centre(page, '#mobile-suction')); };
      await reset(page, fingers); await engage();
      await fingers.tap(await centre(page, '#pause'));
      await page.waitForTimeout(50);
      assert((await state(page)).game === 'paused' && released(await state(page)), 'Pause retained input: ' + JSON.stringify(await state(page)));
      await fingers.cancel(); await fingers.tap(await centre(page, '#pause'));
      assert((await state(page)).game === 'playing' && released(await state(page)), 'Resume retained input');
      await step(page,1);
      await engage(); await fingers.tap(await centre(page,'#mobile-reset'));
      assert(released(await state(page)), 'Camera reset retained held touch input');
      await fingers.cancel();
      await engage(); await fingers.tap(await centre(page,'#mobile-help-toggle'));
      assert((await state(page)).game === 'paused' && released(await state(page)), 'Opening help did not pause and release controls');
      await fingers.cancel(); await fingers.tap(await centre(page,'#mobile-coach-close'));
      assert((await state(page)).game === 'playing' && released(await state(page)), 'Closing help did not resume cleanly');
      await step(page,1);
      await engage(); await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      assert(released(await state(page)), 'Blur retained held touch input');
      await fingers.cancel(); if ((await state(page)).game === 'paused') await fingers.tap(await centre(page, '#pause'));
      await engage(); await page.evaluate(() => GAME.start(0));
      assert(released(await state(page)), 'Restart retained held touch input');
      await fingers.cancel();
    });
    await reset(page, fingers); await page.evaluate(()=>GAME.start(0));await step(page,30);await page.waitForTimeout(1750);
    await page.screenshot({ path: path.join(output, 'mobile-playing-390x844.png') });
    measurements.push({ viewport: '390x844', layout: await assertLayout(page) });
    await check('phone: small portrait and landscape keep touch controls clear of HUD', async () => {
      for (const viewport of [{ width: 360, height: 640 }, { width: 667, height: 375 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport); await step(page, 3);
        const layout = await assertLayout(page); measurements.push({ viewport: `${viewport.width}x${viewport.height}`, layout });
        await page.waitForTimeout(1750); // Let brief messages from prior QA restarts fade naturally.
        await page.screenshot({ path: path.join(output, `mobile-playing-${viewport.width}x${viewport.height}.png`) });
        await page.evaluate(()=>GAME.start(2)); await step(page,2);
        measurements.push({viewport:`${viewport.width}x${viewport.height} level3`,layout:await assertLayout(page)});
        await page.evaluate(()=>GAME.start(0));await step(page,2);
      }
    });
    await check('phone: target stays out of reach until physically approaching with the stick', async () => {
      await reset(page, fingers);
      await page.evaluate(() => {
        const original = Math.random; let seed = 410;
        Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
        try { GAME.start(0); } finally { Math.random = original; }
        GAME.camState.yaw = -.35; GAME.camState.pitch = .6; GAME.camState.distance = 2.7;
        window.__mobileTarget = GAME.items.filter(it => it.isTarget).sort((a, b) => b.mesh.position.distanceTo(GAME.player.pos) - a.mesh.position.distanceTo(GAME.player.pos))[0];
      });
      await step(page, 30);
      const targetPoint = () => page.evaluate(() => { const v = window.__mobileTarget.mesh.position.clone().project(GAME.camera); return { x: (v.x + 1) * innerWidth / 2, y: (1 - v.y) * innerHeight / 2 }; });
      let point = await targetPoint();
      assert(point.x > 0 && point.x < 844 && point.y > 110 && point.y < 285, `Target not visibly tappable: ${JSON.stringify(point)}`);
      await fingers.tap(point); await step(page, 40);
      assert(await page.evaluate(() => GAME.hoseState.outOfReach), 'Distant item unexpectedly in reach');
      await fingers.down(2, await centre(page, '#mobile-suction')); await step(page, 60); await fingers.up(2);
      assert(await page.evaluate(() => window.__mobileTarget.state === 'rest'), 'Target collected without approaching');
      const initial = (await state(page)).pos;
      const destination = await page.evaluate(() => ({ x: Math.max(-1.55,Math.min(-.35,window.__mobileTarget.mesh.position.x+.4)), z: .26 }));
      const walk = async (x, z) => {
        const c = await centre(page, '#move-stick'); await fingers.down(1, c);
        for (let i = 0; i < 100; i++) {
          const current = await state(page), dx = x - current.pos[0], dz = z - current.pos[2], length = Math.hypot(dx, dz);
          if (length < .04) break;
          const sy = Math.sin(current.yaw), cy = Math.cos(current.yaw);
          const right = (cy * dx - sy * dz) / length, forward = (-sy * dx - cy * dz) / length;
          await fingers.move(1, { x: c.x + right * c.width * .36, y: c.y - forward * c.height * .36 });
          await step(page, Math.min(4, Math.max(1, Math.floor(length / 2 * 60))));
        }
        await fingers.up(1);
      };
      await walk(destination.x, initial[2]); await walk(destination.x, destination.z);
      // Face the table while its collision keeps the character on the floor.
      await page.evaluate(()=>{GAME.camState.yaw=0;});
      const faceStick=await centre(page,'#move-stick');await fingers.down(1,faceStick);await fingers.move(1,{x:faceStick.x,y:faceStick.y-faceStick.height*.36});await step(page,35);await fingers.up(1);
      const approached = (await state(page)).pos;
      assert(Math.hypot(approached[0] - initial[0], approached[2] - initial[2]) > .5, 'Player did not physically approach');
      // The tapped item stays selected while approaching, so no second aim or
      // direct debug target is needed as the camera tracks the character.
      await step(page, 40);
      await fingers.down(2, await centre(page, '#mobile-suction')); await step(page, 180); await fingers.up(2);
      assert(await page.evaluate(() => window.__mobileTarget.state === 'bagged'), 'Target was not collected after approaching and tapping: ' + JSON.stringify(await page.evaluate(()=>({state:__mobileTarget.state,position:__mobileTarget.mesh.position.toArray(),player:GAME.player.pos.toArray(),tip:GAME.tip.toArray(),reach:GAME.hoseState.outOfReach,ndc:GAME.input.mouseNdc.toArray()}))));
      return { initial, approached, target: await page.evaluate(() => window.__mobileTarget.key) };
    });
    await check('phone: gestures used browser-trusted touch events', async () => {
      const events = await page.evaluate(() => window.__touchAudit);
      assert(events.length > 15 && events.every(e => e.trusted), 'Touch events were not browser-native');
      return { trustedPointerDownCount: events.length };
    });
    await session.context.close();
    await check('phone: movement runs in the normal live animation loop', async () => {
      const live = await openGame(browser, { width: 390, height: 844 }, false);
      try {
        await live.fingers.tap(await centre(live.page, '#overlay .btns button:first-child'));
        await live.page.waitForFunction(() => GAME.game.state === 'playing');
        await live.page.locator('#move-stick').waitFor({state:'visible'});
        const c = await centre(live.page, '#move-stick'), before = await state(live.page);
        await live.fingers.down(1, c); await live.fingers.move(1, { x: c.x + c.width * .34, y: c.y });
        await live.page.waitForTimeout(450); await live.fingers.up(1); const after = await state(live.page);
        assert(Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2]) > .15, 'Live loop did not consume mobile movement');
        assert(released(after), 'Live touch release failed');
      } finally { await live.context.close(); }
    });
    await check('desktop: touch controls hidden and keyboard movement preserved', async () => {
      const desktop = await openGame(browser, { width: 1440, height: 900 }, true, false);
      try {
        await desktop.page.locator('#overlay .btns button').first().click(); await step(desktop.page, 1);
        assert(!(await desktop.page.locator('#move-stick').isVisible()), 'Desktop shows touch controls');
        assert(!(await desktop.page.evaluate(() => GAME.mobileControls?.enabled)), 'Desktop has mobile mode enabled');
        const before = (await state(desktop.page)).pos;
        await desktop.page.keyboard.down('d'); await step(desktop.page, 10); await desktop.page.keyboard.up('d');
        const after = (await state(desktop.page)).pos;
        assert(Math.hypot(after[0] - before[0], after[2] - before[2]) > .1, 'Desktop keyboard movement regressed');
      } finally { await desktop.context.close(); }
    });
  } finally {
    await browser.close();
    const report = { base, passed: checks.every(c => c.passed) && !errors.length, checks, runtimeErrors: [...new Set(errors)], measurements };
    fs.writeFileSync(path.join(output, 'mobile-checks.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failures: checks.filter(c => !c.passed), runtimeErrors: report.runtimeErrors }, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
