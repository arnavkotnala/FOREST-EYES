/**
 * Earth Intelligence Platform — snap river lines onto the real water (water-snap.js)
 * ==================================================================================
 * HydroRIVERS centre-lines come from a ~450 m (15") flow grid, so close up they cut across
 * bends and can sit a few hundred metres off the channel. For drawing at high zoom, each line
 * is moved onto the actual water using the JRC Global Surface Water occurrence map
 * (Pekel et al. 2016, Landsat 1984-2021, 30 m; public tiles, EU Joint Research Centre):
 *
 *   1. add points every ~SPACING_M along the line
 *   2. at each point, sample across the line (±SEARCH_M) and find runs of permanent water
 *      (water present ≥ MIN_OCCURRENCE % of the time)
 *   3. move the point to the centre of the best run: wide and close wins, so in braided rivers
 *      the main channel beats a thin side channel (none found → leave it where it is)
 *   4. smooth the offsets a little and drop redundant points
 *
 * Only the drawing changes; every calculation still uses the original HydroRIVERS network.
 */
'use strict';

const { decodePngPixels } = require('./elevation.js');

const TILE_URL = (z, x, y) => `https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/${z}/${x}/${y}.png`;
const MAX_Z = 12;             // ~38 m per pixel at the equator (data is 30 m); less zoomed-in views use coarser tiles
const SPACING_M = 80;
const SEARCH_M = 1500;
const STEP_M = 30;
const MIN_OCCURRENCE = 50;    // %: permanent water, not occasional floods
const MAX_TILES = 300;        // 64 kB each

const tiles = new Map();      // "z/x/y" → Promise<Uint8Array occurrence 0-100 | null>

function tile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tiles.has(key)) {
    if (tiles.size >= MAX_TILES) tiles.delete(tiles.keys().next().value);
    const job = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(TILE_URL(z, x, y), { signal: AbortSignal.timeout(15000) });
          if (res.status === 404) return null; // no water anywhere in this tile
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const { width, height, bpp, px } = decodePngPixels(Buffer.from(await res.arrayBuffer()));
          // Palette: red = rarely water → blue = always water; transparent = never. Blue ≈ occurrence.
          const occ = new Uint8Array(width * height);
          for (let i = 0; i < occ.length; i++) {
            if (bpp === 4 && px[i * 4 + 3] === 0) continue;
            occ[i] = Math.round((px[i * bpp + 2] / 255) * 100);
          }
          return occ;
        } catch (err) {
          if (attempt === 1) throw err;
        }
      }
      return null;
    })();
    job.catch(() => tiles.delete(key));
    tiles.set(key, job);
  }
  return tiles.get(key);
}

function pixelOf(lat, lon, z) {
  const n = 2 ** z * 256;
  const s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

const mPerDegLat = 111320;
const kOf = lat => Math.cos(lat * Math.PI / 180);

function densify(line, spacingM = SPACING_M) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const d = Math.hypot((b[0] - a[0]) * mPerDegLat, (b[1] - a[1]) * mPerDegLat * kOf(a[0]));
    const n = Math.max(1, Math.ceil(d / spacingM));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}

