'use strict';
const QA_MODE = new URLSearchParams(location.search).has('qa');
const GAME_VERSION = '1.0.2';
const ASSET_REVISION = new URL(document.currentScript.src).searchParams.get('v') || GAME_VERSION;
/* =============================================================================
   СУМКА-ПЫЛЕСОС

   Идея: героиня в чёрной коже с капюшоном держит сумку, из сумки выходит шланг
   пылесоса. На столе лежат вещи. Нужно всосать в сумку всё из «заказа» уровня
   и не всосать ничего лишнего. Сумка ограничена по объёму — лишние вещи
   забивают место, и если сумка переполнится, она лопнет.

   КАРТА ФАЙЛА (ищи по «§N»):
     §1  CONFIG        — все числа игры (размеры, скорости, радиусы)
     §2  ITEM_TYPES    — каталог предметов: имя, объём, цена, вес, 3D-модель
     §3  LEVELS        — уровни: что забрать (targets) и что лишнее (extras)
     §4  утилиты, текстуры, материалы
     §5  сцена: комната, окно, стол, стул, свет
     §6  персонаж
     §7  сумка и шланг
     §8  предметы: раскладка, физика, всасывание
     §9  окно «внутри сумки» (картинка-в-картинке)
     §10 ввод (клавиатура, мышь)
     §11 камера от третьего лица
     §12 HUD (заказ, таймер, индикатор сумки, сообщения)
     §13 звук (генерируется WebAudio, без файлов)
     §14 состояние игры и главный цикл
     §15 debug API: window.GAME (для тестов и отладки)

   Система координат: метры. Y — вверх. Стол стоит у окна, окно на стене z = -halfD.
   Игрок стартует ближе к +z и смотрит на стол (в сторону -z).
   ========================================================================== */

// Ошибки показываем прямо на экране — удобно отлаживать без консоли.
window.addEventListener('error', (e) => {
  // Wallet extensions can inject a second `ethereum` provider and throw
  // before the game starts. It is outside this page and should not cover the
  // playable scene with a false app error.
  if (/Cannot redefine property:\s*ethereum/i.test(e.message || '')) return;
  const box = document.getElementById('err');
  box.style.display = 'block';
  box.textContent = 'Ошибка: ' + e.message + (e.lineno ? '  (строка ' + e.lineno + ')' : '');
  const status = document.getElementById('loading-status');
  if (status) status.textContent = 'Не удалось запустить игру. Обнови страницу или открой её в Chrome с включённой аппаратной графикой.';
  const retry = document.getElementById('loading-retry');
  if (retry) retry.hidden = false;
});
if (!window.THREE) throw new Error('Не загрузился локальный файл vendor/three.min.js.');

// Loading has one owner. The timer and controls remain blocked until both
// models and every local texture have loaded; a failed request offers retry.
const assets = { ready: false, failed: [], loaded: 0, total: 0 };
// A release URL on the document alone does not invalidate cached scripts or
// models. Keep every locally loaded asset on the same revision as this script.
THREE.DefaultLoadingManager.setURLModifier(url => {
  if (!/^(?:\.\/)?assets\//.test(url)) return url;
  const revised = new URL(url, location.href);
  revised.searchParams.set('v', ASSET_REVISION);
  return revised.href;
});
const loadingScreen = document.getElementById('loading-screen');
const loadingStatus = document.getElementById('loading-status');
const loadingProgress = document.getElementById('loading-progress');
const loadingRetry = document.getElementById('loading-retry');
if (loadingRetry) loadingRetry.onclick = () => location.reload();
THREE.DefaultLoadingManager.onProgress = (url, loaded, total) => {
  assets.loaded = loaded; assets.total = total;
  if (loadingProgress) loadingProgress.value = loaded / Math.max(1, total);
  if (loadingStatus && !assets.failed.length) loadingStatus.textContent = 'Загружаем комнату и персонажа…';
};
THREE.DefaultLoadingManager.onError = url => {
  assets.failed.push(url);
  if (loadingStatus) loadingStatus.textContent = 'Не удалось загрузить игру. Проверь соединение и попробуй ещё раз.';
  if (loadingRetry) loadingRetry.hidden = false;
};
THREE.DefaultLoadingManager.onLoad = () => {
  assets.ready = !assets.failed.length && !!hero.realMesh && !!bag.real;
  if (assets.ready) {
    // Warm up skinning/textures before exposing the play button.
    updatePlayer(0); updateBagAndHose(0); renderer.compile(scene, camera); render();
    if (loadingScreen) loadingScreen.hidden = true;
    loadingScreen?.setAttribute('aria-busy', 'false');
  } else if (loadingRetry) loadingRetry.hidden = false;
};

/* =============================================================================
   §1 CONFIG — все настройки в одном месте
   ========================================================================== */
const CONFIG = {
  room:    { halfW: 1.95, halfD: 2.7, height: 2.9 },            // комната 6×6 м
  window:  { x0: -0.5, x1: 1.9, y0: 0.35, y1: 2.55 },          // проём окна на задней стене
  table:   { x: -0.93, z: -0.55, w: 1.45, d: 1.02, h: 0.79, drop: 0.22 }, // drop — свес скатерти
  items:   { scale: 1.35 },   // предметы крупнее реальных, чтобы их было видно с камеры
  player:  { speed: 2.0, radius: 0.24, startX: 0.38, startZ: 0.82, turnSharpness: 12, jumpSpeed: 3.8, gravity: 16 },
  hose: {
    reach: 2.1,          // максимум: как далеко от героини может быть сопло (по горизонтали)
    minReach: 0.45,      // минимум: сопло не может залезть «в неё»
    hover: 0.05,         // сопло парит над поверхностью на этой высоте
    radius: 0.026,       // толщина шланга
    ribSpacing: 0.014,   // шаг гофры
    travelTime: 0.55,    // сколько секунд предмет летит по шлангу до сумки
  },
  suction: {
    pullRadius: 0.2,     // радиус, в котором предметы начинают тянуться к соплу
    swallowDist: 0.065,  // на таком расстоянии предмет «проглатывается»
    speed: 1.1,          // скорость притяжения (делится на вес предмета)
    sharpness: 10,       // насколько резко предмет разгоняется к соплу
  },
  bag: {
    capacityFactor: 1.3, // вместимость = объём всех вещей из заказа × этот коэффициент
    trackerPenalty: 10,  // GPS-метка отнимает столько секунд
  },
  camera: {
    distance: 1.65, minDist: .75, maxDist: 3.2,
    lookHeight: 1.18, shoulder: .34,
    pitch: .15, minPitch: -.35, maxPitch: 1.12,
    // Wide rectilinear lens: stronger foreground perspective without warping
    // the cursor ray or bending the room with a separate fisheye effect.
    sensitivity: .0026, fov: 76, sharpness: 16,
  },
  pip: { w: 210, h: 148, margin: 20 }, // окно «внутри сумки», пиксели
};

/* =============================================================================
   §2 ITEM_TYPES — каталог предметов (всё, что было на столе в видео + ловушки)
   volume — сколько места занимает в сумке
   value  — цена в $ (для счёта)
   weight — чем тяжелее, тем медленнее тянется к соплу
   r      — радиус «пятна» на столе (чтобы вещи не ложились друг в друга)
   effect — особое действие при попадании в сумку: 'dye' | 'tracker'
   build  — функция, строящая 3D-модель (низ модели на y = 0), см. §4
   ========================================================================== */
const ITEM_TYPES = {
  cash:     { name: 'пачка долларов',  volume: 10, value: 1000, weight: 1.5, r: 0.085, build: () => buildCash(false) },
  chain:    { name: 'золотая цепь',    volume: 4,  value: 800,  weight: 0.8, r: 0.07,  build: () => buildChain() },
  keys:     { name: 'ключи от дома',   volume: 3,  value: 50,   weight: 0.7, r: 0.05,  build: () => buildKeys() },
  carkey:   { name: 'ключ от машины',  volume: 4,  value: 3000, weight: 0.8, r: 0.055, build: () => buildCarKey() },
  gloss:    { name: 'розовый блеск',   volume: 3,  value: 30,   weight: 0.6, r: 0.05,  build: () => buildGloss() },
  lipstick: { name: 'чёрная помада',   volume: 3,  value: 20,   weight: 0.6, r: 0.045, build: () => buildLipstick() },
  mascara:  { name: 'тушь',            volume: 3,  value: 15,   weight: 0.6, r: 0.06,  build: () => buildMascara() },
  compact:  { name: 'пудреница',       volume: 5,  value: 25,   weight: 0.9, r: 0.042, build: () => buildCompact() },
  lighter:  { name: 'зажигалка',       volume: 3,  value: 2,    weight: 0.6, r: 0.045, build: () => buildLighter() },
  scissors: { name: 'ножницы',         volume: 5,  value: 5,    weight: 0.9, r: 0.06,  build: () => buildScissors() },
  dyepack:  { name: 'пачка с краской', volume: 14, value: 0,    weight: 1.5, r: 0.085, effect: 'dye',     build: () => buildCash(true) },
  tracker:  { name: 'GPS-метка',       volume: 4,  value: 0,    weight: 0.7, r: 0.035, effect: 'tracker', build: () => buildTracker() },
};

/* =============================================================================
   §3 LEVELS — уровни
   targets — «заказ»: что и сколько штук надо забрать (обязательно ВСЁ)
   extras  — лишнее: лежит на столе, брать нельзя
   time    — секунд на уровень
   ========================================================================== */
const LEVELS = [
  {
    name: 'разминка',
    brief: 'Только деньги и золото. Косметику не трогаем.',
    time: 60,
    targets: { cash: 2, chain: 1 },
    extras:  { compact: 2, lighter: 1, gloss: 1 },
  },
  {
    name: 'косметичка',
    brief: 'Нужен только розовый блеск — чёрное не берём. Одна пачка денег — с краской.',
    time: 70,
    targets: { gloss: 3, cash: 2, keys: 1 },
    extras:  { lipstick: 3, mascara: 2, compact: 2, scissors: 1, dyepack: 1 },
  },
  {
    name: 'как в видео',
    brief: 'Ровно то, что было в сумке в финале ролика. Метки GPS мигают красным.',
    time: 80,
    targets: { cash: 3, chain: 2, keys: 1, carkey: 1, gloss: 2 },
    extras:  { lipstick: 3, mascara: 3, compact: 2, lighter: 1, scissors: 1, dyepack: 2, tracker: 2 },
  },
];

/* =============================================================================
   §4 УТИЛИТЫ, ТЕКСТУРЫ, МАТЕРИАЛЫ
   ========================================================================== */
const V3 = THREE.Vector3;
const UP = new V3(0, 1, 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
/** плавное приближение a → b, не зависящее от FPS */
const damp = (a, b, sharpness, dt) => a + (b - a) * (1 - Math.exp(-sharpness * dt));
/** то же для углов (учитывает переход через ±π) */
function dampAngle(a, b, sharpness, dt) {
  let d = b - a;
  d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * (1 - Math.exp(-sharpness * dt));
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
/** нарисовать текстуру на 2D-canvas */
function canvasTexture(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
/** включить тени у всех мешей внутри объекта */
function shadowAll(obj, cast = true, receive = true) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } });
  return obj;
}
/** сдвинуть группу так, чтобы её центр по X/Z был в нуле (низ остаётся на y = 0) */
function centerXZ(group) {
  const box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new V3());
  group.children.forEach((ch) => { ch.position.x -= c.x; ch.position.z -= c.z; });
  return group;
}

const TEX = {};   // все текстуры
const M = {};     // все материалы
const GEO = {};   // общие геометрии для мелких предметов

