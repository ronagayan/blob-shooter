// ── Canvas ─────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const WW = 1600, WH = 1200, WALL = 60, TILE = 64;
canvas.width  = WW;   // set drawing buffer to match the game world size
canvas.height = WH;
const ctx = canvas.getContext('2d');
const IL = WALL, IR = WW - WALL, IT = WALL, IB = WH - WALL;

// ── Combat Room ──────────────────────────────────
const DIVIDER_Y = 780, DIVIDER_THICK = 28;
const DOOR_LEFT = 700, DOOR_RIGHT = 900;
const solidRects = [
  { x: IL,         y: DIVIDER_Y, w: DOOR_LEFT - IL,  h: DIVIDER_THICK }, // divider left
  { x: DOOR_RIGHT, y: DIVIDER_Y, w: IR - DOOR_RIGHT, h: DIVIDER_THICK }, // divider right
  { x: 200, y: 640, w: 80, h: 80 },   // cover L-near
  { x: 1320, y: 640, w: 80, h: 80 },  // cover R-near
  { x: 280, y: 440, w: 80, h: 80 },   // cover L-mid
  { x: 1240, y: 440, w: 80, h: 80 },  // cover R-mid
  { x: 420, y: 220, w: 80, h: 80 },   // cover L-far
  { x: 1100, y: 220, w: 80, h: 80 },  // cover R-far
];
const enemy = {
  x: 800, y: 180, radius: 28,
  hp: 200, maxHp: 200,
  fireRate: 1800, lastFired: 0,
  bulletSpeed: 480, bulletDmg: 8, bulletRange: 900,
  alive: true, flashTimer: 0, angle: 0,
  losAlpha: 0,   // 0 = fully hidden, 1 = fully visible (smooth LOS fade)
};

// ── Multiplayer state ────────────────────────────
let ws             = null;   // WebSocket (null = solo mode)
let myId           = null;   // assigned by server on join
let serverSnapshot = null;   // latest state snapshot from server
let prevSnapshot   = null;   // snapshot before that (for interpolation)
let snapshotTime   = 0;      // performance.now() when latest snapshot arrived
let bulletLosAlpha         = new Map(); // bulletId  → current alpha for enemy bullets
let playerBulletLosAlpha   = new Map(); // bulletId  → current alpha for other players' bullets
let remotePlayerLosAlpha   = new Map(); // playerId  → LOS alpha for other players
let remotePlayerLastFired  = new Map(); // playerId  → performance.now() when they last fired out of sight
let remoteEnemyLosAlpha    = 0;         // smooth visibility for server-driven enemy
let enemyLastSeenFire      = 0;         // performance.now() when we last saw enemy flashTimer > 0

let canvasScale = 1;
let visibleBottomCanvasY = WH; // canvas-space y of the bottom edge of the viewport
function resize() {
  // Use visualViewport when available (more reliable on mobile/iOS)
  const vw = window.visualViewport ? window.visualViewport.width  : window.innerWidth;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;

  // Show rotate prompt in portrait mode
  const rotateEl = document.getElementById('rotatePrompt');
  if (rotateEl) rotateEl.style.display = vw < vh ? 'flex' : 'none';

  // Always scale to fill screen width (no side bars); top/bottom may be cropped
  canvasScale = vw / WW;

  // Canvas is fixed-positioned and always 1600x1200 CSS px; use transform to scale it
  canvas.style.transform = `scale(${canvasScale})`;

  // Track the visible bottom edge in canvas-space (used to position joystick hints)
  visibleBottomCanvasY = WH / 2 + (vh / 2) / canvasScale;
}
window.addEventListener('resize', resize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();

// ── Helpers ─────────────────────────────────────
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// Lighten / darken a hex colour for tinted blob bodies
function darkenHex(hex, f) {
  const r = Math.round(parseInt(hex.slice(1,3),16)*f);
  const g = Math.round(parseInt(hex.slice(3,5),16)*f);
  const b = Math.round(parseInt(hex.slice(5,7),16)*f);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}
function lightenHex(hex, f) {
  const r = Math.min(255, Math.round(parseInt(hex.slice(1,3),16)*f + 255*(1-f)));
  const g = Math.min(255, Math.round(parseInt(hex.slice(3,5),16)*f + 255*(1-f)));
  const b = Math.min(255, Math.round(parseInt(hex.slice(5,7),16)*f + 255*(1-f)));
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

// ── Player colour palette (join screen) ──────────
const PLAYER_COLORS = [
  '#44ff88','#44ccff','#ff9944','#cc44ff',
  '#ff4488','#ffdd44','#44ffcc','#ff5533',
];
let myPlayerColor = PLAYER_COLORS[0]; // chosen on join screen

// ── Input ───────────────────────────────────────
const keys = {};
const mouse = { x: WW / 2, y: WH / 2, down: false, justDown: false, justUp: false };

// ── Touch controls ──────────────────────────────
const touchControls = {
  enabled: false,
  leftId:  null, leftOriginX:  0, leftOriginY:  0, leftCurX:  0, leftCurY:  0,
  rightId: null, rightOriginX: 0, rightOriginY: 0, rightCurX: 0, rightCurY: 0,
};
// Joystick sizes are derived in screen-px and divided by canvasScale at draw/input time
const JOYSTICK_SCREEN_MAX  = 80;  // desired screen-px radius for the joystick ring
const JOYSTICK_SCREEN_DEAD = 20;  // desired screen-px dead-zone radius
const JOYSTICK_SCREEN_KNOB = 34;  // desired screen-px radius for the knob

function toCanvasCoords(touch) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (touch.clientX - r.left) * (WW / r.width),
    y: (touch.clientY - r.top)  * (WH / r.height),
  };
}
function onTouchStart(e) {
  if (!touchControls.enabled) return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    const { x, y } = toCanvasCoords(t);
    if (x < WW / 2 && touchControls.leftId === null) {
      touchControls.leftId = t.identifier;
      touchControls.leftOriginX = x; touchControls.leftOriginY = y;
      touchControls.leftCurX    = x; touchControls.leftCurY    = y;
    } else if (x >= WW / 2 && touchControls.rightId === null) {
      touchControls.rightId = t.identifier;
      touchControls.rightOriginX = x; touchControls.rightOriginY = y;
      touchControls.rightCurX    = x; touchControls.rightCurY    = y;
    }
  }
}
function onTouchMove(e) {
  if (!touchControls.enabled) return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    const { x, y } = toCanvasCoords(t);
    if (t.identifier === touchControls.leftId) {
      touchControls.leftCurX = x; touchControls.leftCurY = y;
      const dx = x - touchControls.leftOriginX;
      const dy = y - touchControls.leftOriginY;
      const dead = JOYSTICK_SCREEN_DEAD / canvasScale;
      keys['KeyW'] = dy < -dead;
      keys['KeyS'] = dy >  dead;
      keys['KeyA'] = dx < -dead;
      keys['KeyD'] = dx >  dead;
    } else if (t.identifier === touchControls.rightId) {
      touchControls.rightCurX = x; touchControls.rightCurY = y;
      const dx = x - touchControls.rightOriginX;
      const dy = y - touchControls.rightOriginY;
      const dead = JOYSTICK_SCREEN_DEAD / canvasScale;
      const len = Math.hypot(dx, dy);
      if (len > dead) {
        const angle = Math.atan2(dy, dx);
        mouse.x = player.x + Math.cos(angle) * 800;
        mouse.y = player.y + Math.sin(angle) * 800;
        mouse.down = true;
      } else {
        mouse.down = false;
      }
    }
  }
}
function onTouchEnd(e) {
  if (!touchControls.enabled) return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === touchControls.leftId) {
      touchControls.leftId = null;
      keys['KeyW'] = keys['KeyS'] = keys['KeyA'] = keys['KeyD'] = false;
    }
    if (t.identifier === touchControls.rightId) {
      touchControls.rightId = null;
      mouse.down = false;
    }
  }
}
canvas.addEventListener('touchstart',  onTouchStart,  { passive: false });
canvas.addEventListener('touchmove',   onTouchMove,   { passive: false });
canvas.addEventListener('touchend',    onTouchEnd,    { passive: false });
canvas.addEventListener('touchcancel', onTouchEnd,    { passive: false });

