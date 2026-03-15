// ── Training Grounds Mode ─────────────────────────
// Solo batting cage with ball physics. Loaded after game.js.
// Exposes: initTraining(), updateTraining(dt), drawTraining(),
//          checkTrainingBackClick(), trnCam

'use strict';

// ── Tunable constants ────────────────────────────
const TRN_MAX_SPEED      = 800;   // ball speed that maps to 100% momentum
const TRN_DEBUG          = false; // toggle debug visuals
const DAMAGE_MULTIPLIER  = 0.04;  // speed 1000 → 40 damage
const ENEMY_MAX_HP       = 100;
const ENEMY_MAX_COUNT    = 5;
const ENEMY_SPEED        = 160;
const ENEMY_DODGE_SPEED  = 200;
const ENEMY_BAT_LENGTH   = 48;
const ENEMY_BAT_WIDTH    = 14;

// ── Training map — dynamic bounds matching viewport aspect ratio ──
// Fills the visible area exactly at zoom 1.0 so no brown borders appear
const TRN_WALL = 40;
let TRN_L = TRN_WALL, TRN_R = WW - TRN_WALL;
let TRN_T = TRN_WALL, TRN_B = WH - TRN_WALL;
let TRN_RECTS = [];

function calcTrainingBounds() {
  const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const visibleH = Math.min(vh / (vw / WW), WH);

  TRN_L = TRN_WALL;
  TRN_R = WW - TRN_WALL;
  // Canvas is top-aligned (scaled to fit width), so visible area starts at y=0
  TRN_T = TRN_WALL;
  TRN_B = visibleH - TRN_WALL;

  const cx = WW / 2, cy = (TRN_T + TRN_B) / 2;
  const hw = (TRN_R - TRN_L) / 2;
  const hh = (TRN_B - TRN_T) / 2;

  TRN_RECTS = [
    // Central cross
    { x: cx - 40, y: cy - hh * 0.35, w: 80, h: 70 },
    { x: cx - 40, y: cy + hh * 0.35 - 70, w: 80, h: 70 },
    { x: cx - hw * 0.35, y: cy - 35, w: 80, h: 70 },
    { x: cx + hw * 0.35 - 80, y: cy - 35, w: 80, h: 70 },
    // Corner bumpers
    { x: TRN_L + 60, y: TRN_T + 60, w: 90, h: 50 },
    { x: TRN_R - 150, y: TRN_T + 60, w: 90, h: 50 },
    { x: TRN_L + 60, y: TRN_B - 110, w: 90, h: 50 },
    { x: TRN_R - 150, y: TRN_B - 110, w: 90, h: 50 },
    // Side walls
    { x: TRN_L + 50, y: cy - 90, w: 35, h: 180 },
    { x: TRN_R - 85, y: cy - 90, w: 35, h: 180 },
    // Top/bottom barriers
    { x: cx - hw * 0.55, y: TRN_T + 50, w: 50, h: 90 },
    { x: cx + hw * 0.55 - 50, y: TRN_T + 50, w: 50, h: 90 },
    { x: cx - hw * 0.55, y: TRN_B - 140, w: 50, h: 90 },
    { x: cx + hw * 0.55 - 50, y: TRN_B - 140, w: 50, h: 90 },
  ];
}

// ── Training camera ─────────────────────────────
const trnCam = {
  x: WW / 2,
  y: WH / 2,
  zoom: 1,
};

// ── Ball state ──────────────────────────────────
const trainingBall = {
  x: WW / 2, y: WH / 2,
  vx: 0, vy: 0,
  radius: 16,
  speed: 0,
  squash: 1,
  squashAngle: 0,
  squashTimer: 0,
  trail: [],
  stopped: true,
};

// ── Bat state ───────────────────────────────────
const bat = {
  length: 48,
  width: 14,
  prevAngle: 0,
  prevBase: { x: 0, y: 0 },
  prevTip: { x: 0, y: 0 },
  hitThisSwing: false,
  hitCooldown: 0,
};

// ── Momentum bar display state ──────────────────
let momentumDisplay = 0;

// ── Visual effects ──────────────────────────────
let bounceParticles = [];
let impactFlashes = [];
let shakeTimer = 0;
let shakeIntensity = 0;

// ── Enemies ──────────────────────────────────────
let trnEnemies = [];

// ── Debug visuals ───────────────────────────────
let debugHitLine = null;      // { cx, cy, dx, dy, timer }
let debugSweptQuad = null;    // { prevBase, prevTip, currBase, currTip }

// ── Init ────────────────────────────────────────
function initTraining() {
  calcTrainingBounds();
  const mapCY = (TRN_T + TRN_B) / 2;
  trainingBall.x = WW / 2;
  trainingBall.y = mapCY - 150;    // spawn ball above player
  trainingBall.vx = 0;
  trainingBall.vy = 0;
  trainingBall.speed = 0;
  trainingBall.stopped = true;
  trainingBall.trail = [];
  trainingBall.squash = 1;
  bat.hitThisSwing = true;           // block first hit until swing settles
  bat.hitCooldown = 0.5;
  bat._initFrames = 30;             // skip CCD for first 30 frames
  momentumDisplay = 0;
  bounceParticles = [];
  impactFlashes = [];
  shakeTimer = 0;
  debugHitLine = null;
  debugSweptQuad = null;

  player.x = WW / 2;
  player.y = mapCY + 150;
  player.vx = 0;
  player.vy = 0;
  player.hp = player.maxHp;
  player.alive = true;

  // Initialize bat facing downward (away from ball which spawns above)
  bat.prevAngle = Math.PI / 2;  // pointing down
  const initSeg = _getBatSegment(bat.prevAngle);
  bat.prevBase = { x: initSeg.bx, y: initSeg.by };
  bat.prevTip = { x: initSeg.tx, y: initSeg.ty };

  trnEnemies = [];
}

// ── Camera update ───────────────────────────────
function updateTrainingCamera() {
  trnCam.zoom = 1;
  // Smoothly follow player, clamped so camera never shows outside the map
  const halfW = (WW / 2) / trnCam.zoom;
  const halfH = (WH / 2) / trnCam.zoom;
  const targetX = clamp(player.x, halfW, WW - halfW);
  const targetY = clamp(player.y, halfH, WH - halfH);
  trnCam.x += (targetX - trnCam.x) * 0.1;
  trnCam.y += (targetY - trnCam.y) * 0.1;
}

