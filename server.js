'use strict';
const { WebSocketServer } = require('ws');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// ── Static file server ────────────────────────────
const MIME = {
  '.html': 'text/html',     '.js':           'text/javascript',
  '.css':  'text/css',      '.png':          'image/png',
  '.svg':  'image/svg+xml', '.json':         'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico':  'image/x-icon',
};
const httpServer = http.createServer((req, res) => {
  const file = req.url === '/' ? '/index.html' : req.url;
  const fp   = path.join(__dirname, file.split('?')[0]);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
});

// ── World constants (mirrored from game.js) ───────
const WW = 1600, WH = 1200, WALL = 60;
const IL = WALL, IR = WW - WALL, IT = WALL, IB = WH - WALL;
const DIVIDER_Y = 780, DIVIDER_THICK = 28;
const DOOR_LEFT = 700, DOOR_RIGHT = 900;

const solidRects = [
  { x: IL,         y: DIVIDER_Y, w: DOOR_LEFT - IL,  h: DIVIDER_THICK },
  { x: DOOR_RIGHT, y: DIVIDER_Y, w: IR - DOOR_RIGHT, h: DIVIDER_THICK },
  { x: 200, y: 640, w: 80, h: 80 },
  { x: 1320, y: 640, w: 80, h: 80 },
  { x: 280, y: 440, w: 80, h: 80 },
  { x: 1240, y: 440, w: 80, h: 80 },
  { x: 420, y: 220, w: 80, h: 80 },
  { x: 1100, y: 220, w: 80, h: 80 },
];

// ── Pure math helpers ─────────────────────────────
const lerp  = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist  = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function segmentIntersectsRect(ax, ay, bx, by, rect) {
  const dx = bx - ax, dy = by - ay;
  const { x, y, w, h } = rect;
  let tMin = 0, tMax = 1;
  const tests = [[-dx, ax - x], [dx, x + w - ax], [-dy, ay - y], [dy, y + h - ay]];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-10) { if (q < 0) return false; }
    else {
      const t = q / p;
      if (p < 0) { if (t > tMin) tMin = t; }
      else        { if (t < tMax) tMax = t; }
    }
    if (tMin >= tMax) return false;
  }
  return true;
}
function hasLOS(x1, y1, x2, y2) {
  for (const rect of solidRects)
    if (segmentIntersectsRect(x1, y1, x2, y2, rect)) return false;
  return true;
}
function bulletHitsSolidRect(b) {
  for (const rect of solidRects) {
    if (b.x >= rect.x && b.x <= rect.x + rect.w &&
        b.y >= rect.y && b.y <= rect.y + rect.h) {
      b.alive = false; return true;
    }
  }
  return false;
}
function pushOutOfSolidRects(ent) {
  const r = ent.radius;
  for (const rect of solidRects) {
    const left = rect.x - r, right = rect.x + rect.w + r;
    const top  = rect.y - r, bottom = rect.y + rect.h + r;
    if (ent.x < left || ent.x > right || ent.y < top || ent.y > bottom) continue;
    const ol = ent.x - left, or2 = right - ent.x, ot = ent.y - top, ob = bottom - ent.y;
    const m = Math.min(ol, or2, ot, ob);
    if (m === ol)       { ent.x = left;   if (ent.vx > 0) ent.vx = 0; }
    else if (m === or2) { ent.x = right;  if (ent.vx < 0) ent.vx = 0; }
    else if (m === ot)  { ent.y = top;    if (ent.vy > 0) ent.vy = 0; }
    else                { ent.y = bottom; if (ent.vy < 0) ent.vy = 0; }
  }
}

// ── Game state ────────────────────────────────────
const players = {};

const enemy = {
  x: 800, y: 180, radius: 28,
  hp: 200, maxHp: 200,
  fireRate: 1800, lastFired: 0,
  bulletSpeed: 480, bulletDmg: 8, bulletRange: 900,
  alive: true, flashTimer: 0, angle: 0,
};