window.addEventListener('keydown', e => {
  // Never intercept typing inside any text input (join screen, rename box, etc.)
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (renameInputEl && renameInputEl.style.display !== 'none') return;
  if (keys[e.code]) return;
  keys[e.code] = true;
  if (e.code.startsWith('Digit')) { const i = parseInt(e.key) - 1; if (i >= 0 && i < weapons.length) switchWeapon(i); }
  if (e.code === 'KeyR') startReload(player.weaponIndex);
  if (e.code === 'Space') tryRoll();
  if (e.code === 'Tab') { e.preventDefault(); toggleInventory(); }
  if (e.code === 'KeyF') toggleFactory();
  if (e.code === 'KeyV') losEnabled = !losEnabled;
  if (e.code === 'KeyX') dropDecoy();
  if (!['Tab', 'F5', 'F12'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  mouse.x = (e.clientX - r.left) * (WW / r.width);
  mouse.y = (e.clientY - r.top) * (WH / r.height);
});
canvas.addEventListener('mousedown', () => { mouse.down = true; mouse.justDown = true; });
canvas.addEventListener('mouseup', () => { mouse.down = false; mouse.justUp = true; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  switchWeapon((player.weaponIndex + (e.deltaY > 0 ? 1 : -1) + weapons.length) % weapons.length);
}, { passive: false });

// ── Weapon definitions ──────────────────────────
const WEAPONS = [
  {
    id: 'pistol', name: 'Pistol', color: '#ffe455', accent: '#bb8800',
    fireRate: 380, speed: 920, dmg: 35, count: 1, spread: 0, recoil: 5, shake: 2, bcol: '#ffe455', tcol: '#bb8800', brad: 4, maxAmmo: 12, reload: 1000, gw: 2, gh: 1,
    range: 900, dropoff: 0.35
  },
  {
    id: 'smg', name: 'SMG', color: '#ff9944', accent: '#cc5500',
    fireRate: 85, speed: 980, dmg: 12, count: 1, spread: 0.08, recoil: 3, shake: 1, bcol: '#ff9944', tcol: '#cc5500', brad: 3, maxAmmo: 30, reload: 1800, gw: 3, gh: 1,
    range: 580, dropoff: 0.65
  },
  {
    id: 'shotgun', name: 'Shotgun', color: '#ff5533', accent: '#aa2200',
    fireRate: 700, speed: 740, dmg: 22, count: 7, spread: 0.30, recoil: 18, shake: 8, bcol: '#ff8844', tcol: '#aa3300', brad: 3, maxAmmo: 6, reload: 2200, gw: 4, gh: 1,
    range: 320, dropoff: 0.88
  },
];
const weapons = WEAPONS.map(w => ({ ...w, ammo: w.maxAmmo, lastFired: 0, reloading: false }));

// ── Stat definitions (factory + creator) ────────
const STAT_DEFS = [
  { key: 'range',    label: 'Range',     fmt: w => `${Math.round(w.range/10)}m`,           barPct: w => w.range/2000,          fromPct: (w,p) => { w.range    = clamp(Math.round(p*2000),100,2000); },                                                col: '#44aaff' },
  { key: 'dmg',      label: 'Damage',    fmt: w => `${w.dmg}`,                              barPct: w => w.dmg/100,             fromPct: (w,p) => { w.dmg      = clamp(Math.round(p*100),1,100); },                                                   col: '#ff5533' },
  { key: 'fireRate', label: 'Fire Rate', fmt: w => `${Math.round(60000/w.fireRate)} RPM`,   barPct: w => 1-w.fireRate/2000,     fromPct: (w,p) => { w.fireRate = clamp(Math.round((1-p)*1950)+50,50,2000); },                                        col: '#ffaa33' },
  { key: 'spread',   label: 'Spread',    fmt: w => `${(w.spread*57.3).toFixed(1)}°`,        barPct: w => w.spread/0.8,          fromPct: (w,p) => { w.spread   = +clamp(p*0.8,0,0.8).toFixed(3); },                                                 col: '#bb88ff' },
  { key: 'dropoff',  label: 'Drop-off',  fmt: w => `${Math.round(w.dropoff*100)}%`,         barPct: w => w.dropoff,             fromPct: (w,p) => { w.dropoff  = +clamp(p,0,1).toFixed(2); },                                                       col: null      },
  { key: 'maxAmmo',  label: 'Magazine',  fmt: w => `${w.maxAmmo}`,                          barPct: w => w.maxAmmo/100,         fromPct: (w,p) => { w.maxAmmo  = clamp(Math.round(p*100),1,100); if(w.ammo!==undefined)w.ammo=w.maxAmmo; },         col: '#44cc88' },
];
const COLOR_PALETTE = [
  '#ffe455','#ff9944','#ff5533','#ee2266',
  '#cc44ff','#4488ff','#44ccff','#44dd88',
  '#aaff44','#ffdd33','#ffffff','#889aaa',
];

// ── Player ──────────────────────────────────────
const player = {
  x: WW / 2, y: 950, vx: 0, vy: 0,
  radius: 26, angle: 0, speed: 290, friction: 0.83,
  weaponIndex: 0, recoilOffset: 0,
  rolling: false, rollTimer: 0, rollDuration: 0.32,
  rollCooldown: 0, rollCooldownMax: 1.1,
  rollDx: 1, rollDy: 0, rollSpeed: 820,
  ghosts: [], credits: 0,
  hp: 100, maxHp: 100, invulnTimer: 0,
};

// ── LOS (Line-of-Sight) ──────────────────────────
let losEnabled = true;

// ── Weapon Factory ──────────────────────────────
let factoryOpen = false;
let creatorOpen = false;
let customWeaponCount = 0;
let sliderDrag = null; // { w, sd, trackX, trackW } – active slider drag state
const creatorWeapon = {
  id: '', name: 'Custom', shape: 'pistol', color: '#ff9944', accent: '#cc5500',
  fireRate: 380, speed: 920, dmg: 20, count: 1, spread: 0.05, recoil: 6, shake: 3,
  bcol: '#ff9944', tcol: '#cc5500', brad: 4, maxAmmo: 15, reload: 1400, gw: 2, gh: 1,
  range: 800, dropoff: 0.5, ammo: 15, lastFired: 0, reloading: false,
};

// ── Targets ─────────────────────────────────────
const movingTarget = {
  baseX: IR - 90, baseY: 960,
  x: IR - 90, y: 960,
  railHalfH: 100, tAcc: 0, speed: 0.7,
  w: 76, h: 96, hp: 100, maxHp: 100, hits: 0,
  flashTimer: 0, wobble: 0, alive: true,
};

// ── Decoy ────────────────────────────────────────
const decoy = { alive: false, x: 0, y: 0, radius: 20, hp: 60, maxHp: 60, flashTimer: 0, wobble: 0 };
function dropDecoy() {
  decoy.alive = true;
  decoy.x = player.x; decoy.y = player.y;
  decoy.hp = decoy.maxHp; decoy.flashTimer = 0; decoy.wobble = 0;
  spawnParticles(decoy.x, decoy.y, '#44ffcc', 10, 160, 0.35);
  if (ws && ws.readyState === 1)
    ws.send(JSON.stringify({ type: 'action', action: 'decoy' }));
}

// ── Weapon floor pickups ────────────────────────
const pickups = [
  { wi: 0, x: 215, y: 845,  pulse: 0 },
  { wi: 1, x: 215, y: 945,  pulse: 0 },
  { wi: 2, x: 215, y: 1050, pulse: 0 },
];

// ── Inventory ───────────────────────────────────
const COLS = 10, ROWS = 6, CELL = 52, IPAD = 18;

const INV = {
  open: false,
  // 2-D grid: null | item-id string
  grid: Array.from({ length: ROWS }, () => Array(COLS).fill(null)),
  items: {
    pistol: { def: WEAPONS[0], gx: 0, gy: 0, placed: false },
    smg: { def: WEAPONS[1], gx: 3, gy: 0, placed: false },
    shotgun: { def: WEAPONS[2], gx: 7, gy: 0, placed: false },
  },
  equip: [0, null, null],  // weapon indices or null
  drag: null,
};

function invPlace(id, gx, gy) {
  const { def } = INV.items[id];
  for (let r = gy; r < gy + def.gh; r++)
    for (let c = gx; c < gx + def.gw; c++)
      if (r < ROWS && c < COLS) INV.grid[r][c] = id;
  INV.items[id].gx = gx; INV.items[id].gy = gy; INV.items[id].placed = true;
}
function invRemove(id) {
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (INV.grid[r][c] === id) INV.grid[r][c] = null;
  INV.items[id].placed = false;
}
function invCanPlace(id, gx, gy) {
  const { def } = INV.items[id];
  for (let r = gy; r < gy + def.gh; r++)
    for (let c = gx; c < gx + def.gw; c++) {
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return false;
      const cell = INV.grid[r][c];
      if (cell !== null && cell !== id) return false;
    }
  return true;
}
(function invInit() {
  invPlace('pistol', 0, 0);
  invPlace('smg', 3, 0);
  invPlace('shotgun', 7, 0);
})();

function toggleInventory() {
  INV.open = !INV.open;
  if (INV.open) factoryOpen = false;
  if (!INV.open && INV.drag) {
    const { id, prevGx, prevGy } = INV.drag;
    if (invCanPlace(id, prevGx, prevGy)) invPlace(id, prevGx, prevGy);
    INV.drag = null;
  }
}
function toggleFactory() {
  factoryOpen = !factoryOpen;
  creatorOpen = false;
  sliderDrag = null;
  if (factoryOpen && INV.open) {
    if (INV.drag) {
      const { id, prevGx, prevGy } = INV.drag;
      if (invCanPlace(id, prevGx, prevGy)) invPlace(id, prevGx, prevGy);
      INV.drag = null;
    }
    INV.open = false;
  }
}
function toggleCreator() {
  creatorOpen = !creatorOpen;
  factoryOpen = false;
  sliderDrag = null;
}
function addCustomWeapon() {
  if (weapons.length >= 8) return;
  customWeaponCount++;
  const cw = creatorWeapon;
  weapons.push({
    id: `custom_${customWeaponCount}`, name: `Custom ${customWeaponCount}`,
    shape: cw.shape, color: cw.color, accent: cw.accent,
    fireRate: cw.fireRate, speed: cw.speed, dmg: cw.dmg, count: cw.count,
    spread: cw.spread, recoil: cw.recoil, shake: cw.shake,
    bcol: cw.color, tcol: cw.accent, brad: cw.brad,
    maxAmmo: cw.maxAmmo, reload: cw.reload, gw: 2, gh: 1,
    range: cw.range, dropoff: cw.dropoff,
    ammo: cw.maxAmmo, lastFired: 0, reloading: false,
  });
  creatorOpen = false; factoryOpen = true;
}

// ── Rename overlay ───────────────────────────────
let renameInputEl = null;
let renameWeapon  = null;
let renameOriginal = '';
function ensureRenameInput() {
  if (renameInputEl) return;
  const inp = document.createElement('input');
  inp.type = 'text'; inp.maxLength = 20;
  inp.style.cssText = 'position:fixed;background:#0a1a14;color:#44ff88;border:2px solid #44ff88;border-radius:4px;font:bold 13px Segoe UI,sans-serif;text-align:center;padding:2px 6px;outline:none;display:none;z-index:100;box-shadow:0 0 12px rgba(68,255,136,0.4);';
  document.body.appendChild(inp);
  inp.addEventListener('keydown', e => {
    if (e.code === 'Enter')  { commitRename(); }
    if (e.code === 'Escape') { renameInputEl.value = renameOriginal; commitRename(); }
    e.stopPropagation();
  });
  inp.addEventListener('blur', commitRename);
  renameInputEl = inp;
}
function openRename(weapon, cx, cy) {
  ensureRenameInput();
  renameWeapon   = weapon;
  renameOriginal = weapon.name;
  const rect = canvas.getBoundingClientRect();
  const sx = rect.left + cx * (rect.width  / WW);
  const sy = rect.top  + cy * (rect.height / WH);
  renameInputEl.value = weapon.name;
  renameInputEl.style.left  = (sx - 62) + 'px';
  renameInputEl.style.top   = (sy - 14) + 'px';
  renameInputEl.style.width = '124px';
  renameInputEl.style.display = 'block';
  setTimeout(() => { renameInputEl.select(); renameInputEl.focus(); }, 0);
}
function commitRename() {
  if (!renameWeapon) return;
  const v = renameInputEl.value.trim();
  if (v) renameWeapon.name = v;
  renameWeapon = null;
  renameInputEl.style.display = 'none';
}

// ── Networking ───────────────────────────────────
function connectToServer(name, color) {
  myPlayerColor = color;
  ws = new WebSocket(`ws://${location.hostname}:3000`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', name, color }));
  };

  ws.onmessage = e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'welcome') {
      myId = msg.id;
      // Snap local player to server's authoritative spawn position
      if (msg.x !== undefined) { player.x = msg.x; player.y = msg.y; player.vx = 0; player.vy = 0; }
    }
    if (msg.type === 'snapshot') {
      prevSnapshot   = serverSnapshot;
      serverSnapshot = msg;
      snapshotTime   = performance.now();
    }
    if (msg.type === 'died') {
      // Server respawned us — trigger local screen-flash feedback
      triggerShake(8, 0.25);
    }
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    const ov  = document.getElementById('joinOverlay');
    const box = document.getElementById('joinBox');
    box.innerHTML = `
      <h2>DISCONNECTED</h2>
      <p class="join-label" style="margin-top:18px">Lost connection to server</p>
      <button id="joinBtn" style="margin-top:28px" onclick="location.reload()">Reconnect</button>`;
    ov.style.display = 'flex';
  };
}

function sendInput() {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: 'input',
    keys: {
      KeyW: !!keys['KeyW'], KeyS: !!keys['KeyS'],
      KeyA: !!keys['KeyA'], KeyD: !!keys['KeyD'],
    },
    mouseAngle:  player.angle,
    weaponIndex: player.weaponIndex,
    // Send authoritative client position so server stays in sync
    x: player.x,
    y: player.y,
    rolling: player.rolling,
  }));
}

// ── Effects ─────────────────────────────────────
let bullets = [], enemyBullets = [], particles = [], flashes = [];
let shake = { x: 0, y: 0, str: 0, dur: 0, t: 0 };
function triggerShake(s, d) { shake.str = s; shake.dur = d; shake.t = 0; }

function spawnBullet(ox, oy, angle, w) {
  const sp = (Math.random() - 0.5) * w.spread * 2;
  const a = angle + sp;
  bullets.push({
    x: ox, y: oy, vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed,
    dmg: w.dmg, col: w.bcol, tcol: w.tcol, rad: w.brad, trail: [], alive: true, age: 0,
    dist: 0, range: w.range, dropoff: w.dropoff
  });
}
function spawnParticles(x, y, col, n, spd, life) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = (0.4 + Math.random() * 0.6) * spd;
    particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, maxLife: life,
      rad: 1.5 + Math.random() * 2.5, col, alive: true
    });
  }
}
function spawnFlash(x, y, angle, col) {
  flashes.push({ x, y, angle, col, life: 0.07, maxLife: 0.07 });
}

// ── Actions ─────────────────────────────────────
function shoot() {
  if (INV.open || player.rolling) return;
  const w = weapons[player.weaponIndex];
  const now = performance.now();
  if (now - w.lastFired < w.fireRate || w.ammo <= 0 || w.reloading) return;
  w.lastFired = now; w.ammo--;
  const mx = player.x + Math.cos(player.angle) * (player.radius + 16);
  const my = player.y + Math.sin(player.angle) * (player.radius + 16);
  for (let i = 0; i < w.count; i++) spawnBullet(mx, my, player.angle, w);
  spawnFlash(mx, my, player.angle, w.bcol);
  player.vx -= Math.cos(player.angle) * w.recoil;
  player.vy -= Math.sin(player.angle) * w.recoil;
  player.recoilOffset = w.recoil * 2.2;
  triggerShake(w.shake, 0.11);
  spawnParticles(mx, my, w.bcol, 3, 150, 0.12);
  if (w.ammo === 0) startReload(player.weaponIndex);
  updateHUD();
  // Notify server — include exact position & angle so bullet origin matches what the player sees
  if (ws && ws.readyState === 1)
    ws.send(JSON.stringify({ type: 'action', action: 'shoot', weapon: w, x: player.x, y: player.y, angle: player.angle }));
}
function startReload(i) {
  const w = weapons[i];
  if (w.reloading || w.ammo === w.maxAmmo) return;
  w.reloading = true;
  setTimeout(() => { w.ammo = w.maxAmmo; w.reloading = false; updateHUD(); }, w.reload);
}
function switchWeapon(i) {
  if (i === player.weaponIndex) return;
  player.weaponIndex = i; updateHUD();
}
function tryRoll() {
  if (INV.open || player.rolling || player.rollCooldown > 0) return;
  let dx = 0, dy = 0;
  if (keys['KeyW'] || keys['ArrowUp']) dy -= 1;
  if (keys['KeyS'] || keys['ArrowDown']) dy += 1;
  if (keys['KeyA'] || keys['ArrowLeft']) dx -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) dx += 1;
  if (dx === 0 && dy === 0) { dx = Math.cos(player.angle); dy = Math.sin(player.angle); }
  else { const l = Math.hypot(dx, dy); dx /= l; dy /= l; }
  player.rolling = true;
  player.rollTimer = player.rollDuration;
  player.rollCooldown = player.rollCooldownMax;
  player.rollDx = dx; player.rollDy = dy;
  player.ghosts = [];
  if (ws && ws.readyState === 1)
    ws.send(JSON.stringify({ type: 'action', action: 'roll' }));
}

function adjustWeaponStat(w, type, dir) {
  if (type === 'range')    w.range    = clamp(w.range + dir * 100, 100, 2000);
  if (type === 'dmg')      w.dmg      = clamp(w.dmg + dir * 5, 1, 100);
  if (type === 'fireRate') w.fireRate = clamp(w.fireRate - dir * 50, 50, 2000);
  if (type === 'spread')   w.spread   = clamp(+(w.spread + dir * 0.035).toFixed(3), 0, 0.8);
  if (type === 'dropoff')  w.dropoff  = clamp(+(w.dropoff - dir * 0.1).toFixed(2), 0, 1);
  if (type === 'maxAmmo')  { w.maxAmmo = clamp(w.maxAmmo + dir, 1, 100); if (w.ammo !== undefined) w.ammo = w.maxAmmo; }
  if (!creatorOpen) triggerShake(2, 0.08);
}