// ── Push entity out of training rects ───────────
function pushOutOfTrainingRects(ent) {
  const r = ent.radius;
  for (const rect of TRN_RECTS) {
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

// ── Ball-character collision (damage) ───────────
// Call order: player first, then each enemy (first collision wins per frame)
function applyBallDamage(entity) {
  if (trainingBall.stopped) return;
  const d = Math.hypot(trainingBall.x - entity.x, trainingBall.y - entity.y);
  if (d < trainingBall.radius + entity.radius && trainingBall.speed > 30) {
    const dmg = trainingBall.speed * DAMAGE_MULTIPLIER;
    entity.hp = Math.max(0, entity.hp - dmg);
    entity.flashTimer = 0.2;
    trainingBall.vx *= 0.7;
    trainingBall.vy *= 0.7;
    trainingBall.speed = Math.hypot(trainingBall.vx, trainingBall.vy);
    const nx = (trainingBall.x - entity.x) / d;
    const ny = (trainingBall.y - entity.y) / d;
    const overlap = (trainingBall.radius + entity.radius) - d;
    trainingBall.x += nx * (overlap + 2);
    trainingBall.y += ny * (overlap + 2);
    if (entity !== player && entity.hp <= 0 && entity.splatTimer < 0) {
      entity.splatTimer = 0;
    }
  }
}

// ── Ball-rect bounce ────────────────────────────
function bounceBallOffRect(b, rect) {
  const r = b.radius;
  const left = rect.x - r, right = rect.x + rect.w + r;
  const top  = rect.y - r, bottom = rect.y + rect.h + r;
  if (b.x < left || b.x > right || b.y < top || b.y > bottom) return false;

  const ol = b.x - left, or2 = right - b.x, ot = b.y - top, ob = bottom - b.y;
  const m = Math.min(ol, or2, ot, ob);
  const restitution = 0.8;

  if (m === ol)       { b.x = left;   b.vx = -Math.abs(b.vx) * restitution; b.squashAngle = 0; }
  else if (m === or2) { b.x = right;  b.vx =  Math.abs(b.vx) * restitution; b.squashAngle = 0; }
  else if (m === ot)  { b.y = top;    b.vy = -Math.abs(b.vy) * restitution; b.squashAngle = Math.PI / 2; }
  else                { b.y = bottom; b.vy =  Math.abs(b.vy) * restitution; b.squashAngle = Math.PI / 2; }

  b.squash = 0.7;
  b.squashTimer = 0.13;

  const spd0 = Math.hypot(b.vx, b.vy);

  if (spd0 > 60) {
    impactFlashes.push({ x: b.x, y: b.y, radius: 8, maxRadius: 30 + spd0 * 0.03, alpha: 0.6 });
  }

  if (spd0 > 40) {
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = 40 + Math.random() * 80;
      bounceParticles.push({
        x: b.x, y: b.y,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        life: 0.25 + Math.random() * 0.15,
        maxLife: 0.25 + Math.random() * 0.15,
        radius: 3 + Math.random() * 4,
      });
    }
    if (spd0 > 150) {
      shakeTimer = 0.12;
      shakeIntensity = Math.min(spd0 * 0.008, 6);
    }
  }

  return true;
}

// ── Normalize angle to [-PI, PI] ────────────────
function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// ── Get bat segment (base & tip) for a given angle ──
function _getBatSegment(angle) {
  const baseDist = player.radius + 10;
  const tipDist = baseDist + bat.length;
  return {
    bx: player.x + Math.cos(angle) * baseDist,
    by: player.y + Math.sin(angle) * baseDist,
    tx: player.x + Math.cos(angle) * tipDist,
    ty: player.y + Math.sin(angle) * tipDist,
  };
}

function _getEnemyBatSegment(enemy, angle) {
  const baseDist = enemy.radius + 10;
  return {
    bx: enemy.x + Math.cos(angle) * baseDist,
    by: enemy.y + Math.sin(angle) * baseDist,
    tx: enemy.x + Math.cos(angle) * (baseDist + ENEMY_BAT_LENGTH),
    ty: enemy.y + Math.sin(angle) * (baseDist + ENEMY_BAT_LENGTH),
  };
}

function getBatTip() {
  const tipDist = player.radius + 10 + bat.length;
  return {
    x: player.x + Math.cos(player.angle) * tipDist,
    y: player.y + Math.sin(player.angle) * tipDist,
  };
}

function getBatBase() {
  const baseDist = player.radius + 10;
  return {
    x: player.x + Math.cos(player.angle) * baseDist,
    y: player.y + Math.sin(player.angle) * baseDist,
  };
}

// ── Closest point on line segment to a point ────
function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: ax, y: ay, t: 0 };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return { x: ax + dx * t, y: ay + dy * t, t };
}

// ── Line segment vs circle intersection test ────
// Returns { hit, closest, dist } for segment (ax,ay)→(bx,by) vs circle at (cx,cy,r)
function segmentCircleTest(ax, ay, bx, by, cx, cy, r) {
  const cp = closestPointOnSegment(cx, cy, ax, ay, bx, by);
  const d = Math.hypot(cx - cp.x, cy - cp.y);
  return { hit: d < r, closest: cp, dist: d };
}