let bullets      = [];
let enemyBullets = [];
let bulletIdCounter = 0;

// ── Player factory ───────────────────────────────
function createPlayer(id, name, color) {
  return {
    id, name, color,
    // Spawn safely inside the door gap (x 700-900) so enemy always has LOS
    x: WW / 2 + (Math.random() - 0.5) * 100,
    y: 960,
    vx: 0, vy: 0,
    radius: 26, speed: 290, friction: 0.83,
    hp: 100, maxHp: 100, invulnTimer: 0,
    alive: true,
    rolling: false, rollTimer: 0, rollDuration: 0.32,
    rollDx: 1, rollDy: 0, rollSpeed: 820,
    rollCooldown: 0, rollCooldownMax: 1.1,
    weaponIndex: 0,
    angle: 0,
    lastFired: {},   // { [weaponIndex]: timestamp_ms }
    inputKeys: {},
    ws: null,
    decoy: { alive: false, x: 0, y: 0, radius: 20, hp: 60, maxHp: 60, flashTimer: 0 },
  };
}

// ── Update: player physics ────────────────────────
function updatePlayerServer(p, dt) {
  if (!p.alive) return;
  if (p.invulnTimer > 0) p.invulnTimer = Math.max(0, p.invulnTimer - dt);

  if (p.rolling) {
    p.rollTimer -= dt;
    const rollFrac = 1 - p.rollTimer / p.rollDuration;
    const vel = p.rollSpeed * (1 - rollFrac * rollFrac);
    p.vx = p.rollDx * vel;
    p.vy = p.rollDy * vel;
    if (p.rollTimer <= 0) p.rolling = false;
  } else {
    let dx = 0, dy = 0;
    const k = p.inputKeys;
    if (k.KeyW) dy -= 1;
    if (k.KeyS) dy += 1;
    if (k.KeyA) dx -= 1;
    if (k.KeyD) dx += 1;
    if (dx && dy) { dx *= 0.707; dy *= 0.707; }
    p.vx += dx * p.speed * dt * 13;
    p.vy += dy * p.speed * dt * 13;
    p.vx *= Math.pow(p.friction, dt * 60);
    p.vy *= Math.pow(p.friction, dt * 60);
  }

  if (p.rollCooldown > 0) p.rollCooldown = Math.max(0, p.rollCooldown - dt);
  p.x += p.vx * dt; p.y += p.vy * dt;
  p.x = clamp(p.x, IL + p.radius, IR - p.radius);
  p.y = clamp(p.y, IT + p.radius, IB - p.radius);
  pushOutOfSolidRects(p);
}

// ── Update: enemy AI ─────────────────────────────
function updateEnemyServer(dt) {
  if (!enemy.alive) return;
  enemy.flashTimer = Math.max(0, enemy.flashTimer - dt);
  const now = Date.now();

  let targetX = null, targetY = null, minD = Infinity;

  // Decoys take priority — first visible decoy wins
  for (const p of Object.values(players)) {
    const d = p.decoy;
    if (!d.alive) continue;
    if (hasLOS(enemy.x, enemy.y, d.x, d.y)) {
      const dd = dist(enemy.x, enemy.y, d.x, d.y);
      if (dd < minD) { minD = dd; targetX = d.x; targetY = d.y; }
    }
  }

  // Fall back to nearest visible player if no decoy in LOS
  if (targetX === null) {
    for (const p of Object.values(players)) {
      if (!p.alive) continue;
      if (hasLOS(enemy.x, enemy.y, p.x, p.y)) {
        const d = dist(enemy.x, enemy.y, p.x, p.y);
        if (d < minD) { minD = d; targetX = p.x; targetY = p.y; }
      }
    }
  }

  if (targetX === null) return;

  enemy.angle = Math.atan2(targetY - enemy.y, targetX - enemy.x);
  if (now - enemy.lastFired >= enemy.fireRate) {
    enemy.lastFired = now;
    spawnEnemyBulletServer(enemy.angle);
  }
}