function initTextures() {
  // пол: серые доски, как в видео
  TEX.floor = canvasTexture(512, 512, (g, w, h) => {
    const rows = 8;
    for (let i = 0; i < rows; i++) {
      const v = 128 + Math.floor(rand(-10, 10));
      g.fillStyle = `rgb(${v},${v + 2},${v + 4})`;
      g.fillRect(0, i * h / rows, w, h / rows);
      g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, i * h / rows, w, 2);
      const seam = rand(0.2, 0.8) * w; g.fillRect(seam, i * h / rows, 2, h / rows);
      g.strokeStyle = 'rgba(255,255,255,.05)';
      for (let k = 0; k < 6; k++) { g.beginPath(); const y = i * h / rows + rand(4, h / rows - 4); g.moveTo(0, y); g.bezierCurveTo(w * .3, y + rand(-3, 3), w * .6, y + rand(-3, 3), w, y); g.stroke(); }
    }
  }, [3, 3]);

  // вид из окна: пересвеченное небо, деревья, балконные перила, деревянный навес сверху
  TEX.window = canvasTexture(1024, 1024, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#f4f8fa'); sky.addColorStop(1, '#dfe8ec');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    // деревья
    for (let i = 0; i < 70; i++) {
      g.fillStyle = `rgba(${120 + rand(-20, 20)},${145 + rand(-20, 20)},${118 + rand(-15, 15)},.55)`;
      g.beginPath(); g.arc(rand(0, w * .75), rand(h * .3, h * .55), rand(20, 60), 0, 7); g.fill();
    }
    // бетонная стена соседей справа
    g.fillStyle = '#8d908f'; g.fillRect(w * .7, h * .38, w * .3, h * .62);
    g.strokeStyle = 'rgba(0,0,0,.12)';
    for (let y = h * .38; y < h; y += 34) { g.beginPath(); g.moveTo(w * .7, y); g.lineTo(w, y); g.stroke(); }
    // деревянный навес сверху
    g.fillStyle = '#b89572'; g.fillRect(0, 0, w, h * .12);
    g.fillStyle = 'rgba(80,50,20,.25)';
    for (let x = 0; x < w; x += 22) g.fillRect(x, 0, 3, h * .12);
    // перила балкона
    g.fillStyle = '#2d2a28';
    g.fillRect(0, h * .55, w, 12);
    for (let x = 8; x < w; x += 30) g.fillRect(x, h * .55, 6, h * .45);
    // пол балкона
    g.fillStyle = '#b9b8b3'; g.fillRect(0, h * .92, w, h * .08);
  });

  // гофра шланга: по U идут светлые/тёмные рёбра
  TEX.hose = canvasTexture(32, 8, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, '#5f646a'); gr.addColorStop(.45, '#9aa0a6'); gr.addColorStop(.6, '#7d8288'); gr.addColorStop(1, '#4e5358');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }, [60, 1]);

  // купюра сверху пачки; у «пачки с краской» бандероль красная
  const bill = (band) => canvasTexture(256, 112, (g, w, h) => {
    g.fillStyle = '#cfd6c2'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#6f8469'; g.lineWidth = 5; g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = '#9fae95'; g.beginPath(); g.ellipse(w * .5, h * .5, 26, 36, 0, 0, 7); g.fill();
    g.fillStyle = '#5b6f57'; g.font = 'bold 20px monospace'; g.fillText('100', 14, 30); g.fillText('100', w - 54, h - 14);
    g.fillStyle = band; g.fillRect(w * .5 - 22, 0, 44, h);
  });
  TEX.bill = bill('#efe4c2');
  TEX.billDye = bill('#c3262e');

  // торец пачки: слои бумаги
  TEX.paperEdge = canvasTexture(32, 64, (g, w, h) => {
    for (let y = 0; y < h; y += 2) { g.fillStyle = (y / 2) % 2 ? '#e2e5d6' : '#c3cbb3'; g.fillRect(0, y, w, 2); }
  });
}

function initMaterials() {
  const std = (color, roughness = 0.5, metalness = 0, extra = {}) =>
    new THREE.MeshStandardMaterial(Object.assign({ color, roughness, metalness }, extra));

  M.wall      = std(0xeef0f0, 0.95);
  M.floor     = std(0xffffff, 0.8, 0, { map: TEX.floor });
  M.ceiling   = std(0xf4f5f5, 1);
  M.cloth     = std(0xf6f7f5, 0.95);
  M.magenta   = std(0x9c0f4e, 0.75);
  M.frame     = std(0x3a3430, 0.5, 0.3);
  M.chairWood = std(0x241a15, 0.6, 0, { envMapIntensity: 0.5 });
  M.view      = new THREE.MeshBasicMaterial({ map: TEX.window });   // вид за окном — без освещения, «пересвет»

  M.leather   = std(0x0b0b0b, 0.32, 0.05, { envMapIntensity: 0.7 });    // куртка, шорты
  M.bagLeather= std(0x0a0a0b, 0.28, 0.05, { envMapIntensity: 0.8 });   // сумка
  M.skin      = std(0xa87a5c, 0.6, 0, { envMapIntensity: 0.4 });
  M.hair      = std(0x1b1311, 0.75);
  M.hose      = std(0xffffff, 0.55, 0.05, { map: TEX.hose });
  M.nozzle    = std(0x55595e, 0.4, 0.2);

  M.silver    = std(0xd0d4d7, 0.22, 1);
  M.gold      = std(0xe0ae45, 0.25, 1);
  M.brass     = std(0xc9a55a, 0.32, 1);
  M.blackGloss= std(0x0d0d0f, 0.16, 0.1);
  M.plastic   = std(0x1b1b1d, 0.45);
  M.pink      = std(0xe0457b, 0.15, 0.05);
  M.navy      = std(0x1f2436, 0.25, 0.1);
  M.blue      = std(0x3a6fd6, 0.3);
  M.ledRed    = std(0x550000, 0.4, 0, { emissive: 0xff1020, emissiveIntensity: 1 });
  M.bill      = std(0xffffff, 0.8, 0, { map: TEX.bill });
  M.billDye   = std(0xffffff, 0.8, 0, { map: TEX.billDye });
  M.paperEdge = std(0xffffff, 0.9, 0, { map: TEX.paperEdge });

  M.reticle   = new THREE.MeshBasicMaterial({ color: 0x121212, transparent: true, opacity: 0.35, depthWrite: false });
  M.bagInside = std(0x140e0b, 0.3, 0.05, { side: THREE.BackSide });
  M.glow      = new THREE.MeshBasicMaterial({ color: 0xfff4de });
}

function initGeometries() {
  GEO.cash   = Look.rounded(0.156, 0.018, 0.067, .002);
  GEO.link   = new THREE.TorusGeometry(0.0075, 0.0022, 6, 12);
  GEO.ring   = new THREE.TorusGeometry(0.013, 0.002, 6, 18);
  GEO.led    = new THREE.SphereGeometry(0.004, 10, 8);
  GEO.bulge  = new THREE.SphereGeometry(1, 14, 10);
}

/* ---------- 3D-модели предметов. Все строятся «лёжа на столе», низ на y = 0 ---------- */

function buildCash(dye) {
  const g = new THREE.Group();
  const edge = M.paperEdge, top = dye ? M.billDye : M.bill;
  // порядок граней BoxGeometry: +x, -x, +y(верх), -y, +z, -z
  const box = new THREE.Mesh(GEO.cash, [edge, edge, top, edge, edge, edge]);
  box.position.y = 0.009;
  g.add(box);
  for (let i=0;i<3;i++) {
    const sheet=new THREE.Mesh(new THREE.BoxGeometry(.155,.0007,.066),[edge,edge,top,edge,edge,edge]);
    sheet.position.set(i*.001,.019+i*.0009,i*.001);sheet.rotation.y=i*.023;g.add(sheet);
  }
  if (dye) {                                  // маленький красный диод — единственная подсказка
    const led = new THREE.Mesh(GEO.led, M.ledRed.clone());
    led.position.set(0.055, 0.036, 0.022);
    g.add(led); g.userData.blink = led;
  }
  return shadowAll(g);
}

function buildChain() {
  const g = new THREE.Group();
  let x = 0, z = 0, a = rand(0, Math.PI * 2);
  for (let i = 0; i < 18; i++) {
    a += rand(-0.55, 0.55);
    x += Math.cos(a) * 0.0105; z += Math.sin(a) * 0.0105;
    const link = new THREE.Mesh(GEO.link, M.gold);
    link.scale.set(1.35, 1, 1);
    link.rotation.order = 'YXZ';
    link.rotation.y = -a;
    const upright = i % 2 === 1;
    link.rotation.x = Math.PI / 2 + (upright ? 1.3 : 0);
    link.position.set(x, upright ? 0.0095 : 0.0024, z);
    g.add(link);
  }
  return shadowAll(centerXZ(g));
}

function buildKeys() {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(GEO.ring, M.silver);
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.0025;
  g.add(ring);
  for (let i = 0; i < 2; i++) {
    const key = new THREE.Group();
    const head = new THREE.Mesh(new THREE.TorusGeometry(0.011, 0.003, 8, 20), M.brass);
    head.rotation.x = Math.PI / 2;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.047, 0.0044, 0.009), M.brass);
    blade.position.x = 0.034;
    key.add(head, blade);
    for (let tooth = 0; tooth < 3; tooth++) {
      const bit = new THREE.Mesh(new THREE.BoxGeometry(.006, .0044, .005 + (tooth % 2) * .003), M.brass);
      bit.position.set(.028 + tooth * .010, 0, .006);
      key.add(bit);
    }
    key.rotation.y = -0.4 + i * 0.9;
    key.position.set(Math.cos(key.rotation.y) * 0.02, 0.0034, -Math.sin(key.rotation.y) * 0.02);
    g.add(key);
  }
  return shadowAll(centerXZ(g));
}

function buildCarKey() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(Look.rounded(0.062, 0.02, 0.032, .008), M.plastic);
  body.position.y = 0.01;
  g.add(body);
  for (let i = -1; i <= 1; i++) {
    const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.003, 12), M.silver);
    btn.position.set(i * 0.017, 0.021, 0);
    g.add(btn);
  }
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.004, 0.009), M.silver);
  blade.position.set(0.056, 0.006, 0);
  g.add(blade);
  return shadowAll(centerXZ(g));
}

/** цилиндрик, лежащий на боку вдоль X: тело + колпачок */
function lyingTube(bodyR, bodyLen, bodyMat, capR, capLen, capMat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(bodyR, bodyR, bodyLen, 16), bodyMat);
  body.rotation.z = Math.PI / 2; body.position.set(0, bodyR, 0);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(capR, capR, capLen, 16), capMat);
  cap.rotation.z = Math.PI / 2; cap.position.set(bodyLen / 2 + capLen / 2, bodyR, 0);
  g.add(body, cap);
  return shadowAll(centerXZ(g));
}
function buildGloss()    { return lyingTube(0.0095, 0.07, M.pink, 0.0102, 0.028, M.silver); }
function buildLipstick() { return lyingTube(0.011, 0.06, M.blackGloss, 0.0115, 0.012, M.gold); }
function buildMascara()  { return lyingTube(0.0085, 0.085, M.navy, 0.009, 0.03, M.silver); }

function buildCompact() {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.013, 28), M.blackGloss);
  disc.position.y = 0.0065;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.0016, 6, 28), M.gold);
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.013;
  g.add(disc, rim);
  return shadowAll(g);
}

function buildLighter() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.013, 0.024), M.blue);
  body.position.y = 0.0065;
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.014, 0.024), M.silver);
  top.position.set(0.038, 0.007, 0);
  g.add(body, top);
  return shadowAll(centerXZ(g));
}