function hitTarget(tgt, b) {
  const hw = tgt.w / 2, hh = tgt.h / 2;
  if (b.x < tgt.x - hw || b.x > tgt.x + hw || b.y < tgt.y - hh || b.y > tgt.y + hh) return false;
  b.alive = false;
  const dropFactor = 1 - b.dropoff * Math.min(1, b.dist / b.range);
  const effectiveDmg = Math.max(1, Math.round(b.dmg * dropFactor));
  tgt.hp = clamp(tgt.hp - effectiveDmg, 0, tgt.maxHp);
  tgt.hits++; tgt.flashTimer = 0.14; tgt.wobble = 10;
  player.credits++;
  spawnParticles(b.x, b.y, '#ff4444', 7, 200, 0.3);
  if (tgt.hp <= 0) {
    spawnParticles(tgt.x, tgt.y, '#ff4444', 25, 280, 0.65);
    tgt.alive = false;
    setTimeout(() => { tgt.hp = tgt.maxHp; tgt.hits = 0; tgt.alive = true; }, 900);
  }
  return true;
}

function updateHUD() {
  ['pistol', 'smg', 'shotgun'].forEach((_, i) => {
    const w = weapons[i];
    const fill = document.getElementById(`ammo-${i}`);
    const slot = document.getElementById(`slot-${i}`);
    if (!fill || !slot) return;
    fill.style.width = (w.reloading ? 0 : w.ammo / w.maxAmmo) * 100 + '%';
    slot.classList.toggle('active', i === player.weaponIndex);
    slot.classList.toggle('low-ammo', !w.reloading && w.ammo <= Math.ceil(w.maxAmmo * 0.25));
  });
}

// ── Solid-rect collision helpers ─────────────────
function bulletHitsSolidRect(b) {
  for (const rect of solidRects) {
    if (b.x >= rect.x && b.x <= rect.x + rect.w && b.y >= rect.y && b.y <= rect.y + rect.h) {
      b.alive = false;
      spawnParticles(b.x, b.y, b.tcol || '#888888', 3, 100, 0.18);
      return true;
    }
  }
  return false;
}
function pushOutOfSolidRects(ent) {
  const r = ent.radius;
  for (const rect of solidRects) {
    const left = rect.x - r, right = rect.x + rect.w + r;
    const top = rect.y - r, bottom = rect.y + rect.h + r;
    if (ent.x < left || ent.x > right || ent.y < top || ent.y > bottom) continue;
    const ol = ent.x - left, or2 = right - ent.x;
    const ot = ent.y - top, ob = bottom - ent.y;
    const minPush = Math.min(ol, or2, ot, ob);
    if (minPush === ol)  { ent.x = left;   if (ent.vx > 0) ent.vx = 0; }
    else if (minPush === or2) { ent.x = right;  if (ent.vx < 0) ent.vx = 0; }
    else if (minPush === ot)  { ent.y = top;    if (ent.vy > 0) ent.vy = 0; }
    else                      { ent.y = bottom; if (ent.vy < 0) ent.vy = 0; }
  }
}

// ── Enemy logic ──────────────────────────────────
function spawnEnemyBullet(angle) {
  const e = enemy;
  const ox = e.x + Math.cos(angle) * (e.radius + 10);
  const oy = e.y + Math.sin(angle) * (e.radius + 10);
  enemyBullets.push({
    x: ox, y: oy, vx: Math.cos(angle) * e.bulletSpeed, vy: Math.sin(angle) * e.bulletSpeed,
    dmg: e.bulletDmg, col: '#ff3322', tcol: '#ff7755',
    rad: 5, trail: [], alive: true, age: 0,
    dist: 0, range: e.bulletRange, dropoff: 0.3, losAlpha: 0,
  });
  spawnFlash(ox, oy, angle, '#ff3322');
}
function updateEnemy(dt) {
  if (!enemy.alive) return;
  enemy.flashTimer = Math.max(0, enemy.flashTimer - dt);
  const now = performance.now();

  // Decoy takes priority: if visible, lock on to it
  const seeDecoy  = decoy.alive  && hasLOS(enemy.x, enemy.y, decoy.x,  decoy.y);
  const seePlayer = hasLOS(enemy.x, enemy.y, player.x, player.y);

  let targetX, targetY;
  if (seeDecoy)       { targetX = decoy.x;  targetY = decoy.y;  }
  else if (seePlayer) { targetX = player.x; targetY = player.y; }
  else return; // nothing in sight – don't fire or update angle

  enemy.angle = Math.atan2(targetY - enemy.y, targetX - enemy.x);
  if (now - enemy.lastFired >= enemy.fireRate) {
    enemy.lastFired = now;
    spawnEnemyBullet(enemy.angle);
  }
}
function updateEnemyBullets(dt) {
  for (const b of enemyBullets) {
    if (!b.alive) continue;
    const bv = !losEnabled || hasLOS(player.x, player.y, b.x, b.y);
    b.losAlpha = clamp(b.losAlpha + (bv ? 8 : -6) * dt, 0, 1);
    b.trail.push({ x: b.x, y: b.y });
    if (b.trail.length > 9) b.trail.shift();
    b.x += b.vx * dt; b.y += b.vy * dt; b.age += dt;
    b.dist += Math.hypot(b.vx, b.vy) * dt;
    if (b.dist >= b.range || b.x < IL || b.x > IR || b.y < IT || b.y > IB) { b.alive = false; continue; }
    if (bulletHitsSolidRect(b)) continue;
    // Decoy absorbs hits before the player
    if (b.alive && decoy.alive) {
      if (dist(b.x, b.y, decoy.x, decoy.y) < decoy.radius + b.rad) {
        b.alive = false;
        const dropFactor = 1 - b.dropoff * Math.min(1, b.dist / b.range);
        decoy.hp = clamp(decoy.hp - Math.max(1, Math.round(b.dmg * dropFactor)), 0, decoy.maxHp);
        decoy.flashTimer = 0.14; decoy.wobble = 10;
        spawnParticles(b.x, b.y, '#44ffcc', 6, 160, 0.28);
        if (decoy.hp <= 0) {
          decoy.alive = false;
          spawnParticles(decoy.x, decoy.y, '#44ffcc', 20, 240, 0.55);
        }
        continue;
      }
    }
    if (b.alive && player.invulnTimer <= 0 && !player.rolling) {
      if (dist(b.x, b.y, player.x, player.y) < player.radius + b.rad) {
        b.alive = false;
        const dropFactor = 1 - b.dropoff * Math.min(1, b.dist / b.range);
        player.hp = clamp(player.hp - Math.max(1, Math.round(b.dmg * dropFactor)), 0, player.maxHp);
        player.invulnTimer = 0.5;
        spawnParticles(b.x, b.y, '#ff4444', 8, 200, 0.35);
        triggerShake(6, 0.18);
        if (player.hp <= 0) respawnPlayer();
      }
    }
  }
  enemyBullets = enemyBullets.filter(b => b.alive);
}
function respawnPlayer() {
  player.hp = player.maxHp;
  player.x = WW / 2; player.y = 950;
  player.vx = 0; player.vy = 0;
  player.rolling = false;
  player.invulnTimer = 2.5;
  spawnParticles(player.x, player.y, '#44ff88', 20, 200, 0.6);
}

// ── UPDATE ──────────────────────────────────────
let lastTime = 0, gameTime = 0;
function update(ts) {
  const dt = Math.min((ts - lastTime) / 1000, 0.05);
  lastTime = ts;

  if (!INV.open && !factoryOpen && !creatorOpen) {
    gameTime += dt;
    if (player.invulnTimer > 0) player.invulnTimer = Math.max(0, player.invulnTimer - dt);
    player.angle = Math.atan2(mouse.y - player.y, mouse.x - player.x);

    // Roll
    if (player.rolling) {
      player.rollTimer -= dt;
      if (player.ghosts.length === 0 ||
        dist(player.x, player.y, player.ghosts[player.ghosts.length - 1].x, player.ghosts[player.ghosts.length - 1].y) > 14) {
        player.ghosts.push({ x: player.x, y: player.y, alpha: 0.5 });
      }
      const rollFrac = 1 - player.rollTimer / player.rollDuration;
      const vel = player.rollSpeed * (1 - rollFrac * rollFrac);
      player.vx = player.rollDx * vel;
      player.vy = player.rollDy * vel;
      if (player.rollTimer <= 0) { player.rolling = false; }
    } else {
      let dx = 0, dy = 0;
      if (keys['KeyW'] || keys['ArrowUp']) dy -= 1;
      if (keys['KeyS'] || keys['ArrowDown']) dy += 1;
      if (keys['KeyA'] || keys['ArrowLeft']) dx -= 1;
      if (keys['KeyD'] || keys['ArrowRight']) dx += 1;
      if (dx && dy) { dx *= 0.707; dy *= 0.707; }
      player.vx += dx * player.speed * dt * 13;
      player.vy += dy * player.speed * dt * 13;
      player.vx *= Math.pow(player.friction, dt * 60);
      player.vy *= Math.pow(player.friction, dt * 60);
    }

    player.ghosts = player.ghosts.filter(g => { g.alpha -= dt * (player.rolling ? 3 : 5); return g.alpha > 0; });
    if (player.rollCooldown > 0) player.rollCooldown = Math.max(0, player.rollCooldown - dt);
    player.x += player.vx * dt; player.y += player.vy * dt;
    player.x = clamp(player.x, IL + player.radius, IR - player.radius);
    player.y = clamp(player.y, IT + player.radius, IB - player.radius);
    pushOutOfSolidRects(player);
    player.recoilOffset = lerp(player.recoilOffset, 0, 1 - Math.pow(0.08, dt * 20));

    if (mouse.down) shoot();

    // Shake
    shake.t += dt;
    if (shake.t < shake.dur) {
      const s = shake.str * (1 - shake.t / shake.dur);
      shake.x = (Math.random() - 0.5) * s * 2;
      shake.y = (Math.random() - 0.5) * s * 2;
    } else { shake.x = shake.y = 0; }

    // Moving target
    movingTarget.tAcc += dt;
    movingTarget.y = movingTarget.baseY + Math.sin(movingTarget.tAcc * movingTarget.speed) * movingTarget.railHalfH;

    // Bullets
    for (const b of bullets) {
      if (!b.alive) continue;
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 9) b.trail.shift();
      b.x += b.vx * dt; b.y += b.vy * dt; b.age += dt;
      b.dist += Math.hypot(b.vx, b.vy) * dt;
      if (b.dist >= b.range || b.x < IL || b.x > IR || b.y < IT || b.y > IB) {
        if (b.x < IL || b.x > IR || b.y < IT || b.y > IB)
          spawnParticles(b.x, b.y, b.tcol, 3, 100, 0.18);
        b.alive = false;
      }
      if (b.alive) bulletHitsSolidRect(b);
      if (b.alive && movingTarget.alive) hitTarget(movingTarget, b);
      // Enemy hit: always check visually so bullet doesn't pass through
      if (b.alive && enemy.alive) {
        if (dist(b.x, b.y, enemy.x, enemy.y) < enemy.radius + b.rad) {
          b.alive = false;
          spawnParticles(b.x, b.y, '#ff4422', 7, 200, 0.3);
          if (!ws) {
            // Solo only: apply damage locally
            const dropFactor = 1 - b.dropoff * Math.min(1, b.dist / b.range);
            const dmg = Math.max(1, Math.round(b.dmg * dropFactor));
            enemy.hp = clamp(enemy.hp - dmg, 0, enemy.maxHp);
            enemy.flashTimer = 0.14;
            player.credits++;
            if (enemy.hp <= 0) {
              enemy.alive = false;
              spawnParticles(enemy.x, enemy.y, '#ff4422', 30, 300, 0.7);
              setTimeout(() => { enemy.hp = enemy.maxHp; enemy.alive = true; }, 4000);
            }
          }
        }
      }
    }
    bullets = bullets.filter(b => b.alive);

    // Particles
    for (const p of particles) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= Math.pow(0.87, dt * 60); p.vy *= Math.pow(0.87, dt * 60);
      p.life -= dt;
    }
    particles = particles.filter(p => p.life > 0);
    for (const f of flashes) f.life -= dt;
    flashes = flashes.filter(f => f.life > 0);

    for (const tgt of [movingTarget, decoy]) {
      tgt.flashTimer = Math.max(0, tgt.flashTimer - dt);
      tgt.wobble = lerp(tgt.wobble, 0, 1 - Math.pow(0.01, dt * 12));
    }

    // Send input to server (no-op in solo)
    sendInput();

    if (ws && serverSnapshot) {
      // ── Multiplayer: apply authoritative server state ──────────────

      // Enemy
      const es = serverSnapshot.enemy;
      if (es) {
        enemy.x = es.x; enemy.y = es.y;
        enemy.hp = es.hp; enemy.maxHp = es.maxHp;
        enemy.alive = es.alive; enemy.angle = es.angle;
        enemy.flashTimer = es.flashTimer || 0;
      }

      // Local player HP (detect damage for hit feedback)
      const myState = serverSnapshot.players.find(p => p.id === myId);
      if (myState && myState.hp < player.hp) {
        triggerShake(6, 0.18);
        spawnParticles(player.x, player.y, '#ff4444', 8, 200, 0.35);
      }
      if (myState) {
        player.hp = myState.hp;
        // Sync our decoy state from server (keeps HP bar and alive flag accurate)
        if (myState.decoy) {
          decoy.alive = true;
          decoy.x = myState.decoy.x; decoy.y = myState.decoy.y;
          decoy.hp = myState.decoy.hp; decoy.maxHp = myState.decoy.maxHp;
          decoy.flashTimer = myState.decoy.flashTimer;
        } else {
          decoy.alive = false;
        }
      }

      // Track enemy firing so the hidden-flash hint works correctly
      if (es && es.flashTimer > 0) enemyLastSeenFire = performance.now();

      // Smooth remote enemy visibility (computed from local player position)
      const eVis = !losEnabled || (es && hasLOS(player.x, player.y, es.x, es.y));
      remoteEnemyLosAlpha = clamp(remoteEnemyLosAlpha + (eVis ? 3.5 : -2.5) * dt, 0, 1);

      // Smooth LOS alpha for each remote player (POV rule)
      const activeRemoteIds = new Set();
      for (const rp of serverSnapshot.players) {
        if (rp.id === myId) continue;
        activeRemoteIds.add(rp.id);
        const prev = remotePlayerLosAlpha.get(rp.id) ?? 0;
        const vis = !losEnabled || hasLOS(player.x, player.y, rp.x, rp.y);
        remotePlayerLosAlpha.set(rp.id, clamp(prev + (vis ? 3.5 : -2.5) * dt, 0, 1));
      }
      for (const id of remotePlayerLosAlpha.keys()) {
        if (!activeRemoteIds.has(id)) remotePlayerLosAlpha.delete(id);
      }

      // Smooth per-bullet visibility for enemy bullets
      const activeBulletIds = new Set();
      for (const b of serverSnapshot.enemyBullets || []) {
        activeBulletIds.add(b.id);
        const prev = bulletLosAlpha.get(b.id) ?? 0;
        const bVis = !losEnabled || hasLOS(player.x, player.y, b.x, b.y);
        bulletLosAlpha.set(b.id, clamp(prev + (bVis ? 8 : -6) * dt, 0, 1));
      }
      for (const id of bulletLosAlpha.keys()) {
        if (!activeBulletIds.has(id)) bulletLosAlpha.delete(id);
      }

      // Smooth per-bullet visibility for other players' bullets + hidden-fire detection
      const activePlayerBulletIds = new Set();
      for (const b of serverSnapshot.bullets || []) {
        if (b.ownerId === myId) continue;
        activePlayerBulletIds.add(b.id);
        if (!playerBulletLosAlpha.has(b.id)) {
          // New bullet: check if owner is out of sight and record fire time
          const ownerAlpha = remotePlayerLosAlpha.get(b.ownerId) ?? 0;
          if (ownerAlpha < 0.3) remotePlayerLastFired.set(b.ownerId, performance.now());
          playerBulletLosAlpha.set(b.id, 0);
        }
        const prev = playerBulletLosAlpha.get(b.id);
        const bVis = !losEnabled || hasLOS(player.x, player.y, b.x, b.y);
        playerBulletLosAlpha.set(b.id, clamp(prev + (bVis ? 8 : -6) * dt, 0, 1));
      }
      for (const id of playerBulletLosAlpha.keys()) {
        if (!activePlayerBulletIds.has(id)) playerBulletLosAlpha.delete(id);
      }

    } else {
      // ── Solo: run local enemy simulation ──────────────────────────
      updateEnemy(dt);
      updateEnemyBullets(dt);
      // Smooth enemy visibility fade
      const visible = !losEnabled || hasLOS(player.x, player.y, enemy.x, enemy.y);
      enemy.losAlpha = clamp(enemy.losAlpha + (visible ? 3.5 : -2.5) * dt, 0, 1);
    }

    for (const p of pickups) {
      p.pulse = (p.pulse + dt * 2.5) % (Math.PI * 2);
      if (dist(player.x, player.y, p.x, p.y) < player.radius + 30 && p.wi !== player.weaponIndex)
        switchWeapon(p.wi);
    }

    // Roll cooldown HUD
    const rf = document.getElementById('roll-fill');
    const rs = document.getElementById('roll-slot');
    if (rf) rf.style.width = (1 - player.rollCooldown / player.rollCooldownMax) * 100 + '%';
    if (rs) rs.classList.toggle('active', player.rollCooldown === 0 && !player.rolling);
  }

  // Overlay mouse (always runs)
  handleInventoryMouse();
  handleFactoryMouse();
  handleCreatorMouse();
  mouse.justDown = false; mouse.justUp = false;
}