function spawnEnemyBulletServer(angle) {
  const ox = enemy.x + Math.cos(angle) * (enemy.radius + 10);
  const oy = enemy.y + Math.sin(angle) * (enemy.radius + 10);
  enemyBullets.push({
    id: ++bulletIdCounter,
    x: ox, y: oy,
    vx: Math.cos(angle) * enemy.bulletSpeed,
    vy: Math.sin(angle) * enemy.bulletSpeed,
    dmg: enemy.bulletDmg, col: '#ff3322', tcol: '#ff7755',
    rad: 5, alive: true, dist: 0,
    range: enemy.bulletRange, dropoff: 0.3,
  });
}

// ── Update: player bullets ────────────────────────
function updatePlayerBulletsServer(dt) {
  for (const b of bullets) {
    if (!b.alive) continue;
    b.x += b.vx * dt; b.y += b.vy * dt;
    b.dist += Math.hypot(b.vx, b.vy) * dt;

    if (b.dist >= b.range || b.x < IL || b.x > IR || b.y < IT || b.y > IB) {
      b.alive = false; continue;
    }
    if (bulletHitsSolidRect(b)) continue;

    // Hit enemy
    if (b.alive && enemy.alive) {
      if (dist(b.x, b.y, enemy.x, enemy.y) < enemy.radius + b.rad) {
        b.alive = false;
        const drop = 1 - b.dropoff * Math.min(1, b.dist / b.range);
        enemy.hp = clamp(enemy.hp - Math.max(1, Math.round(b.dmg * drop)), 0, enemy.maxHp);
        enemy.flashTimer = 0.14;
        if (enemy.hp <= 0) {
          enemy.alive = false;
          broadcast({ type: 'enemyDied' });
          setTimeout(() => { enemy.hp = enemy.maxHp; enemy.alive = true; }, 4000);
        }
        continue;
      }
    }

    // PvP: hit other players
    if (b.alive) {
      for (const p of Object.values(players)) {
        if (!p.alive || p.id === b.ownerId || p.invulnTimer > 0 || p.rolling) continue;
        if (dist(b.x, b.y, p.x, p.y) < p.radius + b.rad) {
          b.alive = false;
          const drop = 1 - b.dropoff * Math.min(1, b.dist / b.range);
          p.hp = clamp(p.hp - Math.max(1, Math.round(b.dmg * drop)), 0, p.maxHp);
          p.invulnTimer = 0.5;
          if (p.hp <= 0) respawnPlayerServer(p);
          break;
        }
      }
    }
  }
  bullets = bullets.filter(b => b.alive);
}

// ── Update: enemy bullets ─────────────────────────
function updateEnemyBulletsServer(dt) {
  for (const b of enemyBullets) {
    if (!b.alive) continue;
    b.x += b.vx * dt; b.y += b.vy * dt;
    b.dist += Math.hypot(b.vx, b.vy) * dt;

    if (b.dist >= b.range || b.x < IL || b.x > IR || b.y < IT || b.y > IB) {
      b.alive = false; continue;
    }
    if (bulletHitsSolidRect(b)) continue;

    for (const p of Object.values(players)) {
      if (!p.alive || p.invulnTimer > 0 || p.rolling) continue;
      if (dist(b.x, b.y, p.x, p.y) < p.radius + b.rad) {
        b.alive = false;
        const drop = 1 - b.dropoff * Math.min(1, b.dist / b.range);
        p.hp = clamp(p.hp - Math.max(1, Math.round(b.dmg * drop)), 0, p.maxHp);
        p.invulnTimer = 0.5;
        if (p.hp <= 0) respawnPlayerServer(p);
        break;
      }
    }
    // Decoys absorb enemy bullets
    if (b.alive) {
      for (const p of Object.values(players)) {
        const d = p.decoy;
        if (!d.alive) continue;
        if (dist(b.x, b.y, d.x, d.y) < d.radius + b.rad) {
          b.alive = false;
          const drop = 1 - b.dropoff * Math.min(1, b.dist / b.range);
          d.hp = clamp(d.hp - Math.max(1, Math.round(b.dmg * drop)), 0, d.maxHp);
          d.flashTimer = 0.14;
          if (d.hp <= 0) d.alive = false;
          break;
        }
      }
    }
  }
  enemyBullets = enemyBullets.filter(b => b.alive);
}