function buildScissors() {
  const g = new THREE.Group();
  for (const s of [-1, 1]) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.003, 0.008), M.silver);
    blade.rotation.y = s * 0.12; blade.position.set(0.035, 0.002, 0);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.0032, 6, 16), M.plastic);
    handle.rotation.x = Math.PI / 2; handle.position.set(-0.012, 0.0032, s * 0.013);
    g.add(blade, handle);
  }
  return shadowAll(centerXZ(g));
}

function buildTracker() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.013, 0.036), M.plastic);
  body.position.y = 0.0065;
  const led = new THREE.Mesh(GEO.led, M.ledRed.clone());
  led.position.set(0, 0.0135, 0);
  g.add(body, led); g.userData.blink = led;
  return shadowAll(g);
}

/** карта окружения для бликов на коже и металле (белая комната + яркое окно) */
function buildEnvironment(renderer) {
  const pm = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial({ color: 0x3a3d40, side: THREE.BackSide })));
  const bright = (w, h, x, y, z, ry, rx, k) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    p.position.set(x, y, z); p.rotation.set(rx || 0, ry || 0, 0); env.add(p);
  };
  bright(4, 3.5, -4.9, 0.5, -.5, Math.PI / 2, 0, 2.4); // окно на стене -X
  bright(6, 6, 0, 4.9, 0, 0, Math.PI / 2, 0.7);        // потолок
  const tex = pm.fromScene(env, 0.04).texture;
  pm.dispose();
  return tex;
}

/* =============================================================================
   §5 СЦЕНА: комната, окно, стол, стул, свет
   ========================================================================== */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);
renderer.domElement.addEventListener('webglcontextlost', e => {
  e.preventDefault();
  clearInput(); if (game.state === 'playing') togglePause();
  const notice = document.getElementById('graphics-notice');
  if (notice) notice.hidden = false;
});
renderer.domElement.addEventListener('webglcontextrestored', () => location.reload());
document.getElementById('graphics-reload')?.addEventListener('click', () => location.reload());

initTextures();
initMaterials();
const pbr = Look.textures(renderer);
Look.materials(M, pbr);
initGeometries();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe8ebed);
const ENV = buildEnvironment(renderer);
scene.environment = ENV;

const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, window.innerWidth / window.innerHeight, 0.03, 60);

/** поверхности, по которым «ходит» сопло (для луча от мыши) */
let tableTopMesh = null;
/** прямоугольники, сквозь которые нельзя пройти: {minX,maxX,minZ,maxZ} */
const obstacles = [];

function buildRoom() { Look.room(scene, M, CONFIG); }

function buildTable() { tableTopMesh = Look.table(scene, M, CONFIG, obstacles); }

function buildChair() {
  const g = new THREE.Group();
  const x = -1.15, z = 0.85;
  g.position.set(x, 0, z);
  g.rotation.y = 0.35;
  const box = (w, h, d, px, py, pz) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M.chairWood); m.position.set(px, py, pz); g.add(m); };
  box(0.44, 0.03, 0.42, 0, 0.46, 0);                                          // сиденье
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.03, 0.46, 0.03, sx * 0.19, 0.23, sz * 0.18); // ножки
  for (const sx of [-1, 1]) box(0.03, 0.5, 0.03, sx * 0.19, 0.72, -0.18);      // стойки спинки
  box(0.4, 0.06, 0.02, 0, 0.9, -0.18); box(0.4, 0.04, 0.02, 0, 0.72, -0.18);   // перекладины
  shadowAll(g);
  scene.add(g);
  obstacles.push({ minX: x - 0.3, maxX: x + 0.3, minZ: z - 0.3, maxZ: z + 0.3 });
}

function buildLights() { Look.lights(scene); }

buildRoom();
buildTable();
buildChair();
buildLights();

/** высота поверхности под точкой (x, z): стол или пол */
function surfaceHeightAt(x, z) {
  const T = CONFIG.table;
  const onTable = Math.abs(x - T.x) <= T.w / 2 + 0.02 && Math.abs(z - T.z) <= T.d / 2 + 0.02;
  return onTable ? (tableTopMesh?.userData.surfaceHeightAt?.(x, z) ?? T.h) : 0;
}

/* =============================================================================
   §6 ПЕРСОНАЖ — чёрная кожаная куртка с капюшоном, кожаные шорты.
   Построена лицом к -Z. Её правая рука (+X) держит сумку, левая (-X) — шланг.
   ========================================================================== */
/** свои копии материалов у героини — чтобы делать её полупрозрачной, когда она закрывает сопло */
const HERO_MATS = {};
function buildCharacter() { return Look.character(scene, M, HERO_MATS); }

const hero = buildCharacter();
// A generated GLB is loaded when available. The procedural body remains as a
// safe fallback while the asset is downloading, so the game never presents a
// blank scene on a slow connection.
hero.real = null;
hero.mixer = null;
hero.realAction = null;
function normalizeAsset(root, targetHeight, targetWidth = null) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new V3());
  const scale = targetHeight / Math.max(size.y, 1e-4);
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(root);
  const center = fitted.getCenter(new V3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= fitted.min.y;
  return { size, scale };
}
function skinRealAsset(root) {
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    o.frustumCulled = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      if (mat) {
        mat.transparent = false;
        mat.depthWrite = true;
        // Higgsfield's export marks the character material as metallic and
        // emissive.  Keep its albedo texture, but make it read as leather,
        // skin and hair under the room light instead of a glowing chrome mesh.
        mat.metalness = Math.min(mat.metalness || 0, .18);
        mat.roughness = Math.max(mat.roughness || .45, .48);
        if (mat.emissive) mat.emissive.set(0x000000);
        mat.emissiveIntensity = 0;
        mat.envMapIntensity = Math.min(mat.envMapIntensity || .8, .85);
      }
    }
  });
}
function prepareHandGrips(source) {
  // This export has wrist joints but no finger bones. Curl only its existing
  // textured hand vertices in their original inverse-bind frames; preserving
  // UVs and weights keeps the hands attached during the native walk animation.
  const geometry = source.geometry = source.geometry.clone();
  const positions = geometry.attributes.position, normals = geometry.attributes.normal;
  const originalNormals = normals.array.slice(), changed = new Set(), grips = {};
  const point = new V3(), restored = new V3();
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  for (const spec of [
    { name: 'RightHand', width: new V3(.622, 0, -.783), normal: new V3(.783, 0, .622), surface: .9, radius: 2.55 },
    { name: 'LeftHand', width: new V3(-.686, 0, -.728), normal: new V3(-.728, 0, .686), surface: .1, radius: 3.2 },
  ]) {
    const boneIndex = source.skeleton.bones.findIndex(b => b.name === spec.name);
    if (boneIndex < 0) continue;
    const toHand = new THREE.Matrix4().multiplyMatrices(source.skeleton.boneInverses[boneIndex], source.bindMatrix);
    const toMesh = toHand.clone().invert(), knuckle = 9.0;
    for (let i = 0; i < positions.count; i++) {
      let weight = 0;
      for (let j = 0; j < 4; j++) if (geometry.attributes.skinIndex.array[i * 4 + j] === boneIndex) weight += geometry.attributes.skinWeight.array[i * 4 + j];
      if (weight < .08) continue;
      point.fromBufferAttribute(positions, i).applyMatrix4(toHand);
      if (point.y < 5.8) continue;
      const u = point.dot(spec.width), n = point.dot(spec.normal), y = point.y;
      let bentY = y, bentN = n, bentU = u;
      if (y > knuckle) {
        const angle = Math.min(3.35, (y - knuckle) / spec.radius);
        const radius = spec.radius - (n - spec.surface) * .72;
        bentY = knuckle + radius * Math.sin(angle);
        bentN = spec.surface + spec.radius - radius * Math.cos(angle);
      }
      // Oppose the thumb across the grip instead of folding it together with
      // the four fingers. Its outer column is separate in both source hands.
      const thumb = smooth(2.1, 3.55, u) * (1 - smooth(13.4, 15, y));
      const thumbCurl = smooth(5.8, 13.5, y);
      bentU = THREE.MathUtils.lerp(bentU, u - 3.7 * thumbCurl, thumb);
      bentY = THREE.MathUtils.lerp(bentY, y - 2.35 * thumbCurl, thumb);
      bentN = THREE.MathUtils.lerp(bentN, n + (spec.radius + .8) * thumbCurl, thumb);
      if (spec.name === 'LeftHand') {
        // The hose is 5.2 cm wide (+ ribs). Keep the palmar surface and finger
        // triangles outside it, rather than hiding curled fingers inside it.
        const gripNormal = spec.surface + spec.radius, clearance = 3.02;
        const dy = bentY - knuckle, dn = bentN - gripNormal, radial = Math.hypot(dy, dn);
        if (radial < clearance) {
          if (y <= knuckle && thumb < .2) bentN = gripNormal - Math.sqrt(Math.max(0, clearance * clearance - dy * dy));
          else { const scale = clearance / Math.max(radial, .001); bentY = knuckle + dy * scale; bentN = gripNormal + dn * scale; }
        }
      }
      restored.copy(spec.width).multiplyScalar(bentU).addScaledVector(spec.normal, bentN); restored.y = bentY;
      point.lerp(restored, smooth(.08, .65, weight)).applyMatrix4(toMesh);
      positions.setXYZ(i, point.x, point.y, point.z); changed.add(i);
    }
    grips[spec.name] = {
      center: spec.normal.clone().multiplyScalar(spec.surface + spec.radius).add(new V3(0, knuckle, 0)),
      axis: spec.width.clone(),
    };
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  // Leave the authored normals of the face, hood and clothes untouched.
  for (let i = 0; i < positions.count; i++) if (!changed.has(i)) normals.setXYZ(i, originalNormals[i * 3], originalNormals[i * 3 + 1], originalNormals[i * 3 + 2]);
  normals.needsUpdate = true;
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  source.userData.handGrips = grips;
}
function createAnimatedCharacter(root) {
  // Preserve the GLB's armature transform and inverse bind matrices together.
  // Its mesh coordinates are metres, while the joints use centimetres beneath
  // a .01 Armature scale. Flattening/baking the mesh without that parent made
  // every animated pose 100 times larger. Native GPU skinning handles both.
  let source = null;
  root.traverse(o => { if (!source && o.isSkinnedMesh) source = o; });
  if (!source) return null;
  prepareHandGrips(source);
  for (const mat of Array.isArray(source.material) ? source.material : [source.material]) {
    mat.skinning = true;
    mat.needsUpdate = true;
  }
  source.name = 'generated-character';
  source.frustumCulled = false;
  root.rotation.y = Math.PI;
  return { rig: root, source };
}
function findBone(root, patterns) {
  let found = null;
  root.traverse(o => { if (!found && patterns.some(p => p.test(o.name || ''))) found = o; });
  return found;
}
function makeRealHandSockets() {
  // Fallback for an export without named hand bones. These sockets follow the
  // rendered bind-pose hands in game metres.
  const right = new THREE.Object3D();
  right.name = 'real-right-hand-socket';
  right.position.set(-.43, .92, -.015);
  const left = new THREE.Object3D();
  left.name = 'real-left-hand-socket';
  left.position.set(.43, .92, -.015);
  hero.root.add(right, left);
  hero.armR.hand = right;
  hero.armL.hand = left;
}
function loadRealCharacter() {
  if (!THREE.GLTFLoader) return;
  new THREE.GLTFLoader().load('assets/models/hero.glb', gltf => {
    const generated = createAnimatedCharacter(gltf.scene);
    if (!generated) throw new Error('generated character has no skinned mesh');
    const { rig, source } = generated;
    skinRealAsset(rig);
    hero.real = rig;
    hero.rig = rig;
    hero.rigMesh = source;
    hero.realMesh = source;
    hero.root.add(rig);
    // Keep the procedural joints hidden; the generated mesh supplies the
    // silhouette and the original armature supplies moving hand sockets.
    hero.root.children.filter(x => x !== rig).forEach(x => { x.visible = false; });
    const right = findBone(rig, [/^RightHand$/i]);
    const left = findBone(rig, [/^LeftHand$/i]);
    if (right && left) {
      // Grip centres and transverse axes are in the original centimetre rig.
      const grip = (bone, name) => {
        const socket = new THREE.Object3D(); socket.name = name;
        const shape = source.userData.handGrips[bone.name];
        socket.position.copy(shape ? shape.center : new V3(0, 7, 0));
        socket.userData.gripAxis = shape ? shape.axis.clone() : new V3(1, 0, 0);
        bone.add(socket); return socket;
      };
      hero.armR.hand = grip(right, 'bag-palm-grip');
      hero.armL.hand = grip(left, 'hose-palm-grip');
    } else makeRealHandSockets();
    hero.mixer = new THREE.AnimationMixer(rig);
    // Walking is driven by game collisions, not by translation embedded in the
    // source clip. Retain vertical hip motion; remove accumulated X/Z motion.
    const walk = gltf.animations?.[0]?.clone();
    const hips = findBone(rig, [/^Hips$/]);
    if (walk && hips) for (const track of walk.tracks) {
      if (track.name === 'Hips.position') for (let i = 0; i < track.values.length; i += 3) {
        track.values[i] = hips.position.x;
        // The generated walk was authored on a floor 10 cm above bind pose.
        track.values[i + 1] -= 10;
        track.values[i + 2] = hips.position.z;
      }
    }
    hero.realAction = walk ? hero.mixer.clipAction(walk) : null;
    if (hero.realAction) {
      hero.realAction.setLoop(THREE.LoopRepeat, Infinity).play();
      hero.realAction.setEffectiveWeight(0);
      hero.mixer.update(0);
    }
  }, undefined, () => toast('3D-модель героини не загрузилась — используется резервный вариант.'));
}
/** состояние игрока */
const player = {
  pos: new V3(CONFIG.player.startX, 0, CONFIG.player.startZ),
  verticalVelocity: 0,
  grounded: true,
  yaw: 0,             // 0 = смотрит на -Z (на стол)
  moveAmount: 0,      // 0..1 — насколько сейчас идёт (для анимации ног)
  walkPhase: 0,
};

/* =============================================================================
   §7 СУМКА И ШЛАНГ
   Сумка висит в правой руке. Шланг — одна гибкая труба: сумка → провисает к полу →
   левая рука → дугой к соплу над столом. Геометрия шланга пересобирается каждый кадр.
   ========================================================================== */
function buildBag() { return Look.bag(scene, M); }
const bag = buildBag();
bag.real = null;
function loadRealBag() {
  if (!THREE.GLTFLoader) return;
  new THREE.GLTFLoader().load('assets/models/bag.glb', gltf => {
    const model = gltf.scene;
    normalizeAsset(model, .58);
    skinRealAsset(model);
    // The hand holds the top of the handle, not the centre of the bag.
    model.position.y -= .58;
    bag.real = model;
    bag.realBaseScale = model.scale.clone();
    bag.group.add(model);
    // Normalized width is .47m; the collar overlaps the inner side seam.
    bag.port.position.set(-.205, -.40, .02);
    bag.outlet.position.copy(bag.port.position);
    bag.group.children.filter(x => x !== model && x !== bag.outlet && x !== bag.port).forEach(x => { x.visible = false; });
  }, undefined, () => toast('3D-модель сумки не загрузилась — используется резервный вариант.'));
}
loadRealCharacter();
loadRealBag();

// шланг: кривая через контрольные точки → TubeGeometry
const hoseCurve = new THREE.CatmullRomCurve3([new V3(), new V3(0, 1, 0), new V3(0, 2, 0), new V3(0, 3, 0)], false, 'centripetal');
const HOSE_SEGMENTS = 64, HOSE_SIDES = 8;
const hoseGeometry = new THREE.TubeGeometry(hoseCurve, HOSE_SEGMENTS, CONFIG.hose.radius, HOSE_SIDES, false);
hoseGeometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
hoseGeometry.attributes.normal.setUsage(THREE.DynamicDrawUsage);
const hoseMesh = new THREE.Mesh(hoseGeometry, M.nozzle);
hoseMesh.frustumCulled = false;
const hoseRibs = new THREE.InstancedMesh(new THREE.TorusGeometry(CONFIG.hose.radius, .0022, 5, 12), M.nozzle, 260);
hoseRibs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
hoseRibs.frustumCulled = false;
scene.add(hoseRibs);
const ribObject = new THREE.Object3D(), ribAxis = new V3(0,0,1);
hoseMesh.castShadow = true;
scene.add(hoseMesh);
const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.034, 0.1, 16, 1, true), M.nozzle);
nozzle.material = M.nozzle.clone(); nozzle.material.side = THREE.DoubleSide;
nozzle.castShadow = true;
scene.add(nozzle);
// кольцо на поверхности = зона всасывания
const reticle = new THREE.Mesh(new THREE.RingGeometry(CONFIG.suction.pullRadius * 0.9, CONFIG.suction.pullRadius, 48), M.reticle);
reticle.rotation.x = -Math.PI / 2;
scene.add(reticle);