// ── Inventory mouse logic ───────────────────────
function invLayout() {
  const panW = COLS * CELL + IPAD * 2;
  const panH = ROWS * CELL + IPAD * 2 + 50;
  const panX = (WW - panW) / 2;
  const panY = (WH - panH) / 2;
  const gx = panX + IPAD;
  const gy = panY + 50;
  return { panX, panY, panW, panH, gx, gy };
}
function cellAt(mx, my) {
  const { gx, gy } = invLayout();
  const c = Math.floor((mx - gx) / CELL);
  const r = Math.floor((my - gy) / CELL);
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return null;
  return { c, r };
}

function handleInventoryMouse() {
  if (!INV.open) return;
  const mx = mouse.x, my = mouse.y;
  if (mouse.justDown) {
    const cell = cellAt(mx, my);
    if (cell) {
      const id = INV.grid[cell.r][cell.c];
      if (id) {
        const item = INV.items[id];
        INV.drag = { id, ocx: cell.c - item.gx, ocy: cell.r - item.gy, prevGx: item.gx, prevGy: item.gy };
        invRemove(id);
      }
    }
  }
  if (mouse.justUp && INV.drag) {
    const { id, ocx, ocy, prevGx, prevGy } = INV.drag;
    const cell = cellAt(mx, my);
    let ok = false;
    if (cell) {
      const tgx = cell.c - ocx, tgy = cell.r - ocy;
      if (invCanPlace(id, tgx, tgy)) { invPlace(id, tgx, tgy); ok = true; }
    }
    if (!ok && invCanPlace(id, prevGx, prevGy)) invPlace(id, prevGx, prevGy);
    INV.drag = null;
  }
}

// ── Factory mouse logic ─────────────────────────
const FCOL_W = 280; // fixed column width
function factoryLayout() {
  const n = Math.min(weapons.length, 5);
  const panW = 40 + n * FCOL_W, panH = 490;
  const panX = (WW - panW) / 2, panY = (WH - panH) / 2;
  const colY = panY + 58;
  return { panX, panY, panW, panH, colW: FCOL_W, colY, n };
}
function handleFactoryMouse() {
  if (!factoryOpen) return;
  const { panX, panY, panW, panH, colY, n } = factoryLayout();
  const mx = mouse.x, my = mouse.y;

  // Continue active slider drag while mouse held
  if (sliderDrag && mouse.down) {
    sliderDrag.sd.fromPct(sliderDrag.w, (mx - sliderDrag.trackX) / sliderDrag.trackW);
    return;
  }
  if (!mouse.down) sliderDrag = null;
  if (!mouse.justDown) return;

  // "New Weapon" button
  const nbX = panX + (panW - 160) / 2, nbY = panY + panH - 44;
  if (mx >= nbX && mx <= nbX + 160 && my >= nbY && my <= nbY + 30) {
    toggleCreator(); return;
  }

  // Weapon name click-to-rename
  for (let wi = 0; wi < n; wi++) {
    const ncx = panX + 20 + wi * FCOL_W;
    if (mx >= ncx + 20 && mx <= ncx + FCOL_W - 20 && my >= colY + 48 && my <= colY + 68) {
      openRename(weapons[wi], ncx + FCOL_W / 2, colY + 60); return;
    }
  }

  // Stat sliders – each drawn at sy = colY + 68 + si*48, track at sy+20
  for (let wi = 0; wi < n; wi++) {
    const barX = panX + 20 + wi * FCOL_W + 14;
    const barW = FCOL_W - 28;
    for (let si = 0; si < STAT_DEFS.length; si++) {
      const sy = colY + 68 + si * 48;
      if (my >= sy + 10 && my <= sy + 34 && mx >= barX && mx <= barX + barW) {
        sliderDrag = { w: weapons[wi], sd: STAT_DEFS[si], trackX: barX, trackW: barW };
        STAT_DEFS[si].fromPct(weapons[wi], (mx - barX) / barW);
        return;
      }
    }
  }
}

// ── Creator layout + mouse ──────────────────────
function creatorLayout() {
  const panW = 660, panH = 590;
  const panX = (WW - panW) / 2, panY = (WH - panH) / 2;
  const sec1Y = panY + 56;   // preview + shape
  const sec2Y = sec1Y + 124; // color palettes
  const sec3Y = sec2Y + 74;  // stats
  return { panX, panY, panW, panH, sec1Y, sec2Y, sec3Y };
}
function handleCreatorMouse() {
  if (!creatorOpen) return;
  const { panX, panY, panW, panH, sec1Y, sec2Y, sec3Y } = creatorLayout();
  const mx = mouse.x, my = mouse.y;
  const cw = creatorWeapon;

  // Continue active slider drag while mouse held
  if (sliderDrag && mouse.down) {
    sliderDrag.sd.fromPct(sliderDrag.w, (mx - sliderDrag.trackX) / sliderDrag.trackW);
    return;
  }
  if (!mouse.down) sliderDrag = null;
  if (!mouse.justDown) return;

  const SS = 24;
  // Name click-to-rename (preview label)
  if (mx >= panX + 50 && mx <= panX + 175 && my >= sec1Y + 87 && my <= sec1Y + 106) {
    openRename(creatorWeapon, panX + 113, sec1Y + 100); return;
  }
  // Shape buttons
  ['pistol','smg','shotgun'].forEach((sh, i) => {
    const bx = panX + 230, by = sec1Y + 32 + i * 28;
    if (mx >= bx && mx <= bx + 180 && my >= by && my <= by + 22) cw.shape = sh;
  });
  // Primary color swatches
  COLOR_PALETTE.forEach((col, i) => {
    const sx = panX + 90 + i * (SS + 3), sy = sec2Y + 4;
    if (mx >= sx && mx <= sx + SS && my >= sy && my <= sy + SS) { cw.color = col; cw.bcol = col; }
  });
  // Accent color swatches
  COLOR_PALETTE.forEach((col, i) => {
    const sx = panX + 90 + i * (SS + 3), sy = sec2Y + 40;
    if (mx >= sx && mx <= sx + SS && my >= sy && my <= sy + SS) { cw.accent = col; cw.tcol = col; }
  });
  // Stat sliders – each drawn at sy = sec3Y + si*44, track at sy+20
  const barX = panX + 20, barW = panW - 40;
  for (let si = 0; si < STAT_DEFS.length; si++) {
    const sy = sec3Y + si * 44;
    if (my >= sy + 10 && my <= sy + 34 && mx >= barX && mx <= barX + barW) {
      sliderDrag = { w: cw, sd: STAT_DEFS[si], trackX: barX, trackW: barW };
      STAT_DEFS[si].fromPct(cw, (mx - barX) / barW);
      return;
    }
  }
  // Add to Arsenal button
  const addY = sec3Y + STAT_DEFS.length * 44 + 14;
  if (mx >= panX + panW / 2 - 120 && mx <= panX + panW / 2 + 120 && my >= addY && my <= addY + 36)
    addCustomWeapon();
}

// ── LOS helpers ──────────────────────────────────
// Liang-Barsky line-rect clipping: returns true if segment (ax,ay)→(bx,by)
// passes through the filled rectangle.
function segmentIntersectsRect(ax, ay, bx, by, rect) {
  const dx = bx - ax, dy = by - ay;
  const { x, y, w, h } = rect;
  let tMin = 0, tMax = 1;
  // [p, q] pairs for left / right / top / bottom boundaries
  const tests = [
    [-dx, ax - x],
    [ dx, x + w - ax],
    [-dy, ay - y],
    [ dy, y + h - ay],
  ];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-10) {
      if (q < 0) return false; // parallel and outside
    } else {
      const t = q / p;
      if (p < 0) { if (t > tMin) tMin = t; }
      else        { if (t < tMax) tMax = t; }
    }
    if (tMin >= tMax) return false;
  }
  return true; // segment clips through the rect
}
// Returns true if the straight line from (x1,y1) to (x2,y2) is not blocked
// by any solid rect (walls + cover blocks).
function hasLOS(x1, y1, x2, y2) {
  for (const rect of solidRects) {
    if (segmentIntersectsRect(x1, y1, x2, y2, rect)) return false;
  }
  return true;
}

// ────────────────────────────────────────────────
//  DRAWING
// ────────────────────────────────────────────────

// ── Floor pattern ───────────────────────────────
let floorPat = null;
function makeFloor() {
  const tc = document.createElement('canvas');
  tc.width = TILE; tc.height = TILE;
  const t = tc.getContext('2d');
  t.fillStyle = '#263323'; t.fillRect(0, 0, TILE, TILE);
  t.strokeStyle = 'rgba(0,0,0,0.2)'; t.lineWidth = 1;
  t.strokeRect(0.5, 0.5, TILE - 1, TILE - 1);
  t.fillStyle = 'rgba(255,255,255,0.018)';
  for (let i = 0; i < 4; i++)
    t.fillRect(Math.random() * TILE, Math.random() * TILE, 3 + Math.random() * 5, 2 + Math.random() * 5);
  floorPat = ctx.createPattern(tc, 'repeat');
}