function respawnPlayerServer(p) {
  p.hp = p.maxHp;
  p.x = WW / 2 + (Math.random() - 0.5) * 200;
  p.y = 950 + (Math.random() - 0.5) * 80;
  p.vx = 0; p.vy = 0;
  p.rolling = false;
  p.invulnTimer = 2.5;
  if (p.ws && p.ws.readyState === 1)
    p.ws.send(JSON.stringify({ type: 'died' }));
}

// ── Game tick at 20 Hz ────────────────────────────
let lastTickTime = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt  = Math.min((now - lastTickTime) / 1000, 0.05);
  lastTickTime = now;

  for (const p of Object.values(players)) {
    updatePlayerServer(p, dt);
    // Tick decoy flash timer
    if (p.decoy.alive) p.decoy.flashTimer = Math.max(0, p.decoy.flashTimer - dt);
  }
  updateEnemyServer(dt);
  updatePlayerBulletsServer(dt);
  updateEnemyBulletsServer(dt);
  broadcastSnapshot();
}, 50);

// ── Snapshot ─────────────────────────────────────
function buildSnapshot() {
  return {
    type: 'snapshot',
    players: Object.values(players).map(p => ({
      id: p.id, name: p.name, color: p.color,
      x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp,
      angle: p.angle, rolling: p.rolling, weaponIndex: p.weaponIndex,
      decoy: p.decoy.alive
        ? { x: p.decoy.x, y: p.decoy.y, hp: p.decoy.hp, maxHp: p.decoy.maxHp, radius: p.decoy.radius, flashTimer: p.decoy.flashTimer }
        : null,
    })),
    enemy: {
      x: enemy.x, y: enemy.y,
      hp: enemy.hp, maxHp: enemy.maxHp,
      alive: enemy.alive, angle: enemy.angle,
      flashTimer: enemy.flashTimer,
    },
    bullets: bullets.map(b => ({
      id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy,
      col: b.col, tcol: b.tcol, rad: b.rad, ownerId: b.ownerId,
    })),
    enemyBullets: enemyBullets.map(b => ({
      id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy,
      col: b.col, tcol: b.tcol, rad: b.rad,
    })),
  };
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const p of Object.values(players))
    if (p.ws && p.ws.readyState === 1) p.ws.send(str);
}
function broadcastSnapshot() { broadcast(buildSnapshot()); }

// ── Action handlers ───────────────────────────────
function handleShoot(p, w, msgX, msgY, msgAngle) {
  if (!p.alive || !w) return;
  const now = Date.now();
  const wi  = p.weaponIndex;
  if (!p.lastFired[wi]) p.lastFired[wi] = 0;
  if (now - p.lastFired[wi] < (w.fireRate || 300)) return;
  p.lastFired[wi] = now;

  // Use client-provided position/angle for the bullet origin (more accurate than server state)
  const px = (msgX !== undefined) ? clamp(msgX, IL + p.radius, IR - p.radius) : p.x;
  const py = (msgY !== undefined) ? clamp(msgY, IT + p.radius, IB - p.radius) : p.y;
  const pa = (msgAngle !== undefined) ? msgAngle : p.angle;

  const count = Math.min(w.count || 1, 12); // cap pellets
  for (let i = 0; i < count; i++) {
    const sp = (Math.random() - 0.5) * (w.spread || 0) * 2;
    const a  = pa + sp;
    const ox = px + Math.cos(a) * (p.radius + 16);
    const oy = py + Math.sin(a) * (p.radius + 16);
    bullets.push({
      id: ++bulletIdCounter,
      x: ox, y: oy,
      vx: Math.cos(a) * (w.speed   || 920),
      vy: Math.sin(a) * (w.speed   || 920),
      dmg:     w.dmg      || 35,
      col:     w.bcol     || '#ffe455',
      tcol:    w.tcol     || '#bb8800',
      rad:     w.brad     || 4,
      alive:   true, dist: 0,
      range:   w.range    || 900,
      dropoff: w.dropoff  || 0.35,
      ownerId: p.id,
    });
  }
}