/** где сейчас сопло (кончик шланга) и куда оно стремится */
const tip = new V3(0, CONFIG.table.h + CONFIG.hose.hover, CONFIG.table.z + 0.3);
const tipTarget = tip.clone();

const _v1 = new V3(), _v2 = new V3(), _v3 = new V3();
const hosePoint = new V3(), hoseNormal = new V3();
function deformHose() {
  // Reuse GPU buffers rather than constructing/discarding a tube every frame.
  hoseCurve.updateArcLengths();
  const frames = hoseCurve.computeFrenetFrames(HOSE_SEGMENTS, false);
  const positions = hoseGeometry.attributes.position, normals = hoseGeometry.attributes.normal;
  for (let i = 0; i <= HOSE_SEGMENTS; i++) {
    hoseCurve.getPointAt(i / HOSE_SEGMENTS, hosePoint);
    for (let j = 0; j <= HOSE_SIDES; j++) {
      const a = j / HOSE_SIDES * Math.PI * 2;
      hoseNormal.copy(frames.normals[i]).multiplyScalar(-Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a)).normalize();
      const n = i * (HOSE_SIDES + 1) + j;
      positions.setXYZ(n, hosePoint.x + CONFIG.hose.radius * hoseNormal.x, hosePoint.y + CONFIG.hose.radius * hoseNormal.y, hosePoint.z + CONFIG.hose.radius * hoseNormal.z);
      normals.setXYZ(n, hoseNormal.x, hoseNormal.y, hoseNormal.z);
    }
  }
  positions.needsUpdate = normals.needsUpdate = true;
}

/** точка, где шланг выходит из сумки (учитывает раздутие сумки) */
function bagOutletWorld(out) { return bag.outlet.getWorldPosition(out); }

function updateBagAndHose(dt) {
  hero.root.updateMatrixWorld(true);

  // сумка — в правой руке, чуть раскачивается при ходьбе, раздувается по мере заполнения
  const handR = hero.armR.hand.getWorldPosition(_v1);
  bag.group.position.copy(handR);
  let bagYaw = player.yaw;
  if (hero.armR.hand.userData.gripAxis) {
    const axis = hero.armR.hand.userData.gripAxis.clone().transformDirection(hero.armR.hand.matrixWorld);
    if (axis.x * axis.x + axis.z * axis.z > .1) bagYaw = Math.atan2(-axis.z, axis.x);
  }
  bag.group.rotation.set(0, bagYaw, Math.sin(player.walkPhase) * 0.08 * player.moveAmount);
  const f = Math.min(game.fill / game.capacity, 1.15);
  const puff = 1 + 0.24 * f;
  const shake = f > 0.85 ? Math.sin(clock.elapsedTime * 40) * 0.015 * (f - 0.85) * 6 : 0;
  bag.body.scale.set(bag.baseScale.x * (puff + shake), bag.baseScale.y * (1 + 0.2 * f), bag.baseScale.z * (puff + shake));
  if (bag.real) {
    bag.real.scale.set(bag.realBaseScale.x * puff, bag.realBaseScale.y, bag.realBaseScale.z * puff);
    bag.port.position.x = -.205 * puff;
    bag.outlet.position.copy(bag.port.position);
  }
  // Opening and straps retain their attachment points while the lower bag expands.
  bag.group.updateMatrixWorld(true);

  // контрольные точки шланга
  const out = bagOutletWorld(_v2.set(0, 0, 0)).clone();
  const hand = hero.armL.hand.getWorldPosition(_v3).clone();
  const front = new V3(-Math.sin(player.yaw),0,-Math.cos(player.yaw));
  const p1 = out.clone().lerp(hand, .28).addScaledVector(front,.15);
  p1.y = Math.max(.15,Math.min(out.y,hand.y)-.06);
  const p2 = out.clone().lerp(hand, .68).addScaledVector(front,.14);
  p2.y = out.y+(hand.y-out.y)*.60;
  const tipAbove = tip.clone(); tipAbove.y += 0.13;
  const mid = hand.clone().lerp(tipAbove, 0.5); mid.y = Math.max(mid.y, tipAbove.y) + 0.06;
  if (hero.armL.hand.userData.gripAxis) {
    const axis = hero.armL.hand.userData.gripAxis.clone().transformDirection(hero.armL.hand.matrixWorld);
    if (axis.dot(tipAbove.clone().sub(hand)) < 0) axis.negate();
    // A short straight section passes between the curled fingers and palm.
    // The remaining hose stays flexible on both sides of that held section.
    hoseCurve.points = [out, p1, p2, hand.clone().addScaledVector(axis, -.085), hand, hand.clone().addScaledVector(axis, .085), mid, tipAbove, tip.clone()];
  } else hoseCurve.points = [out, p1, p2, hand, mid, tipAbove, tip.clone()];

  deformHose();
  const hoseLength = hoseCurve.getLength();
  hoseRibs.count = Math.min(260, Math.floor(hoseLength / CONFIG.hose.ribSpacing));
  for(let i=0;i<hoseRibs.count;i++) {
    const u=(i+.5)/hoseRibs.count;
    ribObject.position.copy(hoseCurve.getPointAt(u));
    ribObject.quaternion.setFromUnitVectors(ribAxis,hoseCurve.getTangentAt(u));
    ribObject.updateMatrix();hoseRibs.setMatrixAt(i,ribObject.matrix);
  }
  hoseRibs.instanceMatrix.needsUpdate=true;

  // сопло: короткая трубка на конце, по направлению шланга
  const dir = hoseCurve.getTangentAt(1, _v1).normalize();
  nozzle.position.copy(tip).addScaledVector(dir, -0.03);
  nozzle.quaternion.setFromUnitVectors(UP, dir);

  // кольцо зоны всасывания
  reticle.position.set(tip.x, tip.y - CONFIG.hose.hover + 0.003, tip.z);
  const on = isSucking();
  reticle.material.color.set(on ? 0xe0457b : 0x121212);
  reticle.material.opacity = on ? 0.6 : 0.3;
  reticle.visible = game.state === 'playing';
}

/* =============================================================================
   §8 ПРЕДМЕТЫ: раскладка на столе, физика, всасывание
   ========================================================================== */