/** Drops points closer than tolM to the line through their neighbours (Douglas–Peucker). */
function simplify(pts, tolM = 15) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const [a, b] = [pts[i0], pts[i1]];
    const k = kOf(a[0]);
    const ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0];
    let best = -1, bestD = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const px = pts[i][1] * k, py = pts[i][0];
      const dx = bx - ax, dy = by - ay;
      const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * mPerDegLat;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0 && bestD > tolM) { keep[best] = 1; stack.push([i0, best], [best, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * One polyline [[lat, lon], ...] → the same river, centred on its real water.
 * Memory-frugal: tiles are loaded first, then each point is processed on its own (no big
 * intermediate arrays — the server runs with a small memory limit).
 */
async function snapLine(line, spacingM = SPACING_M, z = MAX_Z) {
  if (line.length < 2) return line;
  const pts = densify(line, spacingM);
  const n = pts.length;
  // 1. load every tile the search can touch (each point's tile and its neighbours)
  const need = new Set();
  for (const [la, lo] of pts) {
    const [x, y] = pixelOf(la, lo, z);
    const tx = Math.floor(x / 256), ty = Math.floor(y / 256);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) need.add(`${tx + dx}/${ty + dy}`);
  }
  const loaded = new Map();
  await Promise.all([...need].map(async k => {
    const [tx, ty] = k.split('/').map(Number);
    loaded.set(k, await tile(z, tx, ty).catch(() => null));
  }));
  const occAt = (la, lo) => {
    const [x, y] = pixelOf(la, lo, z);
    const tx = Math.floor(x / 256), ty = Math.floor(y / 256);
    const t = loaded.get(`${tx}/${ty}`);
    return t ? t[Math.floor(y - ty * 256) * 256 + Math.floor(x - tx * 256)] : 0;
  };
  // 2. per point: nearest run of permanent water across the line → its centre
  const shift = new Float64Array(n);
  const found = new Uint8Array(n);
  const nN = new Float64Array(n), nE = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 2)], b = pts[Math.min(n - 1, i + 2)];
    const k = kOf(p[0]);
    const dx = (b[1] - a[1]) * k, dy = b[0] - a[0];
    const len = Math.hypot(dx, dy) || 1;
    nN[i] = dx / len; nE[i] = -dy / len; // perpendicular to the flow (north, east)
    let best = 0, bestDist = Infinity, bestScore = -Infinity, start = null, prev = 0;
    for (let m = -SEARCH_M; m <= SEARCH_M + STEP_M; m += STEP_M) {
      const wet = m <= SEARCH_M && occAt(p[0] + (nN[i] * m) / mPerDegLat, p[1] + (nE[i] * m) / (mPerDegLat * k)) >= MIN_OCCURRENCE;
      if (wet && start === null) start = m;
      if (!wet && start !== null) {
        const lo = start, hi = prev;
        const dist = lo <= 0 && hi >= 0 ? 0 : Math.min(Math.abs(lo), Math.abs(hi));
        const score = (hi - lo + STEP_M) / (1 + dist / 300); // width, discounted by distance
        if (dist <= 900 && score > bestScore) { bestScore = score; bestDist = dist; best = (lo + hi) / 2; }
        start = null;
      }
      prev = m;
    }
    if (bestDist <= 900) { shift[i] = best; found[i] = 1; }
  }
  // 3. gaps (no water seen) borrow a nearby shift briefly, then smooth
  const filled = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (found[i]) { filled[i] = shift[i]; continue; }
    for (let d = 1; d <= 3; d++) {
      if (i - d >= 0 && found[i - d]) { filled[i] = shift[i - d]; break; }
      if (i + d < n && found[i + d]) { filled[i] = shift[i + d]; break; }
    }
  }
  const moved = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, c = 0;
    for (let d = -4; d <= 4; d++) if (i + d >= 0 && i + d < n) { sum += filled[i + d]; c++; }
    const m = sum / c, p = pts[i];
    moved[i] = [+(p[0] + (nN[i] * m) / mPerDegLat).toFixed(5), +(p[1] + (nE[i] * m) / (mPerDegLat * kOf(p[0]))).toFixed(5)];
  }
  return simplify(moved);
}

/**
 * Snaps a network response in place. Water tiles one zoom finer than the map are plenty (each
 * map pixel then covers ~2 water pixels); the smallest streams (class 1) are narrower than the
 * 30 m water data, so they are left as they are. Lines run 8 at a time.
 */
async function snapNetwork(net, zoom = 12, bbox = null) {
  const z = Math.min(MAX_Z, zoom + 1);
  if (bbox) clipNetwork(net, bbox);
  const spacing = zoom >= 11 ? 80 : zoom === 10 ? 150 : 250;
  for (const cls of Object.keys(net.lines)) {
    if (cls === '1') continue;
    const lines = net.lines[cls];
    const out = new Array(lines.length);
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < lines.length) {
        const i = next++;
        out[i] = await snapLine(lines[i], spacing, z).catch(() => lines[i]);
      }
    }));
    net.lines[cls] = out;
  }
  net.snappedToWater = true;
  return net;
}

/**
 * Keeps only the parts of each line inside the box (plus a 5 % margin): the network query pads
 * its box by a degree so long rivers are complete, but snapping far-off parts is wasted work.
 */
function clipNetwork(net, [w, s, e, n]) {
  const mx = (e - w) * 0.05, my = (n - s) * 0.05;
  const inside = ([la, lo]) => lo >= w - mx && lo <= e + mx && la >= s - my && la <= n + my;
  for (const cls of Object.keys(net.lines)) {
    const out = [];
    for (const line of net.lines[cls]) {
      let run = [];
      for (let i = 0; i < line.length; i++) {
        // keep one point beyond each edge so the line still reaches the box border
        const keep = inside(line[i]) || (i > 0 && inside(line[i - 1])) || (i + 1 < line.length && inside(line[i + 1]));
        if (keep) run.push(line[i]);
        else if (run.length) { if (run.length > 1) out.push(run); run = []; }
      }
      if (run.length > 1) out.push(run);
    }
    net.lines[cls] = out;
  }
}

module.exports = { snapLine, snapNetwork };