// ── Weapon shape ────────────────────────────────
function drawWeaponShape(cx, cy, w, h, weaponOrId) {
  const def = (typeof weaponOrId === 'string') ? WEAPONS.find(x => x.id === weaponOrId) : weaponOrId;
  if (!def) return;
  const id = def.shape || def.id;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
  if (id === 'pistol') {
    ctx.fillStyle = def.color;
    ctx.beginPath(); ctx.roundRect(-w * 0.22, -h * 0.36, w * 0.78, h * 0.44, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.accent;
    ctx.beginPath(); ctx.roundRect(-w * 0.18, h * 0.05, w * 0.3, h * 0.44, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.accent;
    ctx.beginPath(); ctx.roundRect(w * 0.28, -h * 0.28, w * 0.22, h * 0.26, 2); ctx.fill(); ctx.stroke();
  } else if (id === 'smg') {
    ctx.fillStyle = def.color;
    ctx.beginPath(); ctx.roundRect(-w * 0.25, -h * 0.28, w * 0.9, h * 0.38, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.accent;
    ctx.beginPath(); ctx.roundRect(-w * 0.08, h * 0.08, w * 0.22, h * 0.46, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.accent;
    ctx.beginPath(); ctx.roundRect(-w * 0.27, -h * 0.2, w * 0.12, h * 0.25, 3); ctx.fill(); ctx.stroke();
  } else {
    ctx.fillStyle = def.color;
    ctx.beginPath(); ctx.roundRect(-w * 0.25, -h * 0.42, w * 0.98, h * 0.32, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.accent;
    ctx.beginPath(); ctx.roundRect(-w * 0.25, -h * 0.05, w * 0.98, h * 0.32, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7a3e0a';
    ctx.beginPath(); ctx.roundRect(-w * 0.28, -h * 0.14, w * 0.18, h * 0.54, 4); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

// ── Blob body (no rotation – symmetric) ─────────
function drawBlobBody(x, y, r, sx, sy, col) {
  // col defaults to classic green; pass a hex colour for tinted blobs
  const midCol  = col || '#55cc22';
  const hiCol   = col ? lightenHex(col, 0.45) : '#c8ff55';
  const loCol   = col ? darkenHex(col, 0.38)  : '#1f8010';
  const rimCol  = col ? darkenHex(col, 0.25)  : '#165010';

  ctx.save(); ctx.translate(x, y); ctx.scale(sx, sy);

  // drop shadow
  ctx.save(); ctx.globalAlpha = 0.28; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(4, r * 0.72, r * 0.78, r * 0.26, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();

  // dark rim
  ctx.fillStyle = rimCol;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();

  // main gradient
  const g = ctx.createRadialGradient(-r * 0.28, -r * 0.28, r * 0.04, 0, 0, r * 0.96);
  g.addColorStop(0, hiCol); g.addColorStop(0.46, midCol); g.addColorStop(1, loCol);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.96, 0, Math.PI * 2); ctx.fill();

  // gloss
  ctx.save(); ctx.globalAlpha = 0.55;
  const gl = ctx.createRadialGradient(-r * 0.3, -r * 0.32, 0, -r * 0.2, -r * 0.2, r * 0.52);
  gl.addColorStop(0, 'rgba(255,255,255,0.9)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl;
  ctx.beginPath(); ctx.ellipse(-r * 0.14, -r * 0.17, r * 0.44, r * 0.33, -0.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // eyes
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.2, r * 0.14, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(r * 0.3, -r * 0.2, r * 0.14, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'white';
  ctx.beginPath(); ctx.arc(-r * 0.25, -r * 0.25, r * 0.055, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(r * 0.35, -r * 0.25, r * 0.055, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ── Target shape ─────────────────────────────────
function drawTarget(tgt) {
  if (!tgt.alive) return;
  ctx.save();
  ctx.translate(tgt.x, tgt.y);
  ctx.rotate(Math.sin(performance.now() / 40) * tgt.wobble * 0.018);
  const r = tgt.w / 2, sh = tgt.h - tgt.w;

  // shadow
  ctx.save(); ctx.globalAlpha = 0.22; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(0, r + sh + 6, r * 0.5, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  // pole
  ctx.fillStyle = '#7a5a10'; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(-5, r, 10, sh, 2); ctx.fill(); ctx.stroke();
  // base
  ctx.fillStyle = '#5a4208';
  ctx.beginPath(); ctx.roundRect(-20, r + sh - 7, 40, 13, 3); ctx.fill(); ctx.stroke();

  if (tgt.flashTimer > 0) ctx.filter = 'brightness(2.8)';
  // rings
  const RC = ['#fff', '#111', '#1155dd', '#ff2200', '#ff2200', '#111'];
  for (let i = RC.length - 1; i >= 0; i--) {
    ctx.fillStyle = RC[i];
    ctx.beginPath(); ctx.arc(0, 0, r * ((i + 1) / RC.length), 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#ff0000';
  ctx.beginPath(); ctx.arc(0, 0, r * 0.11, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 0.8;
  for (let i = 1; i < RC.length; i++) { ctx.beginPath(); ctx.arc(0, 0, r * (i / RC.length), 0, Math.PI * 2); ctx.stroke(); }
  ctx.filter = 'none';

  // HP bar
  const pct = tgt.hp / tgt.maxHp;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath(); ctx.roundRect(-r, -r - 18, r * 2, 7, 3); ctx.fill();
  ctx.fillStyle = `hsl(${pct * 110},80%,50%)`;
  ctx.beginPath(); ctx.roundRect(-r, -r - 18, r * 2 * pct, 7, 3); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = 'bold 11px Segoe UI, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`Hits: ${tgt.hits}`, 0, -r - 26);
  ctx.restore();
}

// ── Moving target rail (vertical) ────────────────
function drawRail() {
  const mt = movingTarget;
  const x = mt.baseX, y1 = mt.baseY - mt.railHalfH - 18, y2 = mt.baseY + mt.railHalfH + 18;
  ctx.save();
  ctx.fillStyle = '#4a5a6a'; ctx.strokeStyle = '#2a3a4a'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(x - 4, y1, 8, y2 - y1, 3); ctx.fill(); ctx.stroke();
  ctx.globalAlpha = 0.3; ctx.fillStyle = '#aaccdd';
  ctx.beginPath(); ctx.roundRect(x - 2, y1 + 4, 3, y2 - y1 - 8, 2); ctx.fill();
  ctx.restore();
}

// ── Player ───────────────────────────────────────
function drawPlayer() {
  const r = player.radius;
  // ghost trail
  for (const g of player.ghosts) {
    ctx.save(); ctx.globalAlpha = g.alpha * 0.4;
    const gg = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, r * 1.1);
    gg.addColorStop(0, '#88ff44'); gg.addColorStop(1, 'rgba(40,200,0,0)');
    ctx.fillStyle = gg;
    ctx.beginPath(); ctx.arc(g.x, g.y, r * 1.1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // squash during roll
  let sx = 1, sy = 1;
  if (player.rolling) {
    const p = 1 - player.rollTimer / player.rollDuration;
    const f = Math.sin(p * Math.PI);
    sx = 1 + f * 0.38; sy = 1 - f * 0.22;
  }
  drawBlobBody(player.x, player.y, r, sx, sy, myPlayerColor);

  if (!player.rolling) {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.angle);
    ctx.translate(-player.recoilOffset * 0.55, 0);
    // arm knob
    const ag = ctx.createRadialGradient(r * 0.62, 0, 2, r * 0.62, 0, r * 0.4);
    ag.addColorStop(0, '#88ee44'); ag.addColorStop(1, '#22660e');
    ctx.fillStyle = ag; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(r * 0.72, 0, r * 0.4, r * 0.25, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // weapon
    drawWeaponShape(r * 0.85 + 23, 0, 46, 22, weapons[player.weaponIndex]);
    ctx.restore();
  }

  // Roll cooldown arc
  if (player.rollCooldown > 0 || player.rolling) {
    const pct = 1 - player.rollCooldown / player.rollCooldownMax;
    ctx.save(); ctx.translate(player.x, player.y + r + 11);
    ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.arc(0, 0, 8, -Math.PI / 2, Math.PI * 1.5); ctx.stroke();
    ctx.strokeStyle = '#44aaff';
    ctx.beginPath(); ctx.arc(0, 0, 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct); ctx.stroke();
    ctx.restore();
  }
}

// ── Pickups ──────────────────────────────────────
function drawPickups() {
  for (const p of pickups) {
    const w = WEAPONS[p.wi];
    const pulse = Math.sin(p.pulse) * 0.12 + 0.88;
    const active = player.weaponIndex === p.wi;
    const r = 30;
    ctx.save(); ctx.translate(p.x, p.y);
    // glow
    ctx.save(); ctx.globalAlpha = 0.18 + Math.sin(p.pulse) * 0.07;
    ctx.strokeStyle = w.color; ctx.lineWidth = 3;
    ctx.shadowColor = w.color; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(0, 0, r + 5, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    // disc
    ctx.fillStyle = active ? w.color + '33' : 'rgba(18,28,18,0.85)';
    ctx.strokeStyle = w.color; ctx.lineWidth = 2;
    ctx.shadowColor = w.color; ctx.shadowBlur = active ? 16 : 5;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0; ctx.scale(pulse, pulse);
    drawWeaponShape(0, 0, 38, 18, w.id);
    ctx.restore();
    ctx.fillStyle = active ? w.color : 'rgba(255,255,255,0.5)';
    ctx.font = `bold ${active ? 13 : 11}px Segoe UI,sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(w.name, p.x, p.y + r + 17);
    ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.font = '10px Segoe UI,sans-serif';
    ctx.fillText(active ? '✓ active' : 'walk near', p.x, p.y + r + 30);
  }
}

// ── Bullets & FX ─────────────────────────────────
function drawBullets() {
  for (const b of bullets) {
    const tl = b.trail.length;
    for (let i = 0; i < tl; i++) {
      const t = b.trail[i]; const a = (i / tl) * 0.45;
      ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = b.tcol;
      ctx.beginPath(); ctx.arc(t.x, t.y, b.rad * (i / tl) * 0.7, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    ctx.save(); ctx.shadowColor = b.col; ctx.shadowBlur = 12; ctx.fillStyle = b.col;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.rad, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}
function drawParticles() {
  for (const p of particles) {
    const a = p.life / p.maxLife;
    ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = p.col;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.rad * a, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}
function drawFlashes() {
  for (const f of flashes) {
    const a = f.life / f.maxLife;
    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.angle); ctx.globalAlpha = a;
    ctx.shadowColor = f.col; ctx.shadowBlur = 20;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(12, 0, 20, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = f.col; ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// ── Room ─────────────────────────────────────────
function drawRoom() {
  ctx.fillStyle = '#0c1618'; ctx.fillRect(0, 0, WW, WH);
  ctx.fillStyle = floorPat || '#263323';
  ctx.fillRect(IL, IT, IR - IL, IB - IT);
  // Combat zone tint (top room)
  const combatGrad = ctx.createLinearGradient(0, IT, 0, DIVIDER_Y);
  combatGrad.addColorStop(0, 'rgba(100,10,10,0.22)');
  combatGrad.addColorStop(0.6, 'rgba(80,10,10,0.10)');
  combatGrad.addColorStop(1, 'rgba(60,10,10,0.03)');
  ctx.fillStyle = combatGrad;
  ctx.fillRect(IL, IT, IR - IL, DIVIDER_Y - IT);
  // shadow vignette from walls
  for (const [x1, y1, x2, y2] of [[IL, IT, IL + 50, IT], [IR, IT, IR - 50, IT], [IL, IT, IL, IT + 50], [IL, IB, IL, IB - 50]]) {
    const g = ctx.createLinearGradient(x1, y1, x2, y2);
    g.addColorStop(0, 'rgba(0,0,0,0.36)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(IL, IT, IR - IL, IB - IT);
  }
  // walls
  ctx.fillStyle = '#1c3248'; ctx.fillRect(0, 0, WW, IT);
  ctx.fillStyle = '#2a4860'; ctx.fillRect(0, IT - 7, WW, 7);
  ctx.fillStyle = '#131e28'; ctx.fillRect(0, IB, WW, WH - IB);
  ctx.fillStyle = '#223045'; ctx.fillRect(0, IB, WW, 7);
  ctx.fillStyle = '#182a3c'; ctx.fillRect(0, 0, IL, WH);
  ctx.fillStyle = '#254055'; ctx.fillRect(IL - 6, 0, 6, WH);
  ctx.fillStyle = '#141e2c'; ctx.fillRect(IR, 0, WW - IR, WH);
  ctx.fillStyle = '#202d42'; ctx.fillRect(IR, 0, 6, WH);
  // pillars
  const P = 20; ctx.fillStyle = '#385065';
  [[IL - 2, IT - 2], [IR - P + 2, IT - 2], [IL - 2, IB - P + 2], [IR - P + 2, IB - P + 2]].forEach(([px, py]) => ctx.fillRect(px, py, P, P));
  // guide lines
  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1; ctx.setLineDash([8, 12]);
  ctx.beginPath(); ctx.moveTo(IL + 20, WH / 2); ctx.lineTo(IR - 20, WH / 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(WW / 2, IT + 20); ctx.lineTo(WW / 2, IB - 20); ctx.stroke();
  ctx.setLineDash([]); ctx.restore();
}

// ── Inventory ────────────────────────────────────
function drawInventory() {
  if (!INV.open) return;
  const { panX, panY, panW, panH, gx, gy } = invLayout();
  // dim
  ctx.fillStyle = 'rgba(0,0,0,0.74)'; ctx.fillRect(0, 0, WW, WH);
  // panel
  ctx.fillStyle = '#141c22'; ctx.strokeStyle = '#263545'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(panX, panY, panW, panH, 10); ctx.fill(); ctx.stroke();
  // title bar
  ctx.fillStyle = '#1c2c38';
  ctx.beginPath(); ctx.roundRect(panX, panY, panW, 46, [10, 10, 0, 0]); ctx.fill();
  ctx.fillStyle = '#44aacc'; ctx.font = 'bold 17px Segoe UI,sans-serif';
  ctx.textAlign = 'left'; ctx.fillText('⚙  INVENTORY', panX + 16, panY + 29);
  ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.font = '12px Segoe UI,sans-serif';
  ctx.textAlign = 'right'; ctx.fillText('TAB to close', panX + panW - 14, panY + 29);

  // grid cells
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cx = gx + c * CELL, cy = gy + r * CELL;
      ctx.fillStyle = INV.grid[r][c] ? 'rgba(50,80,50,0.28)' : 'rgba(255,255,255,0.03)';
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.rect(cx, cy, CELL, CELL); ctx.fill(); ctx.stroke();
    }
  }
  // coord labels (col numbers tiny)
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.font = '9px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  for (let c = 0; c < COLS; c++) ctx.fillText(c + 1, gx + c * CELL + CELL / 2, gy - 5);

  // placed items
  for (const [id, item] of Object.entries(INV.items)) {
    if (!item.placed) continue;
    const def = item.def;
    const ix = gx + item.gx * CELL + 2, iy = gy + item.gy * CELL + 2;
    const iw = def.gw * CELL - 4, ih = def.gh * CELL - 4;
    ctx.fillStyle = def.color + '33'; ctx.strokeStyle = def.color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(ix, iy, iw, ih, 4); ctx.fill(); ctx.stroke();
    drawWeaponShape(ix + iw / 2, iy + ih / 2, iw * 0.75, ih * 0.75, id);
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = 'bold 10px Segoe UI,sans-serif';
    ctx.textAlign = 'left'; ctx.fillText(def.name, ix + 4, iy + ih - 5);
    // equip indicator
    const eqIdx = INV.equip.indexOf(WEAPONS.findIndex(w => w.id === id));
    if (eqIdx >= 0) {
      ctx.fillStyle = def.color; ctx.font = 'bold 9px Segoe UI,sans-serif';
      ctx.textAlign = 'right'; ctx.fillText('EQ', ix + iw - 4, iy + 12);
    }
  }

  // dragged item follows cursor
  if (INV.drag) {
    const { id } = INV.drag;
    const def = INV.items[id].def;
    const dw = def.gw * CELL - 4, dh = def.gh * CELL - 4;
    const dx2 = mouse.x - dw / 2, dy2 = mouse.y - dh / 2;
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = def.color + '44'; ctx.strokeStyle = def.color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(dx2, dy2, dw, dh, 4); ctx.fill(); ctx.stroke();
    drawWeaponShape(dx2 + dw / 2, dy2 + dh / 2, dw * 0.75, dh * 0.75, id);
    ctx.globalAlpha = 1;
  }
}

// ── HUD controls hint ────────────────────────────
function drawControlsHint() {
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.font = '12px Segoe UI,sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('WASD: Move  •  Click: Shoot  •  1-8: Weapon  •  R: Reload  •  Space: Roll  •  X: Decoy  •  Tab: Inventory  •  F: Factory  •  V: LOS',
    IL + 14, IT + 22);
}

// ── LOS badge (drawn outside shake transform) ────
function drawLOSBadge() {
  const bx = IR - 10, by = IT + 10;
  const w = 110, h = 34;
  const on = losEnabled;

  ctx.save();
  // Panel
  ctx.fillStyle = on ? 'rgba(20,40,20,0.88)' : 'rgba(40,20,20,0.88)';
  ctx.strokeStyle = on ? '#44ff88' : '#ff4422';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(bx - w, by, w, h, 6); ctx.fill(); ctx.stroke();

  // Icon (eye shape)
  const ix = bx - w + 20, iy = by + h / 2;
  ctx.strokeStyle = on ? '#44ff88' : '#ff4422'; ctx.lineWidth = 1.8; ctx.fillStyle = on ? '#44ff88' : '#ff4422';
  ctx.beginPath();
  ctx.ellipse(ix, iy, 9, 5.5, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(ix, iy, 2.8, 0, Math.PI * 2); ctx.fill();
  if (!on) {
    // Strike-through line
    ctx.strokeStyle = '#ff4422'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ix - 10, iy + 7); ctx.lineTo(ix + 10, iy - 7); ctx.stroke();
  }

  // Text
  ctx.fillStyle = on ? '#88ffbb' : '#ff7755';
  ctx.font = `bold 12px Segoe UI,sans-serif`; ctx.textAlign = 'left';
  ctx.fillText(on ? 'LOS  ON' : 'LOS  OFF', bx - w + 36, by + h / 2 + 4);

  ctx.restore();
}

// ── Weapon Factory Menu ───────────────────────────
function drawStatRow(barX, barW, sy, sd, w) {
  const pct = clamp(sd.barPct(w), 0, 1);
  const barCol = sd.col || `hsl(${(1 - w.dropoff) * 110},80%,55%)`;
  const trackY = sy + 20, trackH = 6, thumbR = 7;
  const thumbX = barX + barW * pct;

  // Labels
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '10px Segoe UI,sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(sd.label, barX, sy + 12);
  ctx.fillStyle = '#cceeff'; ctx.textAlign = 'right';
  ctx.fillText(sd.fmt(w), barX + barW, sy + 12);

  // Track background
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath(); ctx.roundRect(barX, trackY, barW, trackH, 3); ctx.fill();

  // Track fill
  if (pct > 0) {
    ctx.fillStyle = barCol;
    ctx.beginPath(); ctx.roundRect(barX, trackY, barW * pct, trackH, 3); ctx.fill();
  }

  // Thumb circle
  ctx.fillStyle = '#ffffff'; ctx.strokeStyle = barCol; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(thumbX, trackY + trackH / 2, thumbR, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
}
function drawFactoryMenu() {
  if (!factoryOpen) return;
  const { panX, panY, panW, panH, colW, colY, n } = factoryLayout();

  // Dim overlay
  ctx.fillStyle = 'rgba(0,0,0,0.74)'; ctx.fillRect(0, 0, WW, WH);

  // Panel
  ctx.fillStyle = '#141c22'; ctx.strokeStyle = '#2a4a62'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(panX, panY, panW, panH, 10); ctx.fill(); ctx.stroke();

  // Title bar
  ctx.fillStyle = '#1a2e3e';
  ctx.beginPath(); ctx.roundRect(panX, panY, panW, 46, [10, 10, 0, 0]); ctx.fill();
  ctx.fillStyle = '#44ccff'; ctx.font = 'bold 17px Segoe UI,sans-serif';
  ctx.textAlign = 'left'; ctx.fillText('⚙  WEAPON FACTORY', panX + 16, panY + 29);
  ctx.fillStyle = '#ffdd44'; ctx.font = 'bold 15px Segoe UI,sans-serif';
  ctx.textAlign = 'right'; ctx.fillText(`Credits: ${player.credits}`, panX + panW - 16, panY + 29);
  ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.font = '11px Segoe UI,sans-serif';
  ctx.fillText('F to close', panX + panW - 16, panY + 43);

  // Column separators
  for (let i = 1; i < n; i++) {
    const lx = panX + 20 + i * FCOL_W;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(lx, colY + 4); ctx.lineTo(lx, panY + panH - 54); ctx.stroke();
  }

  // Weapon columns
  for (let wi = 0; wi < n; wi++) {
    const w = weapons[wi];
    const cx = panX + 20 + wi * FCOL_W;
    const barX = cx + 14, barW = FCOL_W - 28;
    const active = wi === player.weaponIndex;

    // Column bg
    ctx.fillStyle = active ? 'rgba(68,170,204,0.08)' : 'rgba(255,255,255,0.02)';
    ctx.strokeStyle = active ? 'rgba(68,170,204,0.3)' : 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(cx + 6, colY + 2, FCOL_W - 12, panH - 64, 6); ctx.fill(); ctx.stroke();

    if (active) {
      ctx.fillStyle = '#44aacc'; ctx.font = 'bold 9px Segoe UI,sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('▲ EQUIPPED', cx + FCOL_W / 2, colY + 14);
    }
    drawWeaponShape(cx + FCOL_W / 2, colY + 32, FCOL_W * 0.5, 24, w);
    ctx.fillStyle = w.color; ctx.font = 'bold 13px Segoe UI,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(w.name, cx + FCOL_W / 2, colY + 60);
    { // rename hint: dotted underline + pencil icon
      const nw = ctx.measureText(w.name).width;
      ctx.strokeStyle = w.color + '55'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(cx + FCOL_W/2 - nw/2, colY + 63); ctx.lineTo(cx + FCOL_W/2 + nw/2, colY + 63); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = w.color + '88'; ctx.font = '9px Segoe UI,sans-serif';
      ctx.fillText('✎', cx + FCOL_W/2 + nw/2 + 8, colY + 62);
    }

    // 6 stat rows
    for (let si = 0; si < STAT_DEFS.length; si++)
      drawStatRow(barX, barW, colY + 68 + si * 48, STAT_DEFS[si], w);
  }

  // "New Weapon" button
  if (weapons.length < 8) {
    const nbX = panX + (panW - 160) / 2, nbY = panY + panH - 44;
    ctx.fillStyle = '#0e2018'; ctx.strokeStyle = '#33aa55'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(nbX, nbY, 160, 30, 5); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#66ffaa'; ctx.font = 'bold 12px Segoe UI,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('⊕  New Weapon', panX + panW / 2, nbY + 20);
  }
}

// ── Weapon Creator Panel ─────────────────────────
function drawCreatorPanel() {
  if (!creatorOpen) return;
  const { panX, panY, panW, panH, sec1Y, sec2Y, sec3Y } = creatorLayout();
  const cw = creatorWeapon;

  ctx.fillStyle = 'rgba(0,0,0,0.80)'; ctx.fillRect(0, 0, WW, WH);
  ctx.fillStyle = '#14201a'; ctx.strokeStyle = '#2a5a3a'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(panX, panY, panW, panH, 10); ctx.fill(); ctx.stroke();

  // Title
  ctx.fillStyle = '#182e20';
  ctx.beginPath(); ctx.roundRect(panX, panY, panW, 46, [10,10,0,0]); ctx.fill();
  ctx.fillStyle = '#44ff88'; ctx.font = 'bold 17px Segoe UI,sans-serif';
  ctx.textAlign = 'left'; ctx.fillText('⊕  CREATE WEAPON', panX + 16, panY + 29);
  ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '11px Segoe UI,sans-serif';
  ctx.textAlign = 'right'; ctx.fillText('F to cancel', panX + panW - 14, panY + 30);

  // ── Section 1: Preview + Shape ──
  ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(panX + 10, sec1Y, panW - 20, 112, 6); ctx.fill(); ctx.stroke();

  // Preview box
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.roundRect(panX + 18, sec1Y + 8, 190, 96, 4); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.font = '9px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('PREVIEW', panX + 113, sec1Y + 22);
  drawWeaponShape(panX + 113, sec1Y + 62, 150, 52, cw);
  ctx.fillStyle = cw.color; ctx.font = 'bold 10px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(cw.name, panX + 113, sec1Y + 100);
  { // rename hint
    const nwc = ctx.measureText(cw.name).width;
    ctx.strokeStyle = cw.color + '55'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(panX + 113 - nwc/2, sec1Y + 103); ctx.lineTo(panX + 113 + nwc/2, sec1Y + 103); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = cw.color + '88'; ctx.font = '8px Segoe UI,sans-serif';
    ctx.fillText('✎', panX + 113 + nwc/2 + 7, sec1Y + 102);
  }

  // Shape buttons
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '10px Segoe UI,sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('Body Shape', panX + 226, sec1Y + 20);
  ['pistol','smg','shotgun'].forEach((sh, i) => {
    const bx = panX + 230, by = sec1Y + 32 + i * 28;
    const sel = cw.shape === sh;
    ctx.fillStyle = sel ? cw.color + '28' : 'rgba(255,255,255,0.04)';
    ctx.strokeStyle = sel ? cw.color : 'rgba(255,255,255,0.12)'; ctx.lineWidth = sel ? 1.8 : 1;
    ctx.beginPath(); ctx.roundRect(bx, by, 180, 22, 3); ctx.fill(); ctx.stroke();
    // mini icon
    drawWeaponShape(bx + 28, by + 11, 40, 16, sh);
    ctx.fillStyle = sel ? cw.color : 'rgba(255,255,255,0.55)';
    ctx.font = sel ? 'bold 11px Segoe UI,sans-serif' : '11px Segoe UI,sans-serif';
    ctx.textAlign = 'left'; ctx.fillText(['Pistol','SMG','Shotgun'][i], bx + 56, by + 15);
  });

  // ── Section 2: Colour palettes ──
  const SS = 24;
  ['Primary', 'Accent'].forEach((lbl, row) => {
    const sy = sec2Y + row * 36;
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '10px Segoe UI,sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(lbl + ':', panX + 14, sy + 17);
    const cur = row === 0 ? cw.color : cw.accent;
    COLOR_PALETTE.forEach((col, i) => {
      const sx = panX + 90 + i * (SS + 3), sy2 = sy + 4;
      ctx.fillStyle = col; ctx.strokeStyle = col === cur ? '#fff' : 'rgba(255,255,255,0.15)';
      ctx.lineWidth = col === cur ? 2.5 : 1;
      ctx.beginPath(); ctx.roundRect(sx, sy2, SS, SS, 3); ctx.fill(); ctx.stroke();
    });
  });

  // ── Section 3: Stats ──
  const barX = panX + 20, barW = panW - 40;
  for (let si = 0; si < STAT_DEFS.length; si++)
    drawStatRow(barX, barW, sec3Y + si * 44, STAT_DEFS[si], cw);

  // ── Add to Arsenal button ──
  const addY = sec3Y + STAT_DEFS.length * 44 + 14;
  ctx.fillStyle = '#0e2a18'; ctx.strokeStyle = '#33cc66'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(panX + panW / 2 - 120, addY, 240, 36, 6); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#66ffaa'; ctx.font = 'bold 14px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('⊕  ADD TO ARSENAL', panX + panW / 2, addY + 24);
}

// ── Solid Rects (divider wall + cover blocks) ─────
function drawSolidRects() {
  // Divider left segment
  const dl = solidRects[0], dr = solidRects[1];
  ctx.fillStyle = '#1c3248';
  ctx.fillRect(dl.x, dl.y, dl.w, dl.h);
  ctx.fillRect(dr.x, dr.y, dr.w, dr.h);
  // Top highlight strip on divider
  ctx.fillStyle = '#2a4860';
  ctx.fillRect(dl.x, dl.y, dl.w, 7);
  ctx.fillRect(dr.x, dr.y, dr.w, 7);
  // Door gap glow
  ctx.save();
  const dg = ctx.createLinearGradient(DOOR_LEFT, DIVIDER_Y, DOOR_LEFT, DIVIDER_Y + DIVIDER_THICK);
  dg.addColorStop(0, 'rgba(80,160,255,0.18)');
  dg.addColorStop(1, 'rgba(80,160,255,0.04)');
  ctx.fillStyle = dg;
  ctx.fillRect(DOOR_LEFT, DIVIDER_Y, DOOR_RIGHT - DOOR_LEFT, DIVIDER_THICK);
  // Arrow hints in door gap
  ctx.fillStyle = 'rgba(100,180,255,0.35)'; ctx.font = 'bold 11px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('▲ COMBAT ZONE ▲', (DOOR_LEFT + DOOR_RIGHT) / 2, DIVIDER_Y - 6);
  ctx.restore();

  // Cover blocks
  for (let i = 2; i < solidRects.length; i++) {
    const r = solidRects[i];
    // Shadow
    ctx.save(); ctx.globalAlpha = 0.25; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.roundRect(r.x + 4, r.y + r.h - 4, r.w, 10, 3); ctx.fill(); ctx.restore();
    // Body
    ctx.fillStyle = '#1e3a50'; ctx.strokeStyle = '#3a6882'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, 4); ctx.fill(); ctx.stroke();
    // Top face highlight
    ctx.fillStyle = '#2a5070';
    ctx.beginPath(); ctx.roundRect(r.x + 2, r.y + 2, r.w - 4, 12, [4, 4, 0, 0]); ctx.fill();
    // Inner detail
    ctx.strokeStyle = 'rgba(80,140,180,0.2)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(r.x + 6, r.y + 18, r.w - 12, r.h - 26, 2); ctx.stroke();
  }
}

// ── Enemy ─────────────────────────────────────────
function drawEnemy() {
  if (!enemy.alive) return;
  const e = enemy;
  const alpha = e.losAlpha;

  // Fully hidden: show brief muzzle-flash bleed only
  if (alpha <= 0) {
    const FLASH_MS = 420;
    const age = performance.now() - enemy.lastFired;
    if (age < FLASH_MS) {
      const t = 1 - age / FLASH_MS;
      const r = e.radius * (1.1 + t * 0.5);
      ctx.save();
      ctx.globalAlpha = t * 0.55;
      ctx.fillStyle = '#ff2200';
      ctx.shadowColor = '#ff4400'; ctx.shadowBlur = 26;
      ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    return;
  }

  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(e.x, e.y);

  // Drop shadow
  ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(4, e.radius * 0.72, e.radius * 0.75, e.radius * 0.26, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();

  if (e.flashTimer > 0) ctx.filter = 'brightness(2.5)';

  // Body gradient
  const g = ctx.createRadialGradient(-e.radius * 0.25, -e.radius * 0.3, e.radius * 0.04, 0, 0, e.radius);
  g.addColorStop(0, '#ff7755'); g.addColorStop(0.5, '#cc2211'); g.addColorStop(1, '#7a1008');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, e.radius, 0, Math.PI * 2); ctx.fill();
  // Rim
  ctx.strokeStyle = '#ff4422'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(0, 0, e.radius, 0, Math.PI * 2); ctx.stroke();
  // Gloss
  ctx.save(); ctx.globalAlpha = 0.4;
  const gl = ctx.createRadialGradient(-e.radius*0.28, -e.radius*0.32, 0, -e.radius*0.18, -e.radius*0.18, e.radius*0.48);
  gl.addColorStop(0, 'rgba(255,255,255,0.85)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl;
  ctx.beginPath(); ctx.ellipse(-e.radius*0.12, -e.radius*0.18, e.radius*0.38, e.radius*0.28, -0.4, 0, Math.PI*2); ctx.fill(); ctx.restore();

  ctx.filter = 'none';

  // Eyes tracking player angle
  const ex = Math.cos(e.angle) * e.radius * 0.22, ey = Math.sin(e.angle) * e.radius * 0.22;
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(-e.radius*0.26 + ex, -e.radius*0.14 + ey, e.radius*0.15, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( e.radius*0.26 + ex, -e.radius*0.14 + ey, e.radius*0.15, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#ff2200';
  ctx.beginPath(); ctx.arc(-e.radius*0.26 + ex*1.3, -e.radius*0.14 + ey*1.3, e.radius*0.07, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( e.radius*0.26 + ex*1.3, -e.radius*0.14 + ey*1.3, e.radius*0.07, 0, Math.PI*2); ctx.fill();

  // Aim laser
  ctx.save(); ctx.globalAlpha = 0.2; ctx.strokeStyle = '#ff3300'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 7]);
  ctx.beginPath();
  ctx.moveTo(Math.cos(e.angle)*(e.radius+6), Math.sin(e.angle)*(e.radius+6));
  ctx.lineTo(Math.cos(e.angle)*140, Math.sin(e.angle)*140);
  ctx.stroke(); ctx.restore();

  // HP bar
  const pct = e.hp / e.maxHp;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath(); ctx.roundRect(-e.radius, -e.radius-18, e.radius*2, 7, 3); ctx.fill();
  ctx.fillStyle = `hsl(${pct * 110},80%,50%)`;
  ctx.beginPath(); ctx.roundRect(-e.radius, -e.radius-18, e.radius*2*pct, 7, 3); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = 'bold 9px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('ENEMY', 0, -e.radius - 22);
  ctx.restore();
}

// ── Enemy Bullets ─────────────────────────────────
function drawEnemyBullets() {
  for (const b of enemyBullets) {
    if (b.losAlpha <= 0) continue;
    const tl = b.trail.length;
    for (let i = 0; i < tl; i++) {
      const t = b.trail[i]; const a = (i / tl) * 0.45 * b.losAlpha;
      ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = b.tcol;
      ctx.beginPath(); ctx.arc(t.x, t.y, b.rad * (i / tl) * 0.7, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    ctx.save(); ctx.globalAlpha = b.losAlpha; ctx.shadowColor = b.col; ctx.shadowBlur = 16; ctx.fillStyle = b.col;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.rad, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}

// ── Player HP bar ─────────────────────────────────
function drawPlayerHP() {
  const pct = player.hp / player.maxHp;
  const barW = 160, barH = 10;
  const bx = player.x - barW / 2, by = player.y - player.radius - 28;

  // Invuln shield flash
  if (player.invulnTimer > 0 && Math.floor(player.invulnTimer * 7) % 2 === 0) {
    ctx.save(); ctx.globalAlpha = 0.28; ctx.strokeStyle = '#44aaff'; ctx.lineWidth = 3;
    ctx.shadowColor = '#44aaff'; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc(player.x, player.y, player.radius + 6, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }

  if (pct >= 1) return; // don't draw bar at full HP
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath(); ctx.roundRect(bx, by, barW, barH, 4); ctx.fill();
  ctx.fillStyle = `hsl(${pct * 110},80%,50%)`;
  ctx.beginPath(); ctx.roundRect(bx, by, barW * pct, barH, 4); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = 'bold 10px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`${player.hp} / ${player.maxHp}`, player.x, by - 3);
}

// ── Decoy ─────────────────────────────────────────
function drawDecoy() {
  if (!decoy.alive) return;
  const d = decoy, r = d.radius;
  const now = performance.now();

  ctx.save();
  ctx.translate(d.x, d.y);
  ctx.rotate(Math.sin(now / 40) * d.wobble * 0.018);

  // Outer pulse ring
  const ring = 0.28 + Math.sin(now / 480) * 0.12;
  ctx.save(); ctx.globalAlpha = ring;
  ctx.strokeStyle = '#44ffcc'; ctx.lineWidth = 2.5;
  ctx.shadowColor = '#44ffcc'; ctx.shadowBlur = 20;
  ctx.beginPath(); ctx.arc(0, 0, r + 10, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  if (d.flashTimer > 0) ctx.filter = 'brightness(2.5)';

  // Holographic body – teal/cyan tinted blob
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = '#082818';
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  const g = ctx.createRadialGradient(-r*0.28, -r*0.28, r*0.04, 0, 0, r*0.96);
  g.addColorStop(0, '#aaffee'); g.addColorStop(0.46, '#22cc99'); g.addColorStop(1, '#0a6655');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.96, 0, Math.PI * 2); ctx.fill();

  // Scan-line holographic overlay
  ctx.save(); ctx.globalAlpha = 0.12; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.8;
  for (let sy = -r + 3; sy < r; sy += 4) {
    const hw = Math.sqrt(Math.max(0, r * r - sy * sy)) * 0.93;
    ctx.beginPath(); ctx.moveTo(-hw, sy); ctx.lineTo(hw, sy); ctx.stroke();
  }
  ctx.restore();

  ctx.filter = 'none'; ctx.globalAlpha = 1;

  // Eyes (same style as player)
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(-r*0.3, -r*0.2, r*0.14, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( r*0.3, -r*0.2, r*0.14, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = 'white';
  ctx.beginPath(); ctx.arc(-r*0.24, -r*0.25, r*0.055, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( r*0.35, -r*0.25, r*0.055, 0, Math.PI*2); ctx.fill();

  ctx.restore();

  // HP bar + label (drawn in world space, not rotated)
  const pct = d.hp / d.maxHp;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath(); ctx.roundRect(d.x - r, d.y - r - 18, r*2, 7, 3); ctx.fill();
  ctx.fillStyle = `hsl(${pct * 110},80%,50%)`;
  ctx.beginPath(); ctx.roundRect(d.x - r, d.y - r - 18, r*2*pct, 7, 3); ctx.fill();
  ctx.fillStyle = '#44ffcc'; ctx.font = 'bold 9px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('DECOY', d.x, d.y - r - 22);
}

// ── Custom Weapon HUD (canvas, index ≥ 3) ─────────
function drawCustomWeaponHUD() {
  const wi = player.weaponIndex;
  if (wi < 3 || wi >= weapons.length) return;
  const w = weapons[wi];
  const panW = 240, panH = 54;
  const px = WW / 2 - panW / 2, py = IB - panH - 6;

  // Panel background
  ctx.fillStyle = 'rgba(12,22,16,0.92)';
  ctx.strokeStyle = w.color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(px, py, panW, panH, 6); ctx.fill(); ctx.stroke();

  // Slot number badge
  ctx.fillStyle = w.color + '55';
  ctx.beginPath(); ctx.roundRect(px + 4, py + 4, 28, panH - 8, 4); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = 'bold 12px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`[${wi + 1}]`, px + 18, py + panH / 2 + 4);

  // Weapon icon
  drawWeaponShape(px + 58, py + panH / 2, 54, 22, w);

  // Weapon name
  ctx.fillStyle = w.color; ctx.font = 'bold 13px Segoe UI,sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(w.name, px + 88, py + 20);

  // Ammo bar
  const pct = w.reloading ? 0 : w.ammo / w.maxAmmo;
  const bx2 = px + 88, bw2 = panW - 98;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath(); ctx.roundRect(bx2, py + 30, bw2, 6, 3); ctx.fill();
  if (pct > 0) {
    ctx.fillStyle = w.reloading ? '#666' : (pct <= 0.25 ? '#ff4444' : w.color);
    ctx.beginPath(); ctx.roundRect(bx2, py + 30, bw2 * pct, 6, 3); ctx.fill();
  }

  // Ammo text
  ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '10px Segoe UI,sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(w.reloading ? 'RELOADING...' : `${w.ammo} / ${w.maxAmmo}`, bx2, py + 46);
}

// ── Multiplayer draw helpers ──────────────────────

// Draw all remote (other) players from server snapshot
function drawRemotePlayers() {
  if (!serverSnapshot) return;
  const now = performance.now();
  const t   = Math.min((now - snapshotTime) / 50, 1); // interpolation factor (0→1 per tick)
  for (const p of serverSnapshot.players) {
    if (p.id === myId) continue;
    const alpha = remotePlayerLosAlpha.get(p.id) ?? 0;

    // Interpolate position from previous snapshot
    const prev = prevSnapshot?.players?.find(q => q.id === p.id);
    const rx = prev ? lerp(prev.x, p.x, t) : p.x;
    const ry = prev ? lerp(prev.y, p.y, t) : p.y;

    if (alpha <= 0) {
      // Muzzle-flash bleed hint when player is hidden and recently fired
      const FLASH_MS = 420;
      const lastFired = remotePlayerLastFired.get(p.id);
      if (lastFired !== undefined) {
        const age = performance.now() - lastFired;
        if (age < FLASH_MS) {
          const tf = 1 - age / FLASH_MS;
          ctx.save(); ctx.globalAlpha = tf * 0.55; ctx.fillStyle = p.color;
          ctx.shadowColor = p.color; ctx.shadowBlur = 26;
          ctx.beginPath(); ctx.arc(rx, ry, 26 * (1.1 + tf * 0.5), 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      }
      continue;
    }

    // Draw this player's decoy if they have one
    if (p.decoy) {
      ctx.save(); ctx.globalAlpha = alpha * 0.85;
      const ring = 0.3 + Math.sin(performance.now() / 480) * 0.12;
      ctx.save(); ctx.globalAlpha = alpha * ring;
      ctx.strokeStyle = '#44ffcc'; ctx.lineWidth = 2.5;
      ctx.shadowColor = '#44ffcc'; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(p.decoy.x, p.decoy.y, p.decoy.radius + 9, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      ctx.shadowBlur = 0;
      ctx.fillStyle = p.decoy.flashTimer > 0 ? '#88ffee' : '#33ccaa';
      ctx.beginPath(); ctx.arc(p.decoy.x, p.decoy.y, p.decoy.radius, 0, Math.PI * 2); ctx.fill();
      const dpct = p.decoy.hp / p.decoy.maxHp;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.roundRect(p.decoy.x - 18, p.decoy.y - p.decoy.radius - 12, 36, 5, 2); ctx.fill();
      ctx.fillStyle = `hsl(${dpct * 110},85%,52%)`;
      ctx.beginPath(); ctx.roundRect(p.decoy.x - 18, p.decoy.y - p.decoy.radius - 12, 36 * dpct, 5, 2); ctx.fill();
      ctx.restore();
    }

    ctx.save(); ctx.translate(rx, ry); ctx.globalAlpha = alpha;

    // Drop shadow — multiply alpha so it fades with the player
    ctx.save(); ctx.globalAlpha = alpha * 0.22; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(4, p.rolling ? 22 : 18, 20, 6, 0, 0, Math.PI*2); ctx.fill(); ctx.restore();

    // Blob body using their chosen colour
    drawBlobBody(0, 0, 26, p.rolling ? 1.3 : 1, p.rolling ? 0.8 : 1, p.color);

    // Aim line
    if (!p.rolling) {
      ctx.strokeStyle = p.color + '99'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(p.angle)*14, Math.sin(p.angle)*14);
      ctx.lineTo(Math.cos(p.angle)*36, Math.sin(p.angle)*36);
      ctx.stroke();
    }

    // Name tag
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const tw = ctx.measureText(p.name).width + 14;
    ctx.beginPath(); ctx.roundRect(-tw/2, -46, tw, 18, 4); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px Segoe UI,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(p.name, 0, -33);

    // HP bar
    const pct = p.hp / p.maxHp;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.roundRect(-22, -52, 44, 5, 2); ctx.fill();
    ctx.fillStyle = `hsl(${pct*110},85%,52%)`;
    ctx.beginPath(); ctx.roundRect(-22, -52, 44*pct, 5, 2); ctx.fill();

    ctx.restore();
  }
}

// Draw enemy using server-provided state (multiplayer)
function drawEnemyFromState(es) {
  if (!es || !es.alive) return;
  const alpha = remoteEnemyLosAlpha;

  if (alpha <= 0) {
    // Muzzle-flash bleed hint when enemy is fully hidden — driven by enemyLastSeenFire
    const FLASH_MS = 420;
    const age = performance.now() - enemyLastSeenFire;
    if (age < FLASH_MS) {
      const tf = 1 - age / FLASH_MS;
      ctx.save(); ctx.globalAlpha = tf * 0.55; ctx.fillStyle = '#ff2200';
      ctx.shadowColor = '#ff4400'; ctx.shadowBlur = 26;
      ctx.beginPath(); ctx.arc(es.x, es.y, es.radius * (1.1 + tf * 0.5), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    return;
  }

  // Reuse the full solo drawEnemy() with the object swapped out
  const savedEnemy = { ...enemy };
  Object.assign(enemy, es, { losAlpha: alpha, radius: 28 });
  drawEnemy();
  Object.assign(enemy, savedEnemy);
}

// Draw enemy bullets using server snapshot with per-bullet LOS fade
function drawEnemyBulletsFromState(eBullets) {
  if (!eBullets) return;
  const dt = (performance.now() - snapshotTime) / 1000; // extrapolation offset
  for (const b of eBullets) {
    const alpha = bulletLosAlpha.get(b.id) ?? 0;
    if (alpha <= 0) continue;
    // Extrapolate forward from last known position
    const rx = b.x + b.vx * dt;
    const ry = b.y + b.vy * dt;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.shadowColor = b.col; ctx.shadowBlur = 16; ctx.fillStyle = b.col;
    ctx.beginPath(); ctx.arc(rx, ry, b.rad, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }
}

// Draw other players' bullets from server snapshot (skip our own — drawn locally)
function drawServerPlayerBullets(serverBullets) {
  if (!serverBullets) return;
  const dt = (performance.now() - snapshotTime) / 1000;
  for (const b of serverBullets) {
    if (b.ownerId === myId) continue;
    const alpha = playerBulletLosAlpha.get(b.id) ?? 0;
    if (alpha <= 0) continue;
    const rx = b.x + b.vx * dt;
    const ry = b.y + b.vy * dt;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.shadowColor = b.col; ctx.shadowBlur = 14; ctx.fillStyle = b.col;
    ctx.beginPath(); ctx.arc(rx, ry, b.rad, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }
}

// ── Touch joystick overlay (drawn on canvas) ─────
function drawTouchControls() {
  if (!touchControls.enabled) return;
  ctx.save();

  // Derive canvas-space sizes from desired screen-px sizes
  const jMax  = JOYSTICK_SCREEN_MAX  / canvasScale;
  const jKnob = JOYSTICK_SCREEN_KNOB / canvasScale;
  const jGhost = (JOYSTICK_SCREEN_KNOB * 0.65) / canvasScale;

  // ── Left movement joystick ──
  // Default Y: keep joystick ring fully inside the visible viewport
  const joyMargin = (JOYSTICK_SCREEN_MAX + 14) / canvasScale;
  const joyDefaultY = Math.min(WH * 0.85, visibleBottomCanvasY - joyMargin);

  const active = touchControls.leftId !== null;
  const lox = active ? touchControls.leftOriginX : WW * 0.14;
  const loy = active ? touchControls.leftOriginY : joyDefaultY;

  // Base ring
  ctx.globalAlpha = active ? 0.42 : 0.14;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5 / canvasScale;
  ctx.beginPath(); ctx.arc(lox, loy, jMax, 0, Math.PI * 2); ctx.stroke();

  // Knob
  if (active) {
    const dx = touchControls.leftCurX - lox;
    const dy = touchControls.leftCurY - loy;
    const len = Math.hypot(dx, dy);
    const clampedLen = Math.min(len, jMax);
    const kx = len > 0 ? lox + (dx / len) * clampedLen : lox;
    const ky = len > 0 ? loy + (dy / len) * clampedLen : loy;
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(kx, ky, jKnob, 0, Math.PI * 2); ctx.fill();
  } else {
    // Ghost centre dot
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(lox, loy, jGhost, 0, Math.PI * 2); ctx.fill();
  }

  // ── Right aim joystick ──
  const rActive = touchControls.rightId !== null;
  const rox = rActive ? touchControls.rightOriginX : WW * 0.78;
  const roy = rActive ? touchControls.rightOriginY : joyDefaultY;

  ctx.globalAlpha = rActive ? 0.42 : 0.14;
  ctx.strokeStyle = '#ff6633'; ctx.lineWidth = 2.5 / canvasScale;
  ctx.beginPath(); ctx.arc(rox, roy, jMax, 0, Math.PI * 2); ctx.stroke();

  if (rActive) {
    const rdx = touchControls.rightCurX - rox;
    const rdy = touchControls.rightCurY - roy;
    const rlen = Math.hypot(rdx, rdy);
    const rClamped = Math.min(rlen, jMax);
    const rkx = rlen > 0 ? rox + (rdx / rlen) * rClamped : rox;
    const rky = rlen > 0 ? roy + (rdy / rlen) * rClamped : roy;
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = '#ff6633';
    ctx.beginPath(); ctx.arc(rkx, rky, jKnob, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#ff6633';
    ctx.beginPath(); ctx.arc(rox, roy, jGhost, 0, Math.PI * 2); ctx.fill();
  }

  ctx.restore();
}

// ── MAIN DRAW ────────────────────────────────────
function draw() {
  ctx.save(); ctx.translate(shake.x, shake.y);
  drawRoom();
  drawSolidRects();
  drawRail();
  drawPickups();
  drawTarget(movingTarget);
  drawDecoy();
  // Enemy & enemy bullets: server-state in multiplayer, local in solo
  if (ws && serverSnapshot) {
    drawEnemyFromState(serverSnapshot.enemy);
    drawEnemyBulletsFromState(serverSnapshot.enemyBullets);
  } else {
    drawEnemy();
    drawEnemyBullets();
  }
  drawBullets();                // local player bullets (always client-side)
  if (ws && serverSnapshot) drawServerPlayerBullets(serverSnapshot.bullets);
  drawRemotePlayers();          // other players (no-op in solo)
  drawPlayer();
  drawPlayerHP();
  drawFlashes();
  drawParticles();
  drawControlsHint();
  drawTouchControls();
  ctx.restore();
  drawInventory();       // drawn outside shake transform
  drawFactoryMenu();     // drawn outside shake transform
  drawCreatorPanel();    // drawn outside shake transform
  drawLOSBadge();        // drawn outside shake transform
  drawCustomWeaponHUD(); // canvas HUD for custom weapons (index ≥ 3)
}

// ── LOOP ─────────────────────────────────────────
function loop(ts) { update(ts); draw(); requestAnimationFrame(loop); }
makeFloor();
updateHUD();
requestAnimationFrame(loop);

// ── Join screen setup ────────────────────────────
(function setupJoinScreen() {
  const picker       = document.getElementById('colorPicker');
  const nameInput    = document.getElementById('nameInput');
  const joinBtn      = document.getElementById('joinBtn');
  const mobileToggle = document.getElementById('mobileToggle');

  // Auto-check toggle on touch devices
  if (mobileToggle && ('ontouchstart' in window || navigator.maxTouchPoints > 0))
    mobileToggle.checked = true;

  // Build colour swatches
  PLAYER_COLORS.forEach(col => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch';
    sw.style.background = col;
    if (col === myPlayerColor) sw.classList.add('selected');
    sw.addEventListener('click', () => {
      myPlayerColor = col;
      picker.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
    picker.appendChild(sw);
  });

  nameInput.addEventListener('input', () => {
    joinBtn.disabled = nameInput.value.trim().length === 0;
  });
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click();
  });

  joinBtn.addEventListener('click', () => {
    document.getElementById('joinOverlay').style.display = 'none';

    // Enable touch controls if requested
    if (mobileToggle && mobileToggle.checked) {
      touchControls.enabled = true;
      const btns = document.getElementById('touchBtns');
      if (btns) btns.style.display = 'flex';
      // Hide HTML weapon HUD — it overlaps the joystick area; weapons shown via canvas UI
      const hud = document.getElementById('hud');
      if (hud) hud.style.display = 'none';
      // Make weapon slots tappable on mobile
      for (let i = 0; i < 8; i++) {
        const slot = document.getElementById(`slot-${i}`);
        if (slot) { slot.style.pointerEvents = 'auto'; slot.style.cursor = 'pointer'; slot.addEventListener('pointerdown', () => switchWeapon(i)); }
      }
    }

    connectToServer(nameInput.value.trim(), myPlayerColor);
    canvas.focus();
  });

  // Touch action buttons
  const rollTouchBtn  = document.getElementById('rollTouchBtn');
  const decoyTouchBtn = document.getElementById('decoyTouchBtn');
  if (rollTouchBtn)
    rollTouchBtn.addEventListener('pointerdown', e => { e.stopPropagation(); tryRoll(); });
  if (decoyTouchBtn)
    decoyTouchBtn.addEventListener('pointerdown', e => { e.stopPropagation(); dropDecoy(); });
})();