/**
 * @typedef {Object} Item
 * @property {string} key        ключ типа в ITEM_TYPES
 * @property {Object} type       ITEM_TYPES[key]
 * @property {boolean} isTarget  входит ли в заказ уровня
 * @property {THREE.Group} mesh  3D-модель (mesh.position = позиция предмета, низ модели)
 * @property {THREE.Vector3} vel скорость
 * @property {'rest'|'pulled'|'hose'|'bagged'} state
 * @property {number} hoseU      0..1 — прогресс полёта по шлангу
 * @property {THREE.Mesh|null} bulge  «горб» на шланге, пока предмет летит внутри
 */
/** @type {Item[]} */
let items = [];

function disposeItemModel(group) {
  const sharedGeo = new Set(Object.values(GEO)), sharedMat = new Set(Object.values(M));
  group.traverse(o => {
    if (!o.isMesh) return;
    if (o.geometry && !sharedGeo.has(o.geometry)) o.geometry.dispose();
    for (const m of (Array.isArray(o.material) ? o.material : [o.material]))
      if (m && !sharedMat.has(m)) m.dispose();
  });
}
function clearItems() {
  for (const it of items) { scene.remove(it.mesh); disposeItemModel(it.mesh); if (it.bulge) scene.remove(it.bulge); }
  items = [];
}

/** Support the whole footprint on the cloth, including narrow raised folds.
 * A centre-only collision plane leaves the ends of a thin key inside the cloth.
 * Resting items reuse their cached height; only sliding items need resampling.
 */
function itemRestHeight(it) {
  const mesh = it.mesh, p = mesh.position, footprint = it.footprint;
  if (!footprint) return surfaceHeightAt(p.x, p.z);
  const cached = it.surfaceCache;
  if (cached && cached.x === p.x && cached.z === p.z && cached.yaw === mesh.rotation.y
    && cached.pitch === mesh.rotation.x && cached.roll === mesh.rotation.z) return cached.height;
  let support = -Infinity;
  const corner = new V3();
  const nx = Math.max(1, Math.ceil(footprint.halfX * 2 / .018));
  const nz = Math.max(1, Math.ceil(footprint.halfZ * 2 / .018));
  for (let ix = 0; ix <= nx; ix++) for (let iz = 0; iz <= nz; iz++) for (let iy = 0; iy < 2; iy++) {
    const x = -footprint.halfX + ix / nx * footprint.halfX * 2;
    const z = -footprint.halfZ + iz / nz * footprint.halfZ * 2;
    const y = iy ? footprint.maxY : footprint.minY;
    corner.set(x, y, z).applyQuaternion(mesh.quaternion);
    support = Math.max(support, surfaceHeightAt(p.x + corner.x, p.z + corner.z) - corner.y);
  }
  const height = support + .0015;
  it.surfaceCache = { x: p.x, z: p.z, yaw: mesh.rotation.y, pitch: mesh.rotation.x, roll: mesh.rotation.z, height };
  return height;
}

/** разложить предметы уровня по столу случайно, не накладывая друг на друга */
function spawnLevelItems(level) {
  clearItems();
  const list = [];
  for (const [key, n] of Object.entries(level.targets)) for (let i = 0; i < n; i++) list.push({ key, isTarget: true });
  for (const [key, n] of Object.entries(level.extras))  for (let i = 0; i < n; i++) list.push({ key, isTarget: false });
  shuffle(list);

  const T = CONFIG.table, margin = 0.12;
  const placed = [];
  for (const entry of list) {
    const type = ITEM_TYPES[entry.key];
    let x = 0, z = 0;
    for (let attempt = 0; attempt < 300; attempt++) {
      x = rand(T.x - T.w / 2 + margin, T.x + T.w / 2 - margin);
      z = rand(T.z - T.d / 2 + margin, T.z + T.d / 2 - margin);
      const ok = placed.every((p) => Math.hypot(p.x - x, p.z - z) > (p.r + type.r * CONFIG.items.scale) * 0.95);
      if (ok) break;
    }
    placed.push({ x, z, r: type.r * CONFIG.items.scale });
    const mesh = type.build();
    mesh.scale.setScalar(CONFIG.items.scale);
    const bounds = new THREE.Box3().setFromObject(mesh);
    const footprint = { halfX: Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)), halfZ: Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)), minY: bounds.min.y, maxY: bounds.max.y };
    mesh.position.set(x, 0, z);
    mesh.rotation.y = rand(0, Math.PI * 2);
    scene.add(mesh);
    const item = { key: entry.key, type, isTarget: entry.isTarget, mesh, footprint, vel: new V3(), state: 'rest', hoseU: 0, bulge: null };
    mesh.position.y = itemRestHeight(item);
    items.push(item);
  }
}

function isSucking() {
  return game.state === 'playing' && (input.mouseDown || input.keys.has('KeyF'));
}

function updateItems(dt) {
  const S = CONFIG.suction;
  const sucking = isSucking();
  const t = clock.elapsedTime;

  for (const it of items) {
    if (it.state === 'bagged') continue;

    // мигающие диоды у ловушек
    if (it.mesh.userData.blink) it.mesh.userData.blink.material.emissiveIntensity = Math.sin(t * 7 + it.mesh.id) > 0.3 ? 2.5 : 0.15;

    // летит по шлангу: от сопла (u=0) к сумке (u=1)
    if (it.state === 'hose') {
      it.hoseU += dt / CONFIG.hose.travelTime;
      if (it.hoseU >= 1) { putIntoBag(it); continue; }
      hoseCurve.getPointAt(1 - it.hoseU, it.bulge.position);
      continue;
    }

    const p = it.mesh.position;
    const toTip = _v1.subVectors(tip, p);
    const dist = toTip.length();

    if (sucking && dist < S.pullRadius) {
      // тянется к соплу: чем ближе, тем быстрее; тяжёлые — медленнее
      it.state = 'pulled';
      if (dist < S.swallowDist) { startHoseTravel(it); continue; }
      const speed = S.speed * (1.25 - dist / S.pullRadius) / it.type.weight;
      toTip.normalize().multiplyScalar(speed);
      it.vel.x = damp(it.vel.x, toTip.x, S.sharpness, dt);
      it.vel.y = damp(it.vel.y, toTip.y, S.sharpness, dt);
      it.vel.z = damp(it.vel.z, toTip.z, S.sharpness, dt);
      p.addScaledVector(it.vel, dt);
      it.mesh.rotation.x += rand(-1, 1) * dt * 5;   // дрожит
      it.mesh.rotation.z += rand(-1, 1) * dt * 5;
      p.y = Math.max(p.y, itemRestHeight(it));
    } else {
      // обычная физика: падает, лежит, трение
      if (it.state === 'pulled') it.state = 'rest';
      it.vel.y -= 9.8 * dt;
      p.addScaledVector(it.vel, dt);
      const ground = itemRestHeight(it);
      if (p.y <= ground) {
        p.y = ground; it.vel.y = 0;
        const fr = Math.exp(-10 * dt); it.vel.x *= fr; it.vel.z *= fr;
        it.mesh.rotation.x = damp(it.mesh.rotation.x, 0, 10, dt);
        it.mesh.rotation.z = damp(it.mesh.rotation.z, 0, 10, dt);
      }
      // не даём вещам улететь сквозь стены
      p.x = clamp(p.x, -CONFIG.room.halfW + 0.05, CONFIG.room.halfW - 0.05);
      p.z = clamp(p.z, -CONFIG.room.halfD + 0.05, CONFIG.room.halfD - 0.05);
    }
  }
}

function startHoseTravel(it) {
  it.state = 'hose';
  it.hoseU = 0;
  it.mesh.visible = false;
  const size = 0.028 + it.type.volume * 0.0014;       // крупные вещи дают больший «горб»
  it.bulge = new THREE.Mesh(GEO.bulge, M.hose);
  it.bulge.scale.setScalar(size);
  it.bulge.castShadow = true;
  hoseCurve.getPointAt(1, it.bulge.position);
  scene.add(it.bulge);
  Sound.gulp(it.type.volume);
}

/** предмет долетел до сумки — считаем очки, объём, эффекты, проверяем конец уровня */
function putIntoBag(it) {
  it.state = 'bagged';
  scene.remove(it.bulge); it.bulge = null;
  game.fill += it.type.volume;
  bagView.add(it);
  Sound.thud();

  if (it.isTarget) {
    game.collected[it.key] = (game.collected[it.key] || 0) + 1;
    game.money += it.type.value;
    toast('+ ' + it.type.name, 'good');
  } else {
    game.mistakes += 1;
    toast('лишнее: ' + it.type.name, 'bad');
    Sound.bad();
    if (it.type.effect === 'dye') {
      flashSplat();
      bagView.stain();
    }
    if (it.type.effect === 'tracker') {
      game.timeLeft = Math.max(0, game.timeLeft - CONFIG.bag.trackerPenalty);
      toast('метка в сумке: −' + CONFIG.bag.trackerPenalty + ' сек', 'bad');
      Sound.beep();
    }
  }
  renderOrder();

  if (game.fill > game.capacity + 1e-6) return endLevel(false, 'сумка лопнула — слишком много лишнего');
  const left = items.filter((i) => i.isTarget && i.state !== 'bagged').length;
  if (left === 0) endLevel(true);
}

/* =============================================================================
   §9 ОКНО «ВНУТРИ СУМКИ» — как финальный кадр видео: тёмная кожа, светящаяся молния,
   сверху падают всосанные вещи. Рисуется вторым проходом в угол экрана.
   ========================================================================== */
const bagView = (() => {
  const s = new THREE.Scene();
  s.environment = ENV;
  s.background = new THREE.Color(0x0b0807);
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.28, 0.6, 32, 1, true), M.bagInside);
  inner.position.y = -0.02;
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.28, 32), M.bagInside.clone());
  bottom.material.side = THREE.FrontSide; bottom.rotation.x = -Math.PI / 2; bottom.position.y = -0.3;
  const zipper = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.004, 0.62), M.glow);  // светящаяся щель молнии
  zipper.position.set(0.03, 0.27, 0);
  s.add(inner, bottom, zipper);
  const light = new THREE.PointLight(0xfff0d8, 1.3, 0.9, 1.6);
  light.position.set(0.03, 0.24, 0);
  s.add(light, new THREE.AmbientLight(0x2a1d16, 0.5));

  const cam = new THREE.PerspectiveCamera(62, CONFIG.pip.w / CONFIG.pip.h, 0.01, 5);
  cam.position.set(-0.05, 0.17, 0.2);
  cam.lookAt(0.02, -0.2, -0.03);

  let pile = [];
  let stackY = 0;
  const dyeEl = document.querySelector('#pip .dye');

  return {
    scene: s, camera: cam,
    /** положить копию предмета в сумку — она упадёт сверху на кучу */
    add(it) {
      const m = it.type.build();
      m.scale.setScalar(1.8);
      m.position.set(rand(-0.13, 0.13), 0.25, rand(-0.1, 0.08));
      m.rotation.set(rand(-0.5, 0.5), rand(0, Math.PI * 2), rand(-0.5, 0.5));
      s.add(m);
      pile.push({ m, targetY: -0.3 + stackY, vy: 0 });
      stackY += it.type.volume * 0.0017;
    },
    stain() { dyeEl.style.opacity = 1; },
    reset() { pile.forEach((p) => { s.remove(p.m); disposeItemModel(p.m); }); pile = []; stackY = 0; dyeEl.style.opacity = 0; },
    update(dt) {
      for (const p of pile) {
        if (p.m.position.y > p.targetY) { p.vy -= 6 * dt; p.m.position.y = Math.max(p.targetY, p.m.position.y + p.vy * dt); }
        if (p.m.userData.blink) p.m.userData.blink.material.emissiveIntensity = Math.sin(clock.elapsedTime * 7) > 0.3 ? 2.5 : 0.15;
      }
    },
    get count() { return pile.length; },
  };
})();