// ── CCD: Check if ball crossed through a line segment between frames ──
// Uses line-segment vs line-segment intersection
function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(denom) < 1e-10) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// ── Update ──────────────────────────────────────
function updateTraining(dt) {
  updateTrainingCamera();

  // Player movement
  player.angle = Math.atan2(mouse.y - player.y, mouse.x - player.x);

  if (player.rolling) {
    player.rollTimer -= dt;
    const rollFrac = 1 - player.rollTimer / player.rollDuration;
    const vel = player.rollSpeed * (1 - rollFrac * rollFrac);
    player.vx = player.rollDx * vel;
    player.vy = player.rollDy * vel;
    if (player.rollTimer <= 0) player.rolling = false;
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

  if (player.rollCooldown > 0) player.rollCooldown = Math.max(0, player.rollCooldown - dt);
  player.x += player.vx * dt;
  player.y += player.vy * dt;
  player.x = clamp(player.x, TRN_L + player.radius, TRN_R - player.radius);
  player.y = clamp(player.y, TRN_T + player.radius, TRN_B - player.radius);
  pushOutOfTrainingRects(player);

  // Ghost trail for rolling
  if (player.rolling) {
    if (player.ghosts.length === 0 ||
      dist(player.x, player.y, player.ghosts[player.ghosts.length - 1].x, player.ghosts[player.ghosts.length - 1].y) > 14) {
      player.ghosts.push({ x: player.x, y: player.y, alpha: 0.5 });
    }
  }
  for (let i = player.ghosts.length - 1; i >= 0; i--) {
    player.ghosts[i].alpha -= dt * 2;
    if (player.ghosts[i].alpha <= 0) player.ghosts.splice(i, 1);
  }

  // ── Sweep-hit bat-ball collision with CCD ──
  if (bat.hitCooldown > 0) bat.hitCooldown -= dt;

  const angleDelta = normalizeAngle(player.angle - bat.prevAngle);
  const angularVel = dt > 0 ? angleDelta / dt : 0;

  // Current bat segment
  const currSeg = _getBatSegment(player.angle);
  const currBase = { x: currSeg.bx, y: currSeg.by };
  const currTip = { x: currSeg.tx, y: currSeg.ty };

  // Reset hit flag when angular velocity is low (swing ended)
  if (Math.abs(angularVel) < 0.5) {
    bat.hitThisSwing = false;
  }

  // Store swept quad for debug
  if (TRN_DEBUG) {
    debugSweptQuad = {
      prevBase: { ...bat.prevBase }, prevTip: { ...bat.prevTip },
      currBase: { ...currBase }, currTip: { ...currTip },
    };
  }

  if (!bat.hitThisSwing && bat.hitCooldown <= 0 && !player.rolling) {
    const bx = trainingBall.x, by = trainingBall.y;
    const hitRadius = trainingBall.radius + bat.width;
    let contactPoint = null;

    // Test 1: Current frame — closest point on current bat segment to ball
    const currTest = segmentCircleTest(currBase.x, currBase.y, currTip.x, currTip.y, bx, by, hitRadius);
    if (currTest.hit) {
      contactPoint = currTest.closest;
    }

    // Test 2: CCD — check if ball passed through the swept quad
    // Only run CCD if ball is within max bat reach distance from player
    const ballPlayerDist = Math.hypot(bx - player.x, by - player.y);
    const maxCCDDist = (player.radius + 10 + bat.length) * 2; // generous reach
    const skipCCD = (bat._initFrames > 0) || (ballPlayerDist > maxCCDDist);
    if (!contactPoint && !skipCCD) {
      const pb = bat.prevBase, pt = bat.prevTip;
      // Check all 4 edges of the swept quad against the ball's position
      // Use a "fat" point test: does the ball center's path cross any swept edge?
      // Since ball may not move much, check if ball center is inside the swept quad
      // OR if any swept edge comes close enough to the ball

      // Edge 1: prevBase → currBase (base sweep)
      const e1 = segmentCircleTest(pb.x, pb.y, currBase.x, currBase.y, bx, by, hitRadius);
      if (e1.hit) {
        contactPoint = e1.closest;
      }
      // Edge 2: prevTip → currTip (tip sweep)
      if (!contactPoint) {
        const e2 = segmentCircleTest(pt.x, pt.y, currTip.x, currTip.y, bx, by, hitRadius);
        if (e2.hit) {
          contactPoint = e2.closest;
        }
      }
      // Edge 3: previous bat segment
      if (!contactPoint) {
        const e3 = segmentCircleTest(pb.x, pb.y, pt.x, pt.y, bx, by, hitRadius);
        if (e3.hit) {
          contactPoint = e3.closest;
        }
      }

      // If still no hit, check if ball center is inside the swept quad
      // (winding number / cross product test for convex quad)
      if (!contactPoint) {
        const qx = [pb.x, pt.x, currTip.x, currBase.x];
        const qy = [pb.y, pt.y, currTip.y, currBase.y];
        let inside = true;
        for (let i = 0; i < 4; i++) {
          const j = (i + 1) % 4;
          const cross = (qx[j] - qx[i]) * (by - qy[i]) - (qy[j] - qy[i]) * (bx - qx[i]);
          if (cross < 0) { inside = false; break; }
        }
        if (!inside) {
          // Try opposite winding
          inside = true;
          for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            const cross = (qx[j] - qx[i]) * (by - qy[i]) - (qy[j] - qy[i]) * (bx - qx[i]);
            if (cross > 0) { inside = false; break; }
          }
        }
        if (inside) {
          // Use midpoint of swept bat as contact
          const midBase = { x: (pb.x + currBase.x) / 2, y: (pb.y + currBase.y) / 2 };
          const midTip = { x: (pt.x + currTip.x) / 2, y: (pt.y + currTip.y) / 2 };
          contactPoint = closestPointOnSegment(bx, by, midBase.x, midBase.y, midTip.x, midTip.y);
        }
      }
    }

    // ── Process hit ──
    if (contactPoint) {
      // Fix 1: Hit direction = normalize(ball_center - contact_point)
      let hitDx = bx - contactPoint.x;
      let hitDy = by - contactPoint.y;
      let hitLen = Math.hypot(hitDx, hitDy);
      if (hitLen > 0.01) {
        hitDx /= hitLen;
        hitDy /= hitLen;
      } else {
        // Ball exactly on contact point — use bat outward normal
        hitDx = Math.cos(player.angle);
        hitDy = Math.sin(player.angle);
      }

      // Fix 1 cont: Dot product sanity check
      // Bat velocity direction at contact (perpendicular to bat, in swing direction)
      const batOutward = { x: Math.cos(player.angle), y: Math.sin(player.angle) };
      // Bat swing velocity is perpendicular to bat direction, in the direction of angular velocity
      const swingDir = {
        x: -Math.sin(player.angle) * (angularVel >= 0 ? 1 : -1),
        y:  Math.cos(player.angle) * (angularVel >= 0 ? 1 : -1),
      };
      const dot = hitDx * swingDir.x + hitDy * swingDir.y;

      // If hit direction opposes swing direction AND we have significant swing,
      // flip the hit direction
      if (dot < 0 && Math.abs(angularVel) > 1) {
        hitDx = -hitDx;
        hitDy = -hitDy;
      }

      // Fix 3: Clamp launch angle — no more than 90° from bat outward direction
      const hitAngle = Math.atan2(hitDy, hitDx);
      const outAngle = Math.atan2(batOutward.y, batOutward.x);
      let angleDiff = normalizeAngle(hitAngle - outAngle);
      if (Math.abs(angleDiff) > Math.PI / 2) {
        // Clamp to nearest 90° boundary
        const clampedAngle = outAngle + Math.sign(angleDiff) * Math.PI / 2;
        hitDx = Math.cos(clampedAngle);
        hitDy = Math.sin(clampedAngle);
      }

      // Swing speed at contact point
      const pivotDist = contactPoint.t !== undefined
        ? player.radius + 10 + contactPoint.t * bat.length
        : Math.hypot(contactPoint.x - player.x, contactPoint.y - player.y);
      const swingSpeed = Math.abs(angularVel) * pivotDist;
      const effectiveSpeed = Math.max(swingSpeed, 120);

      // Launch
      const powerMultiplier = 1.5;
      trainingBall.vx = hitDx * effectiveSpeed * powerMultiplier;
      trainingBall.vy = hitDy * effectiveSpeed * powerMultiplier;

      // Cap
      const launchSpeed = Math.hypot(trainingBall.vx, trainingBall.vy);
      if (launchSpeed > 1000) {
        trainingBall.vx *= 1000 / launchSpeed;
        trainingBall.vy *= 1000 / launchSpeed;
      }

      trainingBall.stopped = false;
      trainingBall.speed = Math.hypot(trainingBall.vx, trainingBall.vy);

      // Fix 4: Set hit flag and 200ms minimum cooldown
      bat.hitThisSwing = true;
      bat.hitCooldown = 0.2;

      // Push ball out of bat
      trainingBall.x = contactPoint.x + hitDx * (trainingBall.radius + bat.width + 2);
      trainingBall.y = contactPoint.y + hitDy * (trainingBall.radius + bat.width + 2);

      // Screen shake
      if (trainingBall.speed > 100) {
        shakeTimer = 0.15;
        shakeIntensity = Math.min(trainingBall.speed * 0.008, 8);
      }

      // Impact particles
      if (trainingBall.speed > 80) {
        for (let i = 0; i < 6; i++) {
          const a = Math.random() * Math.PI * 2;
          const spd = 60 + Math.random() * 120;
          bounceParticles.push({
            x: contactPoint.x, y: contactPoint.y,
            vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
            life: 0.3 + Math.random() * 0.2,
            maxLife: 0.3 + Math.random() * 0.2,
            radius: 3 + Math.random() * 5,
          });
        }
        impactFlashes.push({ x: contactPoint.x, y: contactPoint.y, radius: 5, maxRadius: 35, alpha: 0.5 });
      }

      // Squash
      trainingBall.squash = 0.7;
      trainingBall.squashTimer = 0.13;
      trainingBall.squashAngle = Math.atan2(hitDy, hitDx);

      // Fix 5: Debug visuals
      if (TRN_DEBUG) {
        debugHitLine = {
          cx: contactPoint.x, cy: contactPoint.y,
          dx: hitDx, dy: hitDy,
          timer: 0.5,
        };
        console.log('BAT HIT:', {
          contact: { x: contactPoint.x.toFixed(1), y: contactPoint.y.toFixed(1) },
          hitDir: { x: hitDx.toFixed(3), y: hitDy.toFixed(3) },
          swingDir: { x: swingDir.x.toFixed(3), y: swingDir.y.toFixed(3) },
          dotProduct: dot.toFixed(3),
          angularVel: angularVel.toFixed(2),
          launchSpeed: trainingBall.speed.toFixed(1),
        });
      }
    }
  }

  // Store current bat segment as previous for next frame's CCD
  bat.prevBase = { x: currBase.x, y: currBase.y };
  bat.prevTip = { x: currTip.x, y: currTip.y };
  bat.prevAngle = player.angle;
  if (bat._initFrames > 0) bat._initFrames--;

  // ── Ball physics ──
  if (!trainingBall.stopped) {
    trainingBall.x += trainingBall.vx * dt;
    trainingBall.y += trainingBall.vy * dt;

    trainingBall.vx *= Math.pow(0.985, dt * 60);
    trainingBall.vy *= Math.pow(0.985, dt * 60);

    trainingBall.speed = Math.hypot(trainingBall.vx, trainingBall.vy);

    if (trainingBall.speed > 1000) {
      const scale = 1000 / trainingBall.speed;
      trainingBall.vx *= scale;
      trainingBall.vy *= scale;
      trainingBall.speed = 1000;
    }

    if (trainingBall.speed < 30) {
      trainingBall.vx = 0;
      trainingBall.vy = 0;
      trainingBall.speed = 0;
      trainingBall.stopped = true;
    }

    // Bounce off outer walls
    const wallRest = 0.8;
    if (trainingBall.x - trainingBall.radius < TRN_L) {
      trainingBall.x = TRN_L + trainingBall.radius;
      trainingBall.vx = Math.abs(trainingBall.vx) * wallRest;
      trainingBall.squash = 0.7; trainingBall.squashTimer = 0.13; trainingBall.squashAngle = 0;
      const s = Math.abs(trainingBall.vx);
      if (s > 60) impactFlashes.push({ x: trainingBall.x, y: trainingBall.y, radius: 8, maxRadius: 25, alpha: 0.5 });
      if (s > 100) { shakeTimer = 0.1; shakeIntensity = 3; }
    }
    if (trainingBall.x + trainingBall.radius > TRN_R) {
      trainingBall.x = TRN_R - trainingBall.radius;
      trainingBall.vx = -Math.abs(trainingBall.vx) * wallRest;
      trainingBall.squash = 0.7; trainingBall.squashTimer = 0.13; trainingBall.squashAngle = 0;
      const s = Math.abs(trainingBall.vx);
      if (s > 60) impactFlashes.push({ x: trainingBall.x, y: trainingBall.y, radius: 8, maxRadius: 25, alpha: 0.5 });
      if (s > 100) { shakeTimer = 0.1; shakeIntensity = 3; }
    }
    if (trainingBall.y - trainingBall.radius < TRN_T) {
      trainingBall.y = TRN_T + trainingBall.radius;
      trainingBall.vy = Math.abs(trainingBall.vy) * wallRest;
      trainingBall.squash = 0.7; trainingBall.squashTimer = 0.13; trainingBall.squashAngle = Math.PI / 2;
      const s = Math.abs(trainingBall.vy);
      if (s > 60) impactFlashes.push({ x: trainingBall.x, y: trainingBall.y, radius: 8, maxRadius: 25, alpha: 0.5 });
      if (s > 100) { shakeTimer = 0.1; shakeIntensity = 3; }
    }
    if (trainingBall.y + trainingBall.radius > TRN_B) {
      trainingBall.y = TRN_B - trainingBall.radius;
      trainingBall.vy = -Math.abs(trainingBall.vy) * wallRest;
      trainingBall.squash = 0.7; trainingBall.squashTimer = 0.13; trainingBall.squashAngle = Math.PI / 2;
      const s = Math.abs(trainingBall.vy);
      if (s > 60) impactFlashes.push({ x: trainingBall.x, y: trainingBall.y, radius: 8, maxRadius: 25, alpha: 0.5 });
      if (s > 100) { shakeTimer = 0.1; shakeIntensity = 3; }
    }

    for (const rect of TRN_RECTS) {
      bounceBallOffRect(trainingBall, rect);
    }

    if (trainingBall.speed > 180) {
      trainingBall.trail.push({ x: trainingBall.x, y: trainingBall.y, alpha: 0.6 });
      if (trainingBall.trail.length > 5) trainingBall.trail.shift();
    }
  }

  // Fade trail
  for (let i = trainingBall.trail.length - 1; i >= 0; i--) {
    trainingBall.trail[i].alpha -= dt * 3;
    if (trainingBall.trail[i].alpha <= 0) trainingBall.trail.splice(i, 1);
  }

  // Squash recovery
  if (trainingBall.squashTimer > 0) {
    trainingBall.squashTimer -= dt;
    const t = 1 - trainingBall.squashTimer / 0.13;
    trainingBall.squash = 0.7 + 0.3 * t + 0.08 * Math.sin(t * Math.PI * 2) * (1 - t);
  } else {
    trainingBall.squash = 1;
  }

  // Bounce particles
  for (let i = bounceParticles.length - 1; i >= 0; i--) {
    const p = bounceParticles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.94; p.vy *= 0.94;
    p.life -= dt;
    if (p.life <= 0) bounceParticles.splice(i, 1);
  }

  // Impact flashes
  for (let i = impactFlashes.length - 1; i >= 0; i--) {
    const f = impactFlashes[i];
    f.radius += (f.maxRadius - f.radius) * 0.3;
    f.alpha -= dt * 4;
    if (f.alpha <= 0) impactFlashes.splice(i, 1);
  }

  if (shakeTimer > 0) shakeTimer -= dt;

  // Debug hit line timer
  if (debugHitLine) {
    debugHitLine.timer -= dt;
    if (debugHitLine.timer <= 0) debugHitLine = null;
  }

  // Momentum bar
  const actualMomentum = Math.min(trainingBall.speed / TRN_MAX_SPEED * 100, 100);
  momentumDisplay += (actualMomentum - momentumDisplay) * 0.1;
  if (Math.abs(momentumDisplay - actualMomentum) < 0.5) momentumDisplay = actualMomentum;

  // Roll
  if ((keys['Space'] || keys['space']) && !player.rolling && player.rollCooldown <= 0) {
    let rdx = 0, rdy = 0;
    if (keys['KeyW']) rdy -= 1;
    if (keys['KeyS']) rdy += 1;
    if (keys['KeyA']) rdx -= 1;
    if (keys['KeyD']) rdx += 1;
    if (rdx === 0 && rdy === 0) { rdx = Math.cos(player.angle); rdy = Math.sin(player.angle); }
    else { const l = Math.hypot(rdx, rdy); rdx /= l; rdy /= l; }
    player.rolling = true;
    player.rollTimer = player.rollDuration;
    player.rollCooldown = player.rollCooldownMax;
    player.rollDx = rdx; player.rollDy = rdy;
  }

  // ── Ball damage ──
  applyBallDamage(player);
  for (const enemy of trnEnemies) {
    if (enemy.splatTimer < 0) applyBallDamage(enemy);
  }

  // ── Enemy AI update ──
  for (const enemy of trnEnemies) {
    if (enemy.flashTimer > 0) enemy.flashTimer -= dt;
    if (enemy.splatTimer >= 0) {
      enemy.splatTimer += dt;
      continue;
    }

    // State priority: SWING_ACTIVE > IDLE > DODGE > SWING_INIT > CHASE
    if (enemy.swingProgress >= 0) {
      // SWING_ACTIVE
      enemy.swingProgress += dt / 0.4;
      if (enemy.swingProgress >= 1) {
        enemy.swingProgress = -1;
        enemy.swingCooldown = 1.5 + Math.random() * 0.5;
      } else {
        const swingAngle = enemy.swingStartAngle + enemy.swingDir * (enemy.swingProgress * (Math.PI * 2 / 3));
        const currSeg = _getEnemyBatSegment(enemy, swingAngle);
        // CCD bat-ball check
        if (!enemy.hitThisSwing) {
          const bx = trainingBall.x, by = trainingBall.y;
          const hitRadius = trainingBall.radius + ENEMY_BAT_WIDTH;
          let contactPoint = null;
          const currTest = segmentCircleTest(currSeg.bx, currSeg.by, currSeg.tx, currSeg.ty, bx, by, hitRadius);
          if (currTest.hit) contactPoint = currTest.closest;
          if (!contactPoint) {
            const e1 = segmentCircleTest(enemy.prevBatBase.x, enemy.prevBatBase.y, currSeg.bx, currSeg.by, bx, by, hitRadius);
            if (e1.hit) contactPoint = e1.closest;
          }
          if (!contactPoint) {
            const e2 = segmentCircleTest(enemy.prevBatTip.x, enemy.prevBatTip.y, currSeg.tx, currSeg.ty, bx, by, hitRadius);
            if (e2.hit) contactPoint = e2.closest;
          }
          if (contactPoint) {
            let hitDx = bx - contactPoint.x;
            let hitDy = by - contactPoint.y;
            const hitLen = Math.hypot(hitDx, hitDy);
            if (hitLen > 0.01) { hitDx /= hitLen; hitDy /= hitLen; }
            else { hitDx = Math.cos(swingAngle); hitDy = Math.sin(swingAngle); }
            const swingSpeed = 300;
            trainingBall.vx = hitDx * swingSpeed;
            trainingBall.vy = hitDy * swingSpeed;
            trainingBall.stopped = false;
            trainingBall.speed = Math.hypot(trainingBall.vx, trainingBall.vy);
            trainingBall.squash = 0.75; trainingBall.squashTimer = 0.13;
            trainingBall.squashAngle = Math.atan2(hitDy, hitDx);
            trainingBall.x = contactPoint.x + hitDx * (trainingBall.radius + ENEMY_BAT_WIDTH + 2);
            trainingBall.y = contactPoint.y + hitDy * (trainingBall.radius + ENEMY_BAT_WIDTH + 2);
            enemy.hitThisSwing = true;
          }
        }
        enemy.prevBatBase = { x: currSeg.bx, y: currSeg.by };
        enemy.prevBatTip  = { x: currSeg.tx, y: currSeg.ty };
        enemy.angle = swingAngle;
      }
    } else if (trainingBall.stopped) {
      // IDLE
      enemy.vx = 0; enemy.vy = 0;
    } else if (trainingBall.speed > 200) {
      // DODGE: sidestep perpendicular to ball velocity, away from ball
      const bvLen = Math.hypot(trainingBall.vx, trainingBall.vy);
      const perpX = -trainingBall.vy / bvLen;
      const perpY =  trainingBall.vx / bvLen;
      const dot = perpX * (enemy.x - trainingBall.x) + perpY * (enemy.y - trainingBall.y);
      const side = dot >= 0 ? 1 : -1;
      enemy.vx = perpX * side * ENEMY_DODGE_SPEED;
      enemy.vy = perpY * side * ENEMY_DODGE_SPEED;
    } else {
      const edx = trainingBall.x - enemy.x, edy = trainingBall.y - enemy.y;
      const ed = Math.hypot(edx, edy);
      if (ed < 150 && enemy.swingCooldown <= 0 && !enemy.hitThisSwing) {
        // SWING_INIT
        const toBall   = Math.atan2(trainingBall.y - enemy.y, trainingBall.x - enemy.x);
        const toPlayer = Math.atan2(player.y - enemy.y, player.x - enemy.x);
        const cwMid   = toBall + Math.PI * (1 / 3);
        const ccwMid  = toBall - Math.PI * (1 / 3);
        const cwDiff  = normalizeAngle(toPlayer - cwMid);
        const ccwDiff = normalizeAngle(toPlayer - ccwMid);
        enemy.swingDir = Math.abs(cwDiff) < Math.abs(ccwDiff) ? 1 : -1;
        enemy.swingStartAngle = toBall;
        enemy.swingProgress = 0;
        enemy.hitThisSwing = false;
        enemy.vx = 0; enemy.vy = 0;
        const seg0 = _getEnemyBatSegment(enemy, toBall);
        enemy.prevBatBase = { x: seg0.bx, y: seg0.by };
        enemy.prevBatTip  = { x: seg0.tx, y: seg0.ty };
      } else {
        // CHASE
        if (ed > 0.1) {
          enemy.vx = (edx / ed) * ENEMY_SPEED;
          enemy.vy = (edy / ed) * ENEMY_SPEED;
          enemy.angle = Math.atan2(edy, edx);
        }
      }
    }

    // Wall repulsion
    const repulse = 180;
    if (enemy.x - TRN_L < 60) enemy.vx += repulse * dt;
    if (TRN_R - enemy.x < 60) enemy.vx -= repulse * dt;
    if (enemy.y - TRN_T < 60) enemy.vy += repulse * dt;
    if (TRN_B - enemy.y < 60) enemy.vy -= repulse * dt;
    for (const rect of TRN_RECTS) {
      const el = rect.x - 60, er = rect.x + rect.w + 60;
      const et = rect.y - 60, eb = rect.y + rect.h + 60;
      if (enemy.x > el && enemy.x < er && enemy.y > et && enemy.y < eb) {
        const dl = enemy.x - el, dr = er - enemy.x;
        const dt2 = enemy.y - et, db2 = eb - enemy.y;
        const minH = Math.min(dl, dr), minV = Math.min(dt2, db2);
        if (minH < minV) enemy.vx += (dl < dr ? -repulse : repulse) * dt;
        else             enemy.vy += (dt2 < db2 ? -repulse : repulse) * dt;
      }
    }

    // Friction + integrate
    enemy.vx *= Math.pow(0.85, dt * 60);
    enemy.vy *= Math.pow(0.85, dt * 60);
    enemy.x += enemy.vx * dt;
    enemy.y += enemy.vy * dt;
    enemy.x = clamp(enemy.x, TRN_L + enemy.radius, TRN_R - enemy.radius);
    enemy.y = clamp(enemy.y, TRN_T + enemy.radius, TRN_B - enemy.radius);
    pushOutOfTrainingRects(enemy);

    if (enemy.swingCooldown > 0) enemy.swingCooldown -= dt;
  }

  // Remove dead enemies
  for (let i = trnEnemies.length - 1; i >= 0; i--) {
    if (trnEnemies[i].splatTimer >= 0.4) trnEnemies.splice(i, 1);
  }

  // Handle spawn button click
  checkTrainingSpawnClick();
}