function handleRoll(p) {
  if (!p.alive || p.rolling || p.rollCooldown > 0) return;
  const k = p.inputKeys;
  let dx = 0, dy = 0;
  if (k.KeyW) dy -= 1;
  if (k.KeyS) dy += 1;
  if (k.KeyA) dx -= 1;
  if (k.KeyD) dx += 1;
  if (dx === 0 && dy === 0) { dx = Math.cos(p.angle); dy = Math.sin(p.angle); }
  else { const l = Math.hypot(dx, dy); dx /= l; dy /= l; }
  p.rolling = true;
  p.rollTimer = p.rollDuration;
  p.rollCooldown = p.rollCooldownMax;
  p.rollDx = dx; p.rollDy = dy;
}

// ── WebSocket + HTTP on the same port ────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  // Find local network IP for sharing with other devices
  const nets = os.networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets).flat()) {
    if (iface.family === 'IPv4' && !iface.internal) { localIP = iface.address; break; }
  }
  console.log(`🟢  Blob Shooter running!`);
  console.log(`    Local:   http://localhost:${PORT}`);
  console.log(`    Network: http://${localIP}:${PORT}  ← share this with other players`);
});
const wss = new WebSocketServer({ server: httpServer });
console.log();

let playerIdCounter = 0;

wss.on('connection', ws => {
  const id = `p${++playerIdCounter}`;
  let player = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      player = createPlayer(id, String(msg.name || 'Player').slice(0, 16), msg.color || '#44ff88');
      player.ws = ws;
      players[id] = player;
      // Send spawn position so the client can snap to it immediately
      ws.send(JSON.stringify({ type: 'welcome', id, x: player.x, y: player.y }));
      ws.send(JSON.stringify(buildSnapshot()));
      console.log(`  + ${player.name} (${id}) joined  [${Object.keys(players).length} online]`);
    }

    if (!player) return;

    if (msg.type === 'input') {
      player.inputKeys   = msg.keys       || {};
      player.angle       = msg.mouseAngle || 0;
      player.weaponIndex = msg.weaponIndex ?? player.weaponIndex;
      // Client is authoritative for its own position – accept it (with bounds check)
      if (msg.x !== undefined) {
        player.x = clamp(msg.x, IL + player.radius, IR - player.radius);
        player.y = clamp(msg.y, IT + player.radius, IB - player.radius);
        pushOutOfSolidRects(player);
      }
      if (msg.rolling !== undefined) player.rolling = !!msg.rolling;
    }
    if (msg.type === 'action') {
      if (msg.action === 'shoot') handleShoot(player, msg.weapon, msg.x, msg.y, msg.angle);
      if (msg.action === 'roll')  handleRoll(player);
      if (msg.action === 'decoy') {
        const dc = player.decoy;
        dc.alive = true; dc.x = player.x; dc.y = player.y;
        dc.hp = dc.maxHp; dc.flashTimer = 0;
      }
    }
  });

  ws.on('close', () => {
    if (player) {
      console.log(`  - ${player.name} (${id}) left  [${Object.keys(players).length - 1} online]`);
      delete players[id];
      broadcast({ type: 'playerLeft', id });
    }
  });

  ws.on('error', () => ws.terminate());
});