/* =============================================================================
   §10 ВВОД
   ========================================================================== */
const input = {
  keys: new Set(), mouseNdc: new THREE.Vector2(0, 0),
  hasAim: false, mouseDown: false, rightDrag: false,
  lastX: 0, lastY: 0, locked: false, dragLook: false, debugAim: null,
};
const canvas = renderer.domElement;
canvas.tabIndex = 0;
canvas.setAttribute('aria-label', 'Игровая сцена. WASD — движение, пробел — прыжок, мышь — обзор, ЛКМ или F — пылесос.');
function clearInput() {
  input.keys.clear(); input.mouseDown = false; input.rightDrag = false;
}
function orbitCamera(dx, dy) {
  camState.yaw -= dx * CONFIG.camera.sensitivity;
  camState.pitch = clamp(camState.pitch + dy * CONFIG.camera.sensitivity, CONFIG.camera.minPitch, CONFIG.camera.maxPitch);
}
function dragLookFallback() {
  input.dragLook=true;input.mouseNdc.set(0,0);input.hasAim=true;
  document.getElementById('mouse-look').textContent='курсор для сбора · M';
  document.body.classList.add('drag-look');
  toast('Зажми мышь и веди для обзора. F — пылесос. Пробел — прыжок. M — курсор для сбора.');
}
function toggleMouseMode() {
  if(input.locked)releaseMouseLook();
  else if(input.dragLook){input.dragLook=false;document.body.classList.remove('drag-look');document.getElementById('mouse-look').textContent='обзор мышью';}
  else requestMouseLook();
}
function requestMouseLook() {
  if (game.state !== 'playing') return;
  canvas.focus({preventScroll:true});
  if (!canvas.requestPointerLock) { dragLookFallback(); return; }
  try { const p=canvas.requestPointerLock(); if(p?.catch) p.catch(()=>{if(!input.dragLook)dragLookFallback();}); } catch (_) { dragLookFallback(); }
}
function releaseMouseLook() { if(document.pointerLockElement===canvas) document.exitPointerLock(); }
function cursorAim(e) {
  const r=canvas.getBoundingClientRect();
  input.mouseNdc.set((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2);
  input.hasAim=true;
}
canvas.addEventListener('contextmenu', e=>e.preventDefault());
canvas.addEventListener('pointerdown', e=>{
  Sound.init(); canvas.focus({preventScroll:true});
  if (!input.locked && !input.dragLook) cursorAim(e);
  if (e.button===0 && game.state==='playing' && !input.dragLook) input.mouseDown=true;
  if(e.button===2 || (e.button===0 && (input.dragLook || game.state==='intro'))) { input.rightDrag=true; input.lastX=e.clientX; input.lastY=e.clientY; }
  if(!input.locked) try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
});
window.addEventListener('pointerup',e=>{
  if(e.button===0) input.mouseDown=false;
  if(e.button===2 || e.button===0) input.rightDrag=false;
});
canvas.addEventListener('lostpointercapture',()=>{input.rightDrag=false;input.mouseDown=false;});
window.addEventListener('pointermove',e=>{
  if(input.locked) { orbitCamera(e.movementX,e.movementY); input.mouseNdc.set(0,0);input.hasAim=true; }
  else if(input.rightDrag) { orbitCamera(e.clientX-input.lastX,e.clientY-input.lastY);input.lastX=e.clientX;input.lastY=e.clientY;if(input.dragLook){input.mouseNdc.set(0,0);input.hasAim=true;} }
  else if(e.target===canvas&&!input.dragLook) cursorAim(e);
});
document.addEventListener('pointerlockchange',()=>{
  input.locked=document.pointerLockElement===canvas;
  input.dragLook=false;document.body.classList.remove('drag-look');
  document.body.classList.toggle('mouse-look',input.locked);
  document.getElementById('mouse-look').textContent=input.locked?'Esc · курсор':'обзор мышью';
  clearInput();
  if(input.locked) { input.mouseNdc.set(0,0);input.hasAim=true; }
});
document.addEventListener('pointerlockerror',()=>{if(!input.dragLook)dragLookFallback();});
canvas.addEventListener('wheel',e=>{
  camState.distance=clamp(camState.distance+e.deltaY*.0015,CONFIG.camera.minDist,CONFIG.camera.maxDist);
  e.preventDefault();
},{passive:false});
window.addEventListener('keydown',e=>{
  if(e.target?.matches?.('input,textarea,select,[contenteditable]')) return;
  if(e.target?.closest?.('button,a') && ['Space','Enter'].includes(e.code)) return;
  if (!assets.ready) return;
  if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
  const wasHeld = input.keys.has(e.code);
  input.keys.add(e.code);
  if(e.repeat)return;
  if(e.code==='Space'&&!wasHeld)requestJump();
  if(e.code==='KeyV') resetCamera();
  if(e.code==='KeyH')document.body.classList.toggle('clean-view');
  if(e.code==='KeyP')togglePause();
  if(e.code==='KeyM')toggleMouseMode();
  if(e.code==='Escape'&&input.dragLook)toggleMouseMode();
  if(e.code==='KeyR'&&game.state!=='intro')startLevel(game.levelIndex);
  if(e.code==='Enter'&&game.state==='won')nextLevel();
  if(e.code==='Enter'&&game.state==='lost')startLevel(game.levelIndex);
});
window.addEventListener('keyup',e=>input.keys.delete(e.code));
window.addEventListener('blur',()=>{clearInput();if(game.state==='playing')togglePause();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearInput();if(game.state==='playing')togglePause();}});

const raycaster = new THREE.Raycaster();
const floorPlane = new THREE.Plane(new V3(0, 1, 0), 0);

/** куда указывает мышь: сначала стол, иначе пол. Потом ограничиваем длиной шланга. */
/** true, если курсор дальше, чем достаёт шланг (показываем подсказку «подойди ближе») */
let aimOutOfReach = false;

function computeAimTarget(out) {
  let aimedY = 0;   // высота поверхности, на которую указывает курсор (стол или пол)
  if (game.state === 'intro') {
    return out.set(CONFIG.table.x + .3, CONFIG.table.h + CONFIG.hose.hover, CONFIG.table.z -.20);
  }
  if (!input.hasAim && !input.debugAim) {
    out.set(CONFIG.table.x + .3, CONFIG.table.h, CONFIG.table.z -.20);
    aimedY = CONFIG.table.h;
  } else if (input.debugAim) {
    out.set(input.debugAim.x, 0, input.debugAim.z);
    aimedY = surfaceHeightAt(out.x, out.z);
  } else {
    raycaster.setFromCamera(input.mouseNdc, camera);
    const hit = raycaster.intersectObject(tableTopMesh, false)[0];
    if (hit) { out.copy(hit.point); aimedY = CONFIG.table.h; }
    else if (raycaster.ray.intersectPlane(floorPlane, out)) aimedY = surfaceHeightAt(out.x, out.z);
    else { out.copy(tipTarget); aimedY = tipTarget.y - CONFIG.hose.hover; }
  }
  // ограничение по длине шланга
  let dx = out.x - player.pos.x, dz = out.z - player.pos.z;
  let len = Math.hypot(dx, dz);
  if (len < 1e-4) { dx = -Math.sin(player.yaw); dz = -Math.cos(player.yaw); len = 1; }
  aimOutOfReach = len > CONFIG.hose.reach + 0.05;
  const r = clamp(len, CONFIG.hose.minReach, CONFIG.hose.reach);
  out.x = player.pos.x + dx / len * r;
  out.z = player.pos.z + dz / len * r;
  // Высота сопла = высота того, на что указывает курсор. Если целишься в стол, а шланг
  // не достаёт, сопло всё равно держится на уровне стола (висит в воздухе у края) —
  // подойди ближе, и оно ляжет на стол. Но не ниже поверхности прямо под соплом.
  out.y = Math.max(aimedY, surfaceHeightAt(out.x, out.z)) + CONFIG.hose.hover;
  return out;
}

/* =============================================================================
   §11 КАМЕРА от третьего лица: сзади-сверху, чуть через правое плечо
   ========================================================================== */
const camState = { yaw: .8, pitch: CONFIG.camera.pitch, distance: CONFIG.camera.distance, pos:new V3(),look:new V3() };
function resetCamera() {
  camState.yaw=player.yaw;camState.pitch=CONFIG.camera.pitch;camState.distance=CONFIG.camera.distance;
}
function updateCamera(dt,snap=false) {
  const C=CONFIG.camera;
  if(input.keys.has('KeyQ'))camState.yaw+=1.8*dt;
  if(input.keys.has('KeyE'))camState.yaw-=1.8*dt;
  const sy=Math.sin(camState.yaw),cy=Math.cos(camState.yaw);
  // Track part of the leap so the room stays readable without losing the head.
  const lookHeight=C.lookHeight+player.pos.y*.55;
  const pivot=new V3(player.pos.x+cy*C.shoulder,lookHeight,player.pos.z-sy*C.shoulder);
  const R=CONFIG.room,margin=.16;
  pivot.x=clamp(pivot.x,-R.halfW+.40,R.halfW-.40);
  pivot.z=clamp(pivot.z,-R.halfD+.40,R.halfD-.40);
  const boom=new V3(sy*Math.cos(camState.pitch),Math.sin(camState.pitch),cy*Math.cos(camState.pitch));
  let distance=camState.distance;
  // Shorten the camera boom against room bounds, keeping its direction unchanged.
  const lo=[-R.halfW+margin,.18,-R.halfD+margin], hi=[R.halfW-margin,R.height-.18,R.halfD-margin];
  for(let axis=0;axis<3;axis++) {
    const d=boom.getComponent(axis),p=pivot.getComponent(axis);
    if(d>1e-6) distance=Math.min(distance,(hi[axis]-p)/d);
    else if(d< -1e-6)distance=Math.min(distance,(lo[axis]-p)/d);
  }
  const table=CONFIG.table;
  const tableBox=new THREE.Box3(new V3(table.x-table.w/2-.08,0,table.z-table.d/2-.08),new V3(table.x+table.w/2+.08,table.h+.1,table.z+table.d/2+.08));
  const hit=new THREE.Ray(pivot,boom).intersectBox(tableBox,new V3());
  if(hit&&!tableBox.containsPoint(pivot))distance=Math.min(distance,Math.max(.10,pivot.distanceTo(hit)-.10));
  distance=Math.max(.10,distance);
  const desired=pivot.clone().addScaledVector(boom,distance);
  // Orbit responds immediately. Smoothing only the tracked pivot avoids mouse lag.
  if(snap)camState.look.copy(pivot);
  else camState.look.lerp(pivot,1-Math.exp(-C.sharpness*dt));
  camState.pos.copy(desired);camera.position.copy(desired);camera.lookAt(pivot);
  camera.updateMatrixWorld();
  // Never toggle the character out of existence at a wall. If the shortened
  // boom intersects the body, slide the camera to the nearest free side.
  const centre = new V3(player.pos.x, lookHeight, player.pos.z);
  if (camera.position.distanceTo(centre) < .60) {
    let nearest = null, best = Infinity;
    for (let i = 0; i < 16; i++) {
      const a = camState.yaw + i * Math.PI / 8;
      const candidate = centre.clone().add(new V3(Math.sin(a) * .78, .20, Math.cos(a) * .78));
      if (Math.abs(candidate.x) > R.halfW - margin || Math.abs(candidate.z) > R.halfD - margin || tableBox.containsPoint(candidate)) continue;
      const score = candidate.distanceToSquared(desired);
      if (score < best) { best = score; nearest = candidate; }
    }
    if (nearest) { camera.position.copy(nearest); camera.lookAt(pivot); camera.updateMatrixWorld(); }
  }
  hero.root.visible = true;
}