// ── Draw (world-space content only) ─────────────
function drawTraining() {
  if (shakeTimer > 0) {
    const sx = (Math.random() - 0.5) * shakeIntensity * 2;
    const sy = (Math.random() - 0.5) * shakeIntensity * 2;
    ctx.translate(sx, sy);
  }

  // Background beyond map (visible when zoomed out)
  ctx.fillStyle = '#A07850';
  ctx.fillRect(-500, -500, WW + 1000, WH + 1000);

  // Floor
  ctx.fillStyle = '#A8D8B0';
  ctx.fillRect(0, 0, WW, WH);
  ctx.fillStyle = floorPat || '#7DCEA0';
  ctx.fillRect(TRN_L, TRN_T, TRN_R - TRN_L, TRN_B - TRN_T);

  // Walls
  const _M = 500;
  ctx.fillStyle = '#D4A574'; ctx.fillRect(-_M, -_M, WW + _M * 2, TRN_T + _M);
  ctx.fillStyle = '#E8C9A0'; ctx.fillRect(-_M, TRN_T - 7, WW + _M * 2, 7);
  ctx.fillStyle = '#A07850'; ctx.fillRect(-_M, TRN_B, WW + _M * 2, WH - TRN_B + _M);
  ctx.fillStyle = '#D4A574'; ctx.fillRect(-_M, TRN_B, WW + _M * 2, 7);
  ctx.fillStyle = '#A07850'; ctx.fillRect(-_M, -_M, TRN_L + _M, WH + _M * 2);
  ctx.fillStyle = '#D4A574'; ctx.fillRect(TRN_L - 6, -_M, 6, WH + _M * 2);
  ctx.fillStyle = '#A07850'; ctx.fillRect(TRN_R, -_M, WW - TRN_R + _M, WH + _M * 2);
  ctx.fillStyle = '#D4A574'; ctx.fillRect(TRN_R, -_M, 6, WH + _M * 2);

  // Corner pillars
  const P = 20;
  ctx.fillStyle = '#C19A6B';
  [[TRN_L - 2, TRN_T - 2], [TRN_R - P + 2, TRN_T - 2], [TRN_L - 2, TRN_B - P + 2], [TRN_R - P + 2, TRN_B - P + 2]].forEach(([px, py]) => {
    ctx.beginPath(); ctx.roundRect(px, py, P, P, 5); ctx.fill();
    ctx.save(); ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.roundRect(px + 2, py + 2, P - 8, P / 2 - 2, 3); ctx.fill();
    ctx.restore();
  });

  // Training obstacles
  for (const r of TRN_RECTS) {
    ctx.save(); ctx.globalAlpha = 0.2; ctx.fillStyle = 'rgba(80,40,20,0.6)';
    ctx.beginPath(); ctx.roundRect(r.x + 3, r.y + r.h - 3, r.w, 8, 4); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#B0846A'; ctx.strokeStyle = '#8B6550'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#D4A88C';
    ctx.beginPath(); ctx.roundRect(r.x + 3, r.y + 3, r.w - 6, 14, [6, 6, 0, 0]); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.roundRect(r.x + 4, r.y + 4, r.w * 0.4, r.h * 0.3, 4); ctx.fill();
  }

  // Subtle guide lines
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  ctx.setLineDash([8, 12]);
  ctx.beginPath(); ctx.moveTo(TRN_L + 20, WH / 2); ctx.lineTo(TRN_R - 20, WH / 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(WW / 2, TRN_T + 20); ctx.lineTo(WW / 2, TRN_B - 20); ctx.stroke();
  ctx.setLineDash([]); ctx.restore();

  // ── Debug: swept quad overlay ──
  if (TRN_DEBUG && debugSweptQuad) {
    const q = debugSweptQuad;
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = 'yellow';
    ctx.beginPath();
    ctx.moveTo(q.prevBase.x, q.prevBase.y);
    ctx.lineTo(q.prevTip.x, q.prevTip.y);
    ctx.lineTo(q.currTip.x, q.currTip.y);
    ctx.lineTo(q.currBase.x, q.currBase.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Impact flashes
  for (const f of impactFlashes) {
    ctx.save();
    ctx.globalAlpha = f.alpha;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(f.x, f.y, f.radius, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // Ball trail
  for (const t of trainingBall.trail) {
    ctx.save();
    ctx.globalAlpha = t.alpha * 0.4;
    ctx.fillStyle = '#F39C12';
    ctx.beginPath(); ctx.arc(t.x, t.y, trainingBall.radius * 0.7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Ball
  ctx.save();
  ctx.translate(trainingBall.x, trainingBall.y);
  if (trainingBall.squash < 1) {
    ctx.rotate(trainingBall.squashAngle);
    const stretchAlong = 1 + (1 - trainingBall.squash) * 0.8;
    ctx.scale(stretchAlong, trainingBall.squash);
  }
  ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = 'rgba(60,30,15,0.7)';
  ctx.beginPath(); ctx.ellipse(4, 4, trainingBall.radius, trainingBall.radius * 0.6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#F39C12';
  ctx.beginPath(); ctx.arc(0, 0, trainingBall.radius, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.ellipse(-4, -5, trainingBall.radius * 0.4, trainingBall.radius * 0.3, -0.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.restore();

  // Bounce particles
  for (const p of bounceParticles) {
    ctx.save();
    ctx.globalAlpha = (p.life / p.maxLife) * 0.5;
    ctx.fillStyle = '#D4A574';
    ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ── Enemies ──
  for (const enemy of trnEnemies) {
    ctx.save();
    if (enemy.splatTimer >= 0) {
      const t = enemy.splatTimer / 0.4;
      ctx.globalAlpha = 1 - t;
      ctx.translate(enemy.x, enemy.y);
      ctx.scale(1 + t * 1.25, 1 + t * 1.25);
      ctx.translate(-enemy.x, -enemy.y);
    }
    // Drop shadow
    ctx.save(); ctx.globalAlpha *= 0.25;
    ctx.fillStyle = 'rgba(60,20,20,0.7)';
    ctx.beginPath(); ctx.ellipse(enemy.x + 3, enemy.y + 16, 22, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Body
    ctx.fillStyle = enemy.color;
    ctx.beginPath(); ctx.arc(enemy.x, enemy.y, enemy.radius, 0, Math.PI * 2); ctx.fill();
    // Highlight
    ctx.save(); ctx.globalAlpha *= 0.35; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(enemy.x - 6, enemy.y - 7, enemy.radius * 0.45, enemy.radius * 0.3, -0.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Flash overlay
    if (enemy.flashTimer > 0) {
      ctx.save();
      ctx.globalAlpha = (enemy.flashTimer / 0.2) * 0.6;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(enemy.x, enemy.y, enemy.radius, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // Eyes (same as player, substituting enemy.x/y/angle)
    if (enemy.splatTimer < 0) {
      const ex2 = Math.cos(enemy.angle) * 6;
      const ey2 = Math.sin(enemy.angle) * 6;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(enemy.x + ex2 - 5, enemy.y + ey2 - 4, 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(enemy.x + ex2 + 5, enemy.y + ey2 - 4, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.arc(enemy.x + ex2 - 4 + Math.cos(enemy.angle) * 2, enemy.y + ey2 - 4 + Math.sin(enemy.angle) * 2, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(enemy.x + ex2 + 6 + Math.cos(enemy.angle) * 2, enemy.y + ey2 - 4 + Math.sin(enemy.angle) * 2, 2.5, 0, Math.PI * 2); ctx.fill();
    }
    // Bat
    if (enemy.splatTimer < 0) {
      const swingAngle = enemy.swingProgress >= 0
        ? enemy.swingStartAngle + enemy.swingDir * (enemy.swingProgress * Math.PI * 2 / 3)
        : enemy.angle;
      ctx.save();
      ctx.translate(enemy.x, enemy.y);
      ctx.rotate(swingAngle);
      // Grip connector
      ctx.fillStyle = enemy.color;
      ctx.beginPath(); ctx.ellipse(enemy.radius + 5, 0, 7, 5, 0, 0, Math.PI * 2); ctx.fill();
      // Bat body
      const batX = enemy.radius + 10;
      ctx.fillStyle = '#D4A574';
      ctx.beginPath(); ctx.roundRect(batX, -ENEMY_BAT_WIDTH / 2, ENEMY_BAT_LENGTH, ENEMY_BAT_WIDTH, 6); ctx.fill();
      ctx.fillStyle = '#A07850';
      ctx.beginPath(); ctx.roundRect(batX, -ENEMY_BAT_WIDTH / 2 + 2, 10, ENEMY_BAT_WIDTH - 4, 3); ctx.fill();
      ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.roundRect(batX + ENEMY_BAT_LENGTH - 14, -ENEMY_BAT_WIDTH / 2 + 2, 12, ENEMY_BAT_WIDTH / 2 - 1, 4); ctx.fill();
      ctx.restore();
      ctx.restore();
    }
    // Health bar
    if (enemy.splatTimer < 0) {
      const barW = 40, barH = 5;
      const bx2 = enemy.x - barW / 2, by2 = enemy.y - enemy.radius - 14;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.roundRect(bx2, by2, barW, barH, 2); ctx.fill();
      ctx.fillStyle = '#E74C3C'; ctx.beginPath(); ctx.roundRect(bx2, by2, barW * (enemy.hp / enemy.maxHp), barH, 2); ctx.fill();
    }
    ctx.restore();
  }

  // Player ghosts
  for (const g of player.ghosts) {
    ctx.save();
    ctx.globalAlpha = g.alpha * 0.3;
    ctx.fillStyle = myPlayerColor;
    ctx.beginPath(); ctx.arc(g.x, g.y, player.radius, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Player blob
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.save(); ctx.globalAlpha = 0.2; ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath(); ctx.ellipse(3, player.rolling ? 20 : 16, 22, 7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  const bsx = player.rolling ? 1.3 : 1;
  const bsy = player.rolling ? 0.8 : 1;
  ctx.save(); ctx.scale(bsx, bsy);
  ctx.fillStyle = myPlayerColor;
  ctx.beginPath(); ctx.arc(0, 0, player.radius, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Eyes
  if (!player.rolling) {
    const ex = Math.cos(player.angle) * 6;
    const ey = Math.sin(player.angle) * 6;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(ex - 5, ey - 4, 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + 5, ey - 4, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(ex - 4 + Math.cos(player.angle) * 2, ey - 4 + Math.sin(player.angle) * 2, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + 6 + Math.cos(player.angle) * 2, ey - 4 + Math.sin(player.angle) * 2, 2.5, 0, Math.PI * 2); ctx.fill();
  }

  // Bat
  if (!player.rolling) {
    ctx.save();
    ctx.rotate(player.angle);
    ctx.fillStyle = myPlayerColor;
    ctx.beginPath(); ctx.ellipse(player.radius + 5, 0, 7, 5, 0, 0, Math.PI * 2); ctx.fill();
    const batX = player.radius + 10;
    ctx.fillStyle = '#D4A574';
    ctx.beginPath(); ctx.roundRect(batX, -bat.width / 2, bat.length, bat.width, 6); ctx.fill();
    ctx.fillStyle = '#A07850';
    ctx.beginPath(); ctx.roundRect(batX, -bat.width / 2 + 2, 10, bat.width - 4, 3); ctx.fill();
    ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.roundRect(batX + bat.length - 14, -bat.width / 2 + 2, 12, bat.width / 2 - 1, 4); ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  ctx.restore(); // player translate

  // ── Debug: hit direction line ──
  if (TRN_DEBUG && debugHitLine) {
    ctx.save();
    ctx.strokeStyle = 'red';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(debugHitLine.cx, debugHitLine.cy);
    ctx.lineTo(debugHitLine.cx + debugHitLine.dx * 60, debugHitLine.cy + debugHitLine.dy * 60);
    ctx.stroke();
    // Dot at contact point
    ctx.fillStyle = 'red';
    ctx.beginPath(); ctx.arc(debugHitLine.cx, debugHitLine.cy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// ── Draw HUD (screen-space) ─────────────────────
function drawTrainingHUD() {
  // BACK button
  ctx.save();
  ctx.globalAlpha = 0.2; ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath(); ctx.roundRect(22, 23, 90, 30, 10); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(40,40,40,0.55)';
  ctx.beginPath(); ctx.roundRect(20, 20, 90, 30, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(20, 20, 90, 30, 10); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 13px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('← BACK', 65, 40);
  ctx.restore();

  // +ENEMY button
  const atMax = trnEnemies.length >= ENEMY_MAX_COUNT;
  ctx.save();
  ctx.globalAlpha = atMax ? 0.4 : 1;
  ctx.globalAlpha *= 0.2; ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath(); ctx.roundRect(127, 23, 90, 30, 10); ctx.fill();
  ctx.globalAlpha = atMax ? 0.4 : 1;
  ctx.fillStyle = 'rgba(40,40,80,0.6)';
  ctx.beginPath(); ctx.roundRect(125, 20, 90, 30, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(121,134,203,0.4)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(125, 20, 90, 30, 10); ctx.stroke();
  ctx.fillStyle = '#9FA8DA'; ctx.font = 'bold 13px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('+ ENEMY', 170, 40);
  ctx.restore();

  // Mode label
  ctx.save();
  ctx.fillStyle = 'rgba(200,160,100,0.5)';
  ctx.font = 'bold 14px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('TRAINING GROUNDS', WW / 2, 35);
  ctx.restore();

  // ── Momentum bar ──
  const barW = 300, barH = 28;
  const barX = (WW - barW) / 2;
  const barY = WH - 65;
  const pct = momentumDisplay / 100;

  ctx.save();
  ctx.fillStyle = 'rgba(220,200,170,0.7)';
  ctx.font = 'bold 12px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('MOMENTUM', WW / 2, barY - 6);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = '#2C3E50';
  ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, barH / 2); ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH / 2, [barH / 2, barH / 2, 0, 0]); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, barH / 2); ctx.stroke();

  if (pct > 0.01) {
    const fillW = Math.max(barH, barW * pct);
    const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    grad.addColorStop(0, '#3498DB');
    grad.addColorStop(0.5, '#F39C12');
    grad.addColorStop(1, '#E74C3C');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(barX, barY, fillW, barH, barH / 2); ctx.fill();

    ctx.save();
    ctx.beginPath(); ctx.roundRect(barX, barY, fillW, barH, barH / 2); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.roundRect(barX + 4, barY + 2, fillW - 8, barH / 2 - 2, barH / 4); ctx.fill();
    ctx.restore();
  }

  if (momentumDisplay > 95) {
    const glowAlpha = 0.15 + 0.15 * Math.sin(performance.now() / 200);
    ctx.save();
    ctx.shadowColor = '#E74C3C';
    ctx.shadowBlur = 20;
    ctx.globalAlpha = glowAlpha;
    ctx.strokeStyle = '#E74C3C'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(barX - 2, barY - 2, barW + 4, barH + 4, barH / 2 + 2); ctx.stroke();
    ctx.restore();
  }

  ctx.restore();

  // Controls hint
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.font = '11px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('WASD: Move  |  Swing Bat Into Ball  |  Space: Roll', WW / 2, WH - 20);
  ctx.restore();
}

// ── Handle back button click ────────────────────
function checkTrainingBackClick() {
  if (mouse.justDown && mouse.screenX < 130 && mouse.screenY < 60) {
    return true;
  }
  return false;
}

// ── Spawn one enemy — callable from button or click ──
function trnSpawnEnemy() {
  if (trnEnemies.length >= ENEMY_MAX_COUNT) return;
  let ex, ey;
  let best = null, bestDist = -1;
  for (let attempt = 0; attempt < 10; attempt++) {
    const θ = Math.random() * Math.PI * 2;
    let tx = WW / 2 + Math.cos(θ) * (WW / 2 - 120);
    let ty = WH / 2 + Math.sin(θ) * (WH / 2 - 120);
    tx = clamp(tx, TRN_L + 80, TRN_R - 80);
    ty = clamp(ty, TRN_T + 80, TRN_B - 80);
    const d = Math.hypot(tx - player.x, ty - player.y);
    if (d >= 300) { ex = tx; ey = ty; break; }
    if (d > bestDist) { bestDist = d; best = { x: tx, y: ty }; }
  }
  if (ex === undefined && best) { ex = best.x; ey = best.y; }
  if (ex === undefined) return;

  const angle = Math.atan2(trainingBall.y - ey, trainingBall.x - ex);
  const seg = _getEnemyBatSegment({ x: ex, y: ey, radius: 26 }, angle);
  trnEnemies.push({
    x: ex, y: ey,
    vx: 0, vy: 0,
    radius: 26,
    angle,
    hp: ENEMY_MAX_HP, maxHp: ENEMY_MAX_HP,
    flashTimer: 0,
    splatTimer: -1,
    swingCooldown: 0,
    swingProgress: -1,
    swingStartAngle: 0,
    swingDir: 1,
    prevBatBase: { x: seg.bx, y: seg.by },
    prevBatTip:  { x: seg.tx, y: seg.ty },
    hitThisSwing: false,
    color: '#E74C3C',
  });
}

// ── Handle spawn enemy button click (canvas HUD) ─
function checkTrainingSpawnClick() {
  // Button drawn at canvas-space x=125,y=20,w=90,h=30
  if (mouse.justDown && mouse.screenX >= 125 && mouse.screenX <= 215 && mouse.screenY >= 20 && mouse.screenY <= 50) {
    trnSpawnEnemy();
  }
}
