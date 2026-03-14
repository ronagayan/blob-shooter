
// ────────────────────────────────────────────────
//  DRAWING  (appended as separate module)
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
    t.fillRect(Math.random()*TILE, Math.random()*TILE, 3+Math.random()*5, 2+Math.random()*5);
  floorPat = ctx.createPattern(tc, 'repeat');
}

// ── Weapon shape (procedural) ────────────────────
function drawWeaponShape(cx, cy, w, h, id) {
  const def = WEAPONS.find(x => x.id === id);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
  if (id === 'pistol') {
    ctx.fillStyle = def.color;
    ctx.beginPath(); ctx.roundRect(-w*0.22, -h*0.36, w*0.78, h*0.44, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.accent;
    ctx.beginPath(); ctx.roundRect(-w*0.18, h*0.05, w*0.3, h*0.44, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.accent;
    ctx.beginPath(); ctx.roundRect(w*0.28, -h*0.28, w*0.22, h*0.26, 2); ctx.fill(); ctx.stroke();
  } else if (id === 'smg') {
    ctx.fillStyle = def.color;
    ctx.beginPath(); ctx.roundRect(-w*0.25, -h*0.28, w*0.9, h*0.38, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.accent;
    ctx.beginPath(); ctx.roundRect(-w*0.08, h*0.08, w*0.22, h*0.46, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.accent;
    ctx.beginPath(); ctx.roundRect(-w*0.27, -h*0.2, w*0.12, h*0.25, 3); ctx.fill(); ctx.stroke();
  } else { // shotgun
    ctx.fillStyle = def.color;
    ctx.beginPath(); ctx.roundRect(-w*0.25, -h*0.42, w*0.98, h*0.32, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = def.accent;
    ctx.beginPath(); ctx.roundRect(-w*0.25, -h*0.05, w*0.98, h*0.32, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7a3e0a';
    ctx.beginPath(); ctx.roundRect(-w*0.28, -h*0.14, w*0.18, h*0.54, 4); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

// ── Blob body (symmetric – no rotation) ─────────
function drawBlobBody(x, y, r, sx, sy) {
  ctx.save(); ctx.translate(x, y); ctx.scale(sx, sy);
  // shadow
  ctx.save(); ctx.globalAlpha = 0.28; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(4, r*0.72, r*0.78, r*0.26, 0, 0, Math.PI*2); ctx.fill(); ctx.restore();
  // dark rim
  ctx.fillStyle = '#165010';
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.fill();
  // body gradient
  const g = ctx.createRadialGradient(-r*0.28, -r*0.28, r*0.04, 0, 0, r*0.96);
  g.addColorStop(0, '#c8ff55'); g.addColorStop(0.46, '#55cc22'); g.addColorStop(1, '#1f8010');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r*0.96, 0, Math.PI*2); ctx.fill();
  // gloss
  ctx.save(); ctx.globalAlpha = 0.52;
  const gl = ctx.createRadialGradient(-r*0.3, -r*0.32, 0, -r*0.2, -r*0.2, r*0.52);
  gl.addColorStop(0, 'rgba(255,255,255,0.9)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl; ctx.beginPath(); ctx.ellipse(-r*0.14, -r*0.17, r*0.44, r*0.33, -0.4, 0, Math.PI*2); ctx.fill(); ctx.restore();
  // eyes
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(-r*0.3, -r*0.2, r*0.14, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( r*0.3, -r*0.2, r*0.14, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = 'white';
  ctx.beginPath(); ctx.arc(-r*0.25, -r*0.25, r*0.055, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( r*0.35, -r*0.25, r*0.055, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

// ── Target ───────────────────────────────────────
function drawTarget(tgt) {
  if (!tgt.alive) return;
  ctx.save();
  ctx.translate(tgt.x, tgt.y);
  ctx.rotate(Math.sin(performance.now()/40) * tgt.wobble * 0.018);
  const r = tgt.w / 2, sh = tgt.h - tgt.w;
  // shadow
  ctx.save(); ctx.globalAlpha = 0.22; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(0, r+sh+6, r*0.5, 9, 0, 0, Math.PI*2); ctx.fill(); ctx.restore();
  // pole & base
  ctx.fillStyle = '#7a5a10'; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(-5, r, 10, sh, 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#5a4208';
  ctx.beginPath(); ctx.roundRect(-20, r+sh-7, 40, 13, 3); ctx.fill(); ctx.stroke();
  if (tgt.flashTimer > 0) ctx.filter = 'brightness(2.8)';
  // rings
  const RC = ['#fff','#111','#1155dd','#ff2200','#ff2200','#111'];
  for (let i = RC.length-1; i >= 0; i--) {
    ctx.fillStyle = RC[i]; ctx.beginPath(); ctx.arc(0, 0, r*((i+1)/RC.length), 0, Math.PI*2); ctx.fill();
  }
  ctx.fillStyle = '#ff0000'; ctx.beginPath(); ctx.arc(0, 0, r*0.11, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 0.8;
  for (let i=1; i<RC.length; i++) { ctx.beginPath(); ctx.arc(0,0,r*(i/RC.length),0,Math.PI*2); ctx.stroke(); }
  ctx.filter = 'none';
  // HP bar
  const pct = tgt.hp / tgt.maxHp;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath(); ctx.roundRect(-r,-r-18,r*2,7,3); ctx.fill();
  ctx.fillStyle = `hsl(${pct*110},80%,50%)`;
  ctx.beginPath(); ctx.roundRect(-r,-r-18,r*2*pct,7,3); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = 'bold 11px Segoe UI,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`Hits: ${tgt.hits}`, 0, -r-26);
  ctx.restore();
}

// ── Moving target rail ───────────────────────────
function drawRail() {
  const mt = movingTarget;
  const x1 = mt.baseX - mt.railHalfW - 18, x2 = mt.baseX + mt.railHalfW + 18, y = mt.baseY;
  ctx.save();
  ctx.fillStyle = '#4a5a6a'; ctx.strokeStyle = '#2a3a4a'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(x1, y-4, x2-x1, 8, 3); ctx.fill(); ctx.stroke();
  ctx.globalAlpha = 0.3; ctx.fillStyle = '#aaccdd';
  ctx.beginPath(); ctx.roundRect(x1+4, y-2, x2-x1-8, 3, 2); ctx.fill();
  ctx.restore();
}

// ── Player ───────────────────────────────────────
function drawPlayer() {
  const r = player.radius;
  // ghost trail
  for (const g of player.ghosts) {
    ctx.save(); ctx.globalAlpha = g.alpha * 0.4;
    const gg = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, r*1.1);
    gg.addColorStop(0, '#88ff44'); gg.addColorStop(1, 'rgba(40,200,0,0)');
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(g.x, g.y, r*1.1, 0, Math.PI*2); ctx.fill(); ctx.restore();
  }
  // squash during roll
  let sx = 1, sy = 1;
  if (player.rolling) {
    const p = 1 - player.rollTimer / player.rollDuration;
    const f = Math.sin(p * Math.PI);
    sx = 1 + f * 0.38; sy = 1 - f * 0.22;
  }
  drawBlobBody(player.x, player.y, r, sx, sy);
  if (!player.rolling) {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.angle);
    ctx.translate(-player.recoilOffset * 0.55, 0);
    // arm
    const ag = ctx.createRadialGradient(r*0.62, 0, 2, r*0.62, 0, r*0.4);
    ag.addColorStop(0, '#88ee44'); ag.addColorStop(1, '#22660e');
    ctx.fillStyle = ag; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(r*0.72, 0, r*0.4, r*0.25, 0, 0, Math.PI*2); ctx.fill(); ctx.stroke();
    drawWeaponShape(r*0.85 + 23, 0, 46, 22, weapons[player.weaponIndex].id);
    ctx.restore();
  }
  // roll cooldown arc
  if (player.rollCooldown > 0 || player.rolling) {
    const pct = 1 - player.rollCooldown / player.rollCooldownMax;
    ctx.save(); ctx.translate(player.x, player.y + r + 11);
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.globalAlpha = 0.8;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(0, 0, 8, -Math.PI/2, Math.PI*1.5); ctx.stroke();
    ctx.strokeStyle = '#44aaff';
    ctx.beginPath(); ctx.arc(0, 0, 8, -Math.PI/2, -Math.PI/2 + Math.PI*2*pct); ctx.stroke();
    ctx.restore();
  }
}

// ── Pickups ──────────────────────────────────────
function drawPickups() {
  for (const p of pickups) {
    const w = WEAPONS[p.wi], pulse = Math.sin(p.pulse)*0.12+0.88, active = player.weaponIndex===p.wi, r = 30;
    ctx.save(); ctx.translate(p.x, p.y);
    ctx.save(); ctx.globalAlpha = 0.18+Math.sin(p.pulse)*0.07;
    ctx.strokeStyle = w.color; ctx.lineWidth = 3; ctx.shadowColor = w.color; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(0,0,r+5,0,Math.PI*2); ctx.stroke(); ctx.restore();
    ctx.fillStyle = active ? w.color+'33' : 'rgba(18,28,18,0.85)';
    ctx.strokeStyle = w.color; ctx.lineWidth = 2;
    ctx.shadowColor = w.color; ctx.shadowBlur = active ? 16 : 5;
    ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0; ctx.scale(pulse, pulse); drawWeaponShape(0, 0, 38, 18, w.id); ctx.restore();
    ctx.fillStyle = active ? w.color : 'rgba(255,255,255,0.5)';
    ctx.font = `bold ${active?13:11}px Segoe UI,sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(w.name, p.x, p.y+r+17);
    ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.font='10px Segoe UI,sans-serif';
    ctx.fillText(active?'✓ active':'walk near', p.x, p.y+r+30);
  }
}

// ── Bullets & FX ─────────────────────────────────
function drawBullets() {
  for (const b of bullets) {
    const tl = b.trail.length;
    for (let i = 0; i < tl; i++) {
      const t = b.trail[i];
      ctx.save(); ctx.globalAlpha = (i/tl)*0.45; ctx.fillStyle = b.tcol;
      ctx.beginPath(); ctx.arc(t.x, t.y, b.rad*(i/tl)*0.7, 0, Math.PI*2); ctx.fill(); ctx.restore();
    }
    ctx.save(); ctx.shadowColor = b.col; ctx.shadowBlur = 12; ctx.fillStyle = b.col;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.rad, 0, Math.PI*2); ctx.fill(); ctx.restore();
  }
}
function drawParticles() {
  for (const p of particles) {
    const a = p.life/p.maxLife;
    ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = p.col;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.rad*a, 0, Math.PI*2); ctx.fill(); ctx.restore();
  }
}
function drawFlashes() {
  for (const f of flashes) {
    const a = f.life/f.maxLife;
    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.angle); ctx.globalAlpha = a;
    ctx.shadowColor = f.col; ctx.shadowBlur = 20;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(12,0,20,7,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = f.col; ctx.beginPath(); ctx.arc(0,0,7,0,Math.PI*2); ctx.fill(); ctx.restore();
  }
}

// ── Room ─────────────────────────────────────────
function drawRoom() {
  ctx.fillStyle = '#0c1618'; ctx.fillRect(0, 0, WW, WH);
  ctx.fillStyle = floorPat || '#263323'; ctx.fillRect(IL, IT, IR-IL, IB-IT);
  // vignette
  const vPairs = [[IL,IT,IL+50,IT],[IR,IT,IR-50,IT],[IL,IT,IL,IT+50],[IL,IB,IL,IB-50]];
  for (const [x1,y1,x2,y2] of vPairs) {
    const g = ctx.createLinearGradient(x1,y1,x2,y2);
    g.addColorStop(0,'rgba(0,0,0,0.36)'); g.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=g; ctx.fillRect(IL,IT,IR-IL,IB-IT);
  }
  // walls
  ctx.fillStyle='#1c3248'; ctx.fillRect(0,0,WW,IT);
  ctx.fillStyle='#2a4860'; ctx.fillRect(0,IT-7,WW,7);
  ctx.fillStyle='#131e28'; ctx.fillRect(0,IB,WW,WH-IB);
  ctx.fillStyle='#223045'; ctx.fillRect(0,IB,WW,7);
  ctx.fillStyle='#182a3c'; ctx.fillRect(0,0,IL,WH);
  ctx.fillStyle='#254055'; ctx.fillRect(IL-6,0,6,WH);
  ctx.fillStyle='#141e2c'; ctx.fillRect(IR,0,WW-IR,WH);
  ctx.fillStyle='#202d42'; ctx.fillRect(IR,0,6,WH);
  // pillars
  const P = 20; ctx.fillStyle='#385065';
  [[IL-2,IT-2],[IR-P+2,IT-2],[IL-2,IB-P+2],[IR-P+2,IB-P+2]].forEach(([px,py])=>ctx.fillRect(px,py,P,P));
  // guide lines
  ctx.save(); ctx.strokeStyle='rgba(255,255,255,0.04)'; ctx.lineWidth=1; ctx.setLineDash([8,12]);
  ctx.beginPath(); ctx.moveTo(IL+20,WH/2); ctx.lineTo(IR-20,WH/2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(WW/2,IT+20); ctx.lineTo(WW/2,IB-20); ctx.stroke();
  ctx.setLineDash([]); ctx.restore();
}

// ── Inventory ────────────────────────────────────
function drawInventory() {
  if (!INV.open) return;
  const { panX, panY, panW, panH, gx, gy } = invLayout();
  ctx.fillStyle = 'rgba(0,0,0,0.74)'; ctx.fillRect(0,0,WW,WH);
  // panel
  ctx.fillStyle = '#141c22'; ctx.strokeStyle = '#263545'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(panX,panY,panW,panH,10); ctx.fill(); ctx.stroke();
  // title bar
  ctx.fillStyle = '#1c2c38';
  ctx.beginPath(); ctx.roundRect(panX,panY,panW,46,[10,10,0,0]); ctx.fill();
  ctx.fillStyle = '#44aacc'; ctx.font = 'bold 17px Segoe UI,sans-serif';
  ctx.textAlign='left'; ctx.fillText('INVENTORY', panX+16, panY+30);
  ctx.fillStyle='rgba(255,255,255,0.28)'; ctx.font='12px Segoe UI,sans-serif';
  ctx.textAlign='right'; ctx.fillText('TAB to close', panX+panW-14, panY+30);

  // grid cells
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cx = gx+c*CELL, cy = gy+r*CELL;
      ctx.fillStyle = INV.grid[r][c] ? 'rgba(50,80,50,0.28)' : 'rgba(255,255,255,0.03)';
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.rect(cx,cy,CELL,CELL); ctx.fill(); ctx.stroke();
    }
  }

  // placed items
  for (const [id, item] of Object.entries(INV.items)) {
    if (!item.placed) continue;
    const def = item.def;
    const ix = gx+item.gx*CELL+2, iy = gy+item.gy*CELL+2;
    const iw = def.gw*CELL-4, ih = def.gh*CELL-4;
    ctx.fillStyle = def.color+'33'; ctx.strokeStyle = def.color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(ix,iy,iw,ih,4); ctx.fill(); ctx.stroke();
    drawWeaponShape(ix+iw/2, iy+ih/2, iw*0.75, ih*0.75, id);
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font='bold 10px Segoe UI,sans-serif';
    ctx.textAlign='left'; ctx.fillText(def.name, ix+4, iy+ih-5);
    // size hint
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.font='9px Segoe UI,sans-serif';
    ctx.textAlign='right'; ctx.fillText(`${def.gw}x${def.gh}`, ix+iw-4, iy+12);
  }

  // dragged item follows mouse
  if (INV.drag) {
    const { id } = INV.drag;
    const def = INV.items[id].def;
    const dw = def.gw*CELL-4, dh = def.gh*CELL-4;
    const dx = mouse.x-dw/2, dy = mouse.y-dh/2;
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = def.color+'44'; ctx.strokeStyle = def.color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(dx,dy,dw,dh,4); ctx.fill(); ctx.stroke();
    drawWeaponShape(dx+dw/2, dy+dh/2, dw*0.75, dh*0.75, id);
    ctx.globalAlpha = 1;
  }
}

// ── Controls hint ─────────────────────────────────
function drawHint() {
  ctx.fillStyle='rgba(255,255,255,0.18)'; ctx.font='12px Segoe UI,sans-serif'; ctx.textAlign='left';
  ctx.fillText('WASD: Move  •  Click: Shoot  •  1/2/3: Weapon  •  R: Reload  •  Space: Roll  •  Tab: Inventory', IL+14, IT+22);
}

// ── Main draw ────────────────────────────────────
function draw() {
  ctx.save(); ctx.translate(shake.x, shake.y);
  drawRoom();
  drawRail();
  drawPickups();
  drawTarget(staticTarget);
  drawTarget(movingTarget);
  drawBullets();
  drawPlayer();
  drawFlashes();
  drawParticles();
  drawHint();
  ctx.restore();
  drawInventory();
}

// ── Loop ─────────────────────────────────────────
function loop(ts) { update(ts); draw(); requestAnimationFrame(loop); }
makeFloor();
updateHUD();
requestAnimationFrame(loop);