/* ---------- движение игрока ---------- */
function requestJump() {
  if (game.state !== 'playing' || !assets.ready || !player.grounded) return;
  player.grounded = false;
  player.verticalVelocity = CONFIG.player.jumpSpeed;
}

function applyJumpPose() {
  if (player.grounded || !hero.rigMesh) return;
  const progress = clamp((CONFIG.player.jumpSpeed - player.verticalVelocity) / (2 * CONFIG.player.jumpSpeed), 0, 1);
  const tuck = Math.sin(progress * Math.PI);
  const right = new V3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  const parentRotation = new THREE.Quaternion(), bend = new THREE.Quaternion();
  // Bend around the character's world-right axis, converted into each bone's
  // parent frame. The imported rig's local axes are not aligned with the room.
  for (const side of ['Left', 'Right']) {
    for (const [name, angle] of [[side + 'UpLeg', .22], [side + 'Leg', -.52]]) {
      const bone = hero.rigMesh.skeleton.getBoneByName(name);
      if (!bone) continue;
      hero.jumpPoseBase.push({ bone, quaternion: bone.quaternion.clone() });
      bone.parent.getWorldQuaternion(parentRotation).invert();
      const axis = right.clone().applyQuaternion(parentRotation);
      bone.quaternion.premultiply(bend.setFromAxisAngle(axis, angle * tuck));
      bone.updateMatrixWorld(true);
    }
  }
}

function updatePlayer(dt) {
  const k = input.keys;
  let fx = 0, fz = 0;   // ввод в системе камеры: fz = вперёд, fx = вправо
  if (game.state === 'playing') {
    if (k.has('KeyW') || k.has('ArrowUp')) fz += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fz -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
  }
  const len = Math.hypot(fx, fz);
  if (len > 0) { fx /= len; fz /= len; }
  // «вперёд» камеры = (-sin yaw, -cos yaw); «вправо» = (cos yaw, -sin yaw)
  const sy = Math.sin(camState.yaw), cy = Math.cos(camState.yaw);
  const vx = (-sy * fz + cy * fx) * CONFIG.player.speed;
  const vz = (-cy * fz - sy * fx) * CONFIG.player.speed;
  const previousX = player.pos.x, previousZ = player.pos.z;
  player.pos.x += vx * dt;
  player.pos.z += vz * dt;
  resolveCollisions(player.pos);
  if (!player.grounded) {
    // Exact ballistic integration is independent of frame rate. Furniture
    // keeps its horizontal collision; this is a hop, not a climb onto tables.
    player.pos.y += player.verticalVelocity * dt - .5 * CONFIG.player.gravity * dt * dt;
    player.verticalVelocity -= CONFIG.player.gravity * dt;
    if (player.pos.y <= 0) {
      player.pos.y = 0;
      player.verticalVelocity = 0;
      player.grounded = true;
    }
  }

  const speed = dt > 0 ? Math.hypot(player.pos.x - previousX, player.pos.z - previousZ) / dt : 0;
  player.moveAmount = damp(player.moveAmount, Math.min(speed / CONFIG.player.speed, 1), 12, dt);
  player.walkPhase += dt * 9 * player.moveAmount;

  // тело всегда повёрнуто к соплу
  const dx = tip.x - player.pos.x, dz = tip.z - player.pos.z;
  if (len > 0) player.yaw = dampAngle(player.yaw, Math.atan2(-vx, -vz), CONFIG.player.turnSharpness, dt);

  hero.root.position.copy(player.pos);
  hero.root.rotation.set(0, player.yaw, 0);
  // Restore the prior procedural layer before the mixer evaluates. At zero
  // clip weight Three.js can skip unchanged tracks, so additive bends must
  // never accumulate directly on last frame's pose.
  for (const pose of hero.jumpPoseBase || []) pose.bone.quaternion.copy(pose.quaternion);
  hero.jumpPoseBase = [];
  if (hero.mixer && hero.realAction) {
    const weight = !player.grounded || player.moveAmount < .005 ? 0 : player.moveAmount;
    hero.realAction.setEffectiveWeight(weight);
    hero.realAction.setEffectiveTimeScale(.8 + .4 * weight);
    hero.mixer.update(dt);
  }
  hero.root.updateMatrixWorld(true);
  applyJumpPose();

  // поза
  const swing = Math.sin(player.walkPhase) * 0.28 * player.moveAmount;
  hero.legs[0].rotation.x = swing;
  hero.legs[1].rotation.x = -swing;
  hero.armR.shoulder.rotation.x = -swing * 0.10;
  // левая рука тянется к шлангу: чем дальше сопло, тем выше рука
  const reach01 = clamp((Math.hypot(dx, dz) - CONFIG.hose.minReach) / (CONFIG.hose.reach - CONFIG.hose.minReach), 0, 1);
  hero.armL.shoulder.rotation.x = 0.08 + reach01 * 0.12;
  hero.armL.shoulder.rotation.z = -0.06;
}

/** не пускаем игрока в стены, стол и стул */
function resolveCollisions(p) {
  const R = CONFIG.player.radius, { halfW, halfD } = CONFIG.room;
  p.x = clamp(p.x, -halfW + R, halfW - R);
  p.z = clamp(p.z, -halfD + R, halfD - R);
  for (const b of obstacles) {
    const cx = clamp(p.x, b.minX, b.maxX), cz = clamp(p.z, b.minZ, b.maxZ);
    const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
    if (d2 >= R * R) continue;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      p.x = cx + dx / d * R; p.z = cz + dz / d * R;
    } else {                    // центр внутри прямоугольника — выталкиваем по ближайшей стороне
      const pens = [[p.x - b.minX + R, -1, 0], [b.maxX - p.x + R, 1, 0], [p.z - b.minZ + R, 0, -1], [b.maxZ - p.z + R, 0, 1]];
      pens.sort((a, c) => a[0] - c[0]);
      p.x += pens[0][1] * pens[0][0]; p.z += pens[0][2] * pens[0][0];
    }
  }
}

/* =============================================================================
   §12 HUD
   ========================================================================== */
const el = {
  order: document.getElementById('order'),
  stats: document.getElementById('stats'),
  fill: document.getElementById('fill'),
  fillLevel: document.querySelector('#fill .level'),
  fillNeed: document.querySelector('#fill .need'),
  fillPct: document.querySelector('#fill .pct'),
  pip: document.getElementById('pip'),
  toasts: document.getElementById('toasts'),
  hover: document.getElementById('hover'),
  hint: document.getElementById('hint'),
  splat: document.getElementById('splat'),
  overlay: document.getElementById('overlay'),
  card: document.querySelector('#overlay .card'),
};

function layoutHUD() {
  const P = CONFIG.pip;
  P.w = innerWidth < 650 ? 140 : 210; P.h = innerWidth < 650 ? 102 : 148; P.margin = innerWidth < 650 ? 12 : 20;
  bagView.camera.aspect = P.w/P.h; bagView.camera.updateProjectionMatrix();
  Object.assign(el.pip.style, { width: P.w + 'px', height: P.h + 'px', right: P.margin + 'px', bottom: P.margin + 'px' });
  Object.assign(el.fill.style, { height: P.h + 'px', right: (P.margin + P.w + 8) + 'px', bottom: P.margin + 'px' });
}
layoutHUD();

/** список заказа слева сверху */
function renderOrder() {
  const L = LEVELS[game.levelIndex];
  let html = `<div class="cap">уровень ${game.levelIndex + 1} / ${LEVELS.length}</div><div class="lvl">${L.name}</div><div class="cap">заказ</div>`;
  for (const [key, n] of Object.entries(L.targets)) {
    const got = game.collected[key] || 0;
    html += `<div class="row ${got >= n ? 'done' : ''}"><span>${ITEM_TYPES[key].name}</span><span>${got}/${n}</span></div>`;
  }
  html += `<div class="note">всё остальное — лишнее</div>`;
  el.order.innerHTML = html;
}

function updateHUD() {
  document.body.dataset.state = game.state;
  const t = Math.max(0, game.timeLeft);
  const mm = Math.floor(t / 60), ss = Math.floor(t % 60).toString().padStart(2, '0');
  el.stats.innerHTML = `<div class="cap">время</div><div class="timer ${t < 10 ? 'low' : ''}">${mm}:${ss}</div>` +
    `<div class="cap" style="margin-top:6px">добыча</div><div>$${game.money.toLocaleString('ru-RU')}</div>` +
    `<div class="cap" style="margin-top:6px">лишнего</div><div>${game.mistakes}</div>`;

  // индикатор заполненности сумки
  const ratio = game.fill / game.capacity;
  el.fillLevel.style.height = Math.min(100, ratio * 100) + '%';
  el.fillLevel.className = 'level' + (ratio > 0.92 ? ' danger' : ratio > 0.8 ? ' warn' : '');
  el.fillPct.textContent = Math.round(ratio * 100) + '%';
  el.fillNeed.style.bottom = (game.need / game.capacity * 100) + '%';   // зелёная черта: столько займёт весь заказ

  el.hint.style.display = (game.state === 'playing' && aimOutOfReach) ? 'block' : 'none';

  // подпись предмета под соплом
  let near = null, best = CONFIG.suction.pullRadius * 1.3;
  if (game.state === 'playing') for (const it of items) {
    if (it.state !== 'rest' && it.state !== 'pulled') continue;
    const d = it.mesh.position.distanceTo(tip);
    if (d < best) { best = d; near = it; }
  }
  if (near) {
    const p = near.mesh.position.clone(); p.y += 0.05; p.project(camera);
    el.hover.style.display = 'block';
    el.hover.style.left = ((p.x + 1) / 2 * window.innerWidth) + 'px';
    el.hover.style.top = ((1 - p.y) / 2 * window.innerHeight) + 'px';
    el.hover.textContent = near.type.name;
  } else el.hover.style.display = 'none';
}

function toast(text, kind = '') {
  const d = document.createElement('div');
  d.className = 'toast ' + kind; d.textContent = text;
  el.toasts.appendChild(d);
  setTimeout(() => d.remove(), 1700);
}

function flashSplat() {
  el.splat.style.transition = 'none'; el.splat.style.opacity = 1;
  requestAnimationFrame(() => requestAnimationFrame(() => { el.splat.style.transition = 'opacity 2.2s'; el.splat.style.opacity = 0; }));
}

/** показать экран поверх игры. buttons: [{label, ghost?, onClick}] */
function showOverlay(html, buttons) {
  el.card.innerHTML = html + '<div class="btns"></div>';
  const box = el.card.querySelector('.btns');
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.textContent = b.label; if (b.ghost) btn.className = 'ghost';
    btn.addEventListener('click', () => { Sound.init(); b.onClick(); });
    box.appendChild(btn);
  }
  el.overlay.classList.remove('hidden');
}
function hideOverlay() { el.overlay.classList.add('hidden'); }

/* =============================================================================
   §13 ЗВУК — всё синтезируется WebAudio (гул мотора, шум воздуха, «глоток», ошибки)
   ========================================================================== */
const Sound = {
  ctx: null,
  muted: (() => { try { return localStorage.getItem('bag-vacuum-muted') === '1'; } catch (_) { return false; } })(),
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.7; this.master.connect(ctx.destination);
    // шум воздуха
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.frequency.value = 900; band.Q.value = 0.6;
    this.noiseGain = ctx.createGain(); this.noiseGain.gain.value = 0;
    noise.connect(band); band.connect(this.noiseGain); this.noiseGain.connect(this.master); noise.start();
    // мотор
    this.motor = ctx.createOscillator(); this.motor.type = 'sawtooth'; this.motor.frequency.value = 120;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
    this.motorGain = ctx.createGain(); this.motorGain.gain.value = 0;
    this.motor.connect(lp); lp.connect(this.motorGain); this.motorGain.connect(this.master); this.motor.start();
  },
  setSuction(on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseGain.gain.setTargetAtTime(on ? 0.22 : 0, t, on ? 0.08 : 0.15);
    this.motorGain.gain.setTargetAtTime(on ? 0.07 : 0, t, 0.1);
    this.motor.frequency.setTargetAtTime(on ? 210 : 120, t, 0.25);
  },
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : .7, this.ctx.currentTime, .03);
    try { localStorage.setItem('bag-vacuum-muted', this.muted ? '1' : '0'); } catch (_) {}
    updateSoundButton();
  },
  blip(freq0, freq1, dur, type = 'sine', vol = 0.3) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq0, t); o.frequency.exponentialRampToValueAtTime(freq1, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  },
  gulp(volume) { this.blip(420 - volume * 12, 90, 0.16, 'sine', 0.35); },
  thud()  { this.blip(140, 50, 0.12, 'triangle', 0.3); },
  bad()   { this.blip(160, 110, 0.28, 'square', 0.12); },
  beep()  { this.blip(1400, 1400, 0.08, 'square', 0.08); setTimeout(() => this.blip(1400, 1400, 0.08, 'square', 0.08), 140); },
  win()   { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.blip(f, f, 0.18, 'triangle', 0.2), i * 110)); },
  lose()  { this.blip(300, 70, 0.6, 'sawtooth', 0.15); },
};

/* =============================================================================
   §14 СОСТОЯНИЕ ИГРЫ И ГЛАВНЫЙ ЦИКЛ
   state: 'intro' → 'playing' → 'won' | 'lost' → (следующий уровень / заново)
   ========================================================================== */
const game = {
  state: 'intro',
  levelIndex: 0,
  timeLeft: 0,
  fill: 0,          // сколько объёма уже в сумке
  capacity: 1,      // вместимость сумки
  need: 0,          // объём всего заказа (зелёная черта на индикаторе)
  collected: {},    // сколько взято по каждому типу из заказа
  money: 0,
  mistakes: 0,
};
const clock = new THREE.Clock();

function startLevel(index, silent = false) {
  if (!Number.isInteger(index) || !LEVELS[index] || (!assets.ready && !silent)) return;
  const L = LEVELS[index];
  game.levelIndex = index;
  game.state = 'playing';
  clearInput();
  input.hasAim = false; input.debugAim = null;
  document.getElementById('pause').textContent = 'пауза';
  game.timeLeft = L.time;
  game.fill = 0;
  game.need = Object.entries(L.targets).reduce((s, [k, n]) => s + ITEM_TYPES[k].volume * n, 0);
  game.capacity = Math.round(game.need * CONFIG.bag.capacityFactor);
  game.collected = {};
  game.money = 0;
  game.mistakes = 0;

  player.pos.set(CONFIG.player.startX, 0, CONFIG.player.startZ);
  player.verticalVelocity = 0; player.grounded = true;
  player.moveAmount = 0; player.walkPhase = 0;
  player.yaw = .8;
  resetCamera();
  tip.set(CONFIG.table.x, CONFIG.table.h + CONFIG.hose.hover, CONFIG.table.z + CONFIG.table.d / 2 - 0.1);
  spawnLevelItems(L);
  bagView.reset();
  el.splat.style.opacity = 0;
  renderOrder();
  hideOverlay();
  if (!silent) { toast(L.brief); canvas.focus({ preventScroll: true }); }
  updatePlayer(0);
  updateCamera(0, true);
  const aimNdc=tip.clone().project(camera);
  input.mouseNdc.set(aimNdc.x,aimNdc.y);
}

function nextLevel() {
  if (game.levelIndex + 1 < LEVELS.length) startLevel(game.levelIndex + 1);
  else showIntro(true);
}

function endLevel(won, reason) {
  if (game.state !== 'playing') return;
  game.state = won ? 'won' : 'lost';
  releaseMouseLook(); clearInput();
  input.mouseDown = false;
  Sound.setSuction(false);
  const stats = `<p class="dim">добыча: $${game.money.toLocaleString('ru-RU')} · лишнего: ${game.mistakes} · сумка: ${Math.round(game.fill / game.capacity * 100)}% · осталось ${Math.ceil(game.timeLeft)} сек</p>`;
  if (won) {
    Sound.win();
    const last = game.levelIndex + 1 >= LEVELS.length;
    showOverlay(`<h2>чисто. всё в сумке</h2>${stats}${last ? '<p>это был последний уровень.</p>' : ''}`, [
      { label: last ? 'в начало' : 'дальше  ↵', onClick: nextLevel },
      { label: 'ещё раз', ghost: true, onClick: () => startLevel(game.levelIndex) },
    ]);
  } else {
    Sound.lose();
    showOverlay(`<h2>${reason}</h2>${stats}`, [
      { label: 'заново  ↵', onClick: () => startLevel(game.levelIndex) },
    ]);
  }
}

function togglePause() {
  if(!['playing','paused'].includes(game.state)) return;
  game.state = game.state === 'paused' ? 'playing' : 'paused';
  clearInput(); if(game.state==='paused') releaseMouseLook(); Sound.setSuction(false);
  document.getElementById('pause').textContent=game.state === 'paused' ? 'продолжить' : 'пауза';
  if (game.state === 'playing') { Sound.init(); canvas.focus({ preventScroll: true }); }
}
document.getElementById('reset-view').onclick=resetCamera;
document.getElementById('mouse-look').onclick=toggleMouseMode;
document.getElementById('pause').onclick=togglePause;
document.getElementById('hide-hud').onclick=()=>document.body.classList.toggle('clean-view');
function updateSoundButton() {
  const button = document.getElementById('sound-toggle');
  if (button) { button.textContent = Sound.muted ? 'звук: выкл' : 'звук: вкл'; button.setAttribute('aria-pressed', String(Sound.muted)); }
}
document.getElementById('sound-toggle')?.addEventListener('click', () => Sound.toggleMute());
updateSoundButton();
const fullscreenButton = document.getElementById('fullscreen');
if (fullscreenButton) {
  fullscreenButton.hidden = !document.documentElement.requestFullscreen;
  fullscreenButton.onclick = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch (_) { toast('Полный экран недоступен в этом браузере.'); }
  };
}
document.addEventListener('fullscreenchange', () => {
  if (fullscreenButton) { fullscreenButton.textContent = document.fullscreenElement ? 'свернуть' : 'полный экран'; fullscreenButton.setAttribute('aria-pressed', String(!!document.fullscreenElement)); }
});
function showIntro(finished = false) {
  game.state = 'intro';
  releaseMouseLook(); clearInput();
  player.pos.set(CONFIG.player.startX, 0, CONFIG.player.startZ);
  player.verticalVelocity = 0; player.grounded = true;
  player.yaw = -.4; player.moveAmount = 0;
  camState.yaw = player.yaw + Math.PI; camState.pitch = .12; camState.distance = 1.85;
  updatePlayer(0);
  showOverlay(`
    <h1>СУМКА-ПЫЛЕСОС</h1>
    <p class="dim">по видео «сумкапылесос» · практика 9 · версия ${GAME_VERSION}</p>
    ${finished ? '<p><b>Все уровни пройдены.</b></p>' : ''}
    <p>Деньги, золото, ключи. Собери заказ со стола. Лишнее забивает сумку — не переполни её.</p>
    <p class="dim">WASD — идти · пробел — прыгать<br>ПКМ + мышь — обзор во все стороны<br>Курсор — сопло · ЛКМ / F — пылесос<br>Колесо — расстояние · V — камера за спиной<br>M — игровой обзор · P — пауза</p>
    <p class="desktop-note">Для игры нужны клавиатура и мышь.</p>`, [
    { label: 'играть', onClick: () => { startLevel(0); } },
    ...LEVELS.slice(1).map((L, i) => ({ label: `${i + 2}. ${L.name}`, ghost: true, onClick: () => { startLevel(i + 1); } })),
  ]);
}

/** один шаг симуляции (dt — секунды) */
let wasSucking = false;
function step(dt) {
  if (game.state === 'paused') { updateCamera(dt); updateHUD(); return; }
  if (game.state === 'playing') {
    game.timeLeft -= dt;
    if (game.timeLeft <= 0) { game.timeLeft = 0; endLevel(false, 'время вышло'); }
  }
  updatePlayer(dt);
  updateCamera(dt);

  // сопло плавно следует за прицелом; вверх (на стол) поднимается сразу, чтобы не проходить сквозь край
  computeAimTarget(tipTarget);
  tip.x = damp(tip.x, tipTarget.x, 18, dt);
  tip.z = damp(tip.z, tipTarget.z, 18, dt);
  const wantY = Math.max(tipTarget.y, surfaceHeightAt(tip.x, tip.z) + CONFIG.hose.hover);
  tip.y = wantY > tip.y ? wantY : damp(tip.y, wantY, 14, dt);

  const sucking = isSucking();
  if (sucking !== wasSucking) { Sound.setSuction(sucking); wasSucking = sucking; }

  updateBagAndHose(dt);
  if (game.state === 'playing') { updateItems(dt); bagView.update(dt); }
  updateHUD();
}

function render() {
  const w = window.innerWidth, h = window.innerHeight, P = CONFIG.pip;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  renderer.render(scene, camera);
  if (game.state === 'intro' || document.body.classList.contains('clean-view')) return;
  // второй проход — «внутри сумки» в правом нижнем углу (координаты viewport считаются снизу)
  renderer.setScissorTest(true);
  renderer.setScissor(w - P.margin - P.w, P.margin, P.w, P.h);
  renderer.setViewport(w - P.margin - P.w, P.margin, P.w, P.h);
  renderer.render(bagView.scene, bagView.camera);
  renderer.setScissorTest(false);
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!QA_MODE && assets.ready) step(dt);
  render();
}

window.addEventListener('resize', () => {
  layoutHUD();
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// старт: раскладываем первый уровень «на фоне» и показываем заставку
startLevel(2, true);   // набор предметов из видео на фоне заставки
game.state = 'intro';
showIntro();
updateCamera(0, true);
if (new URLSearchParams(location.search).has('inspect')) {
  document.body.classList.add('clean-view');
}
frame();

/* =============================================================================
   §15 DEBUG API — window.GAME. Пример в консоли браузера:
     GAME.start(2)                 // сразу 3-й уровень
     GAME.aim(0.2, -1.2)           // навести сопло на точку стола (x, z)
     GAME.suck(true)               // включить всасывание
     GAME.items.filter(i => i.isTarget)
   ========================================================================== */
window.GAME = {
  version: GAME_VERSION, revision: ASSET_REVISION,
  CONFIG, ITEM_TYPES, LEVELS, game, player, camState, assets,
  camera, scene, renderer, hero, bag, hoseMesh, hoseRibs, pbr, input,
  get items() { return items; },
  get tip() { return tip.clone(); },
  start: startLevel,
  aim(x, z) { input.debugAim = (x == null) ? null : { x, z }; },
  suck(on) { input.mouseDown = !!on; },
  step, render,
};

if (new URLSearchParams(location.search).has('qa')) { const s=document.createElement('script');s.src='qa.js';document.body.appendChild(s); }
