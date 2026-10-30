/**
 * Earth Intelligence Platform — global river network (rivers.js)
 * ===============================================================
 * Loads the files built by scripts/build-rivers.py from HydroRIVERS v1.0:
 *   data/hydrorivers.bin       attributes of each reach (catchment >= 1000 km2 worldwide,
 *                              >= 100 km2 in the India region)
 *   data/hydrorivers_geom.bin  each reach's shape (simplified to ~150 m)
 * and answers:
 *   nearest(lat, lon)          closest river reach and its attributes
 *   downstream(id, maxKm)      the river below a reach, following NEXT_DOWN
 *   traceAlong(sketch)         the real channel of a river sketched by a few points
 *   stretch(id)                the main channel up- and downstream of a reach
 *   network(bbox, zoom)        rivers to draw on a map at this zoom
 * Indexes are typed arrays (not Maps) so ~1 million reaches fit in a small server.
 * Data: Lehner & Grill (2013), HydroSHEDS — https://www.hydrosheds.org
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'hydrorivers.bin');
const GEOM_FILE = path.join(__dirname, 'data', 'hydrorivers_geom.bin');
const CELL = 0.25;                           // grid index cell size, degrees
const COLS = 360 / CELL, ROWS = 180 / CELL;
const MAJOR_KM2 = 1000;                      // "major river" = catchment of at least 1000 km2
const INDIA_BBOX = [68.0, 6.5, 97.5, 37.5];  // lon/lat box where small rivers are kept too

let db = null;

function load() {
  if (db) return db;
  const buf = fs.readFileSync(FILE);
  if (buf.toString('latin1', 0, 4) !== 'HYRV') throw new Error('hydrorivers.bin: bad header');
  const n = buf.readUInt32LE(8);
  let off = 12;
  const col = (Type, size) => {
    const arr = new Type(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * size));
    off += n * size;
    return arr;
  };
  const d = {
    n,
    id: col(Int32Array, 4), next: col(Int32Array, 4), main: col(Int32Array, 4),
    lengthKm: col(Float32Array, 4), distDnKm: col(Float32Array, 4),
    uplandKm2: col(Float32Array, 4), dischargeCms: col(Float32Array, 4),
    x0: col(Int32Array, 4), y0: col(Int32Array, 4), x1: col(Int32Array, 4), y1: col(Int32Array, 4),
    order: col(Uint8Array, 1),
  };

  // Reach shapes: offsets[n+1] into a flat lon/lat (×1e5) vertex array
  const g = fs.readFileSync(GEOM_FILE);
  if (g.toString('latin1', 0, 4) !== 'HYRG' || g.readUInt32LE(8) !== n) {
    throw new Error('hydrorivers_geom.bin: missing or does not match hydrorivers.bin');
  }
  const m = g.readUInt32LE(12);
  const gOff = g.byteOffset + 16;
  d.offsets = new Uint32Array(g.buffer.slice(gOff, gOff + (n + 1) * 4));
  d.xy = new Int32Array(g.buffer.slice(gOff + (n + 1) * 4, gOff + (n + 1) * 4 + m * 8));

  // id → row: ids sorted, with their rows, for binary search
  d.sortedRows = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => d.id[a] - d.id[b]);
  d.sortedIds = Int32Array.from(d.sortedRows, i => d.id[i]);
  d.rowOf = id => {
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, v = d.sortedIds[mid];
      if (v === id) return d.sortedRows[mid];
      if (v < id) lo = mid + 1; else hi = mid - 1;
    }
    return undefined;
  };
  d.nextRow = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (d.next[i]) {
      const r = d.rowOf(d.next[i]);
      if (r !== undefined) d.nextRow[i] = r;
    }
  }

  // Upstream children (CSR): kids of row p are upList[upStart[p] .. upStart[p+1])
  d.upStart = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) if (d.nextRow[i] >= 0) d.upStart[d.nextRow[i] + 1]++;
  for (let i = 0; i < n; i++) d.upStart[i + 1] += d.upStart[i];
  d.upList = new Uint32Array(d.upStart[n]);
  const upFill = d.upStart.slice(0, n);
  for (let i = 0; i < n; i++) if (d.nextRow[i] >= 0) d.upList[upFill[d.nextRow[i]]++] = i;
  d.kids = p => d.upList.subarray(d.upStart[p], d.upStart[p + 1]);

  // Spatial grid (CSR over 0.25° cells): every cell a reach's vertices touch
  const cellOf = (lat, lon) => Math.min(ROWS - 1, Math.max(0, Math.floor((lat + 90) / CELL))) * COLS +
    Math.min(COLS - 1, Math.max(0, Math.floor((lon + 180) / CELL)));
  const eachCell = (i, fn) => {
    let last = -1;
    for (let v = d.offsets[i]; v < d.offsets[i + 1]; v++) {
      const c = cellOf(d.xy[2 * v + 1] / 1e5, d.xy[2 * v] / 1e5);
      if (c !== last) { fn(c); last = c; }
    }
  };
  d.cellStart = new Uint32Array(COLS * ROWS + 1);
  for (let i = 0; i < n; i++) eachCell(i, c => { d.cellStart[c + 1]++; });
  for (let c = 0; c < COLS * ROWS; c++) d.cellStart[c + 1] += d.cellStart[c];
  d.cellList = new Uint32Array(d.cellStart[COLS * ROWS]);
  const cellFill = d.cellStart.slice(0, COLS * ROWS);
  for (let i = 0; i < n; i++) eachCell(i, c => { d.cellList[cellFill[c]++] = i; });

  // Reaches sorted by catchment, biggest first: map queries take a prefix of this list
  d.bySize = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => d.uplandKm2[b] - d.uplandKm2[a]);
  db = d;
  return d;
}

function available() {
  try { load(); return true; } catch { return false; }
}

/** Reach rows in grid cell (cy, cx); x wraps around the antimeridian. */
function cellRows(d, cy, cx) {
  if (cy < 0 || cy >= ROWS) return d.cellList.subarray(0, 0);
  const c = cy * COLS + (((cx % COLS) + COLS) % COLS);
  return d.cellList.subarray(d.cellStart[c], d.cellStart[c + 1]);
}

/** A reach's shape as [[lat, lon], ...] (upstream → downstream). */
function shape(d, i) {
  const out = [];
  for (let v = d.offsets[i]; v < d.offsets[i + 1]; v++) out.push([d.xy[2 * v + 1] / 1e5, d.xy[2 * v] / 1e5]);
  return out;
}

/** Distance (km) from a point to a reach's shape. */
function distToReachKm(d, i, lat, lon) {
  const k = Math.cos(lat * Math.PI / 180);
  const px = lon * k, py = lat;
  let best = Infinity;
  for (let v = d.offsets[i] + 1; v < d.offsets[i + 1]; v++) {
    const ax = d.xy[2 * v - 2] / 1e5 * k, ay = d.xy[2 * v - 1] / 1e5;
    const bx = d.xy[2 * v] / 1e5 * k, by = d.xy[2 * v + 1] / 1e5;
    const dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
    const dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (dist < best) best = dist;
  }
  return best * 111.32;
}

function describe(d, i) {
  return {
    id: d.id[i],
    mainRiverId: d.main[i],
    strahlerOrder: d.order[i],
    reachLengthKm: +d.lengthKm[i].toFixed(2),
    distanceToMouthKm: Math.round(d.distDnKm[i]),
    upstreamAreaKm2: Math.round(d.uplandKm2[i]),
    meanDischargeCms: +d.dischargeCms[i].toFixed(1), // long-term average, modelled (HydroSHEDS)
    start: [d.y0[i] / 1e5, d.x0[i] / 1e5],
    end: [d.y1[i] / 1e5, d.x1[i] / 1e5],
    shape: shape(d, i),
  };
}

/** Rows of all reaches within maxKm of a point (optionally only catchments >= minUpland). */
function within(lat, lon, maxKm, minUpland = 0) {
  const d = load();
  const r = Math.ceil(maxKm / (111 * CELL * Math.max(0.2, Math.cos(lat * Math.PI / 180)))) + 1;
  const cy = Math.floor((lat + 90) / CELL), cx = Math.floor((lon + 180) / CELL);
  const hits = new Set();
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      for (const i of cellRows(d, y, x)) {
        if (d.uplandKm2[i] >= minUpland && !hits.has(i) && distToReachKm(d, i, lat, lon) <= maxKm) hits.add(i);
      }
    }
  }
  return [...hits];
}

/** Closest reach within maxKm, or null. By default only major rivers (>= 1000 km2). */
function nearest(lat, lon, maxKm = 25, minUpland = MAJOR_KM2) {
  const d = load();
  let best = -1, bestKm = Infinity;
  for (const i of within(lat, lon, maxKm, minUpland)) {
    const km = distToReachKm(d, i, lat, lon);
    if (km < bestKm) { bestKm = km; best = i; }
  }
  if (best < 0) return null;
  return { ...describe(d, best), distanceKm: +bestKm.toFixed(2) };
}

/** Joins reach shapes into one path (dropping the shared point between reaches). */
function joinShapes(d, rows) {
  const out = [];
  for (const r of rows) {
    const s = shape(d, r);
    out.push(...(out.length ? s.slice(1) : s));
  }
  return out;
}

/** The river below `id` up to maxKm, as a path plus summary. */
function downstream(id, maxKm = 300) {
  const d = load();
  let i = d.rowOf(id);
  if (i === undefined) return null;
  const reaches = [];
  let km = 0;
  while (i !== undefined && km < maxKm && reaches.length < 5000) {
    reaches.push(i);
    km += d.lengthKm[i];
    i = d.nextRow[i] >= 0 ? d.nextRow[i] : undefined;
  }
  const last = reaches[reaches.length - 1];
  return {
    lengthKm: Math.round(km),
    reaches: reaches.length,
    endsAtMouth: i === undefined && d.next[last] === 0,
    dischargeAtEndCms: +d.dischargeCms[last].toFixed(1),
    path: joinShapes(d, reaches),
  };
}

/** Distance (km) from a point to a polyline [[lat, lon], ...]. */
function distToLineKm(lat, lon, line) {
  const k = Math.cos(lat * Math.PI / 180);
  let best = Infinity;
  for (let j = 1; j < line.length; j++) {
    const ax = line[j - 1][1] * k, ay = line[j - 1][0], bx = line[j][1] * k, by = line[j][0];
    const dx = bx - ax, dy = by - ay, px = lon * k, py = lat;
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * 111.32);
  }
  return best;
}

/**
 * Real channel geometry for a river given only a rough sketch of it (source → mouth).
 * Water only flows one way, so: snap each sketch point to the biggest river reach close by,
 * follow NEXT_DOWN to the sea, and cut the path where it passes closest to the sketch's end.
 * The sketches are rough, so keep traces that end near the sketch's end and broadly follow
 * it, and return the longest of those (i.e. the one starting nearest the source).
 */
function traceAlong(sketch, { snapKm = 12, matchKm = 40, minMatch = 0.6, endKm = 400 } = {}) {
  const d = load();
  const end = sketch[sketch.length - 1];
  const kmTo = ([la, lo], [la2, lo2]) => Math.hypot(la - la2, (lo - lo2) * Math.cos(la2 * Math.PI / 180)) * 111.32;
  let best = null;
  const tried = new Set();
  for (let s = 0; s < sketch.length - 1; s++) {
    const hits = within(sketch[s][0], sketch[s][1], snapKm, MAJOR_KM2);
    if (!hits.length) continue;
    let i = hits.reduce((a, b) => (d.uplandKm2[b] > d.uplandKm2[a] ? b : a));
    if (tried.has(i)) continue;
    tried.add(i);
    const rows = [];
    while (i !== undefined && rows.length < 20000) {
      rows.push(i);
      i = d.nextRow[i] >= 0 ? d.nextRow[i] : undefined;
    }
    // cut after the reach that ends closest to the sketch's end (the Yamuna ends at the Ganga)
    let cut = rows.length - 1, cutKm = Infinity;
    rows.forEach((r, k) => { const km = kmTo([d.y1[r] / 1e5, d.x1[r] / 1e5], end); if (km < cutKm) { cutKm = km; cut = k; } });
    if (cutKm > endKm || cut < 1) continue;
    const keptRows = rows.slice(0, cut + 1);
    const kept = joinShapes(d, keptRows);
    const rest = sketch.slice(s);
    const matched = rest.filter(([la, lo]) => distToLineKm(la, lo, kept) <= matchKm).length / rest.length;
    if (matched < minMatch) continue;
    const lengthKm = keptRows.reduce((t, r) => t + d.lengthKm[r], 0);
    if (best && lengthKm <= best.lengthKm) continue;
    const last = keptRows[keptRows.length - 1];
    best = {
      path: kept,
      reachIds: keptRows.map(r => d.id[r]),
      reaches: keptRows.length,
      lengthKm: Math.round(lengthKm),
      endDischargeCms: Math.round(d.dischargeCms[last]),
      endUplandKm2: Math.round(d.uplandKm2[last]),
      sketchMatch: +matched.toFixed(2),
      startedAtSketchPoint: s,
    };
  }
  return best;
}

/**
 * A stretch of the main channel around a reach: up to upKm upstream (following the
 * largest tributary) and downKm downstream. Returns reaches ordered upstream → downstream.
 */
function stretch(id, upKm = 60, downKm = 60) {
  const d = load();
  const start = d.rowOf(id);
  if (start === undefined) return null;
  const upRows = [];
  let i = start, km = 0;
  while (km < upKm) {
    const kids = d.kids(i);
    if (!kids.length) break;
    i = kids.reduce((a, b) => (d.uplandKm2[b] > d.uplandKm2[a] ? b : a));
    upRows.push(i);
    km += d.lengthKm[i];
  }
  const downRows = [];
  i = start; km = 0;
  while (km < downKm) {
    const nx = d.nextRow[i];
    if (nx < 0) break;
    i = nx;
    downRows.push(i);
    km += d.lengthKm[i];
  }
  return [...upRows.reverse(), start, ...downRows].map(r => describe(d, r));
}

// ---------------------------------------------------------------------------
// Map layer: which rivers to draw at a given zoom
// ---------------------------------------------------------------------------
// [max zoom, min catchment worldwide, min catchment in the India region] — more detail as you zoom in
const LEVELS = [
  [2, 400000, 40000],
  [3, 150000, 15000],
  [4, 50000, 4000],
  [5, 15000, 1500],
  [6, 5000, 400],
  [7, 2000, 100],
  [99, 1000, 100],
];
const inIndia = (lat, lon) => lon >= INDIA_BBOX[0] && lon <= INDIA_BBOX[2] && lat >= INDIA_BBOX[1] && lat <= INDIA_BBOX[3];
const widthClass = a => (a >= 500000 ? 5 : a >= 100000 ? 4 : a >= 20000 ? 3 : a >= 2000 ? 2 : 1);

/**
 * Rivers to draw inside [west, south, east, north] at this zoom, grouped by line width.
 * Connected reaches are joined into continuous lines; when zoomed out only reach end points
 * are sent (bends of a few km are invisible then) and coordinates are rounded to match.
 */
function network([w, s, e, n], zoom, classes = new Set([1, 2, 3, 4, 5])) {
  const d = load();
  const [, worldMin, indiaMin] = LEVELS.find(l => zoom <= l[0]);
  const floor = Math.min(worldMin, indiaMin);
  const detail = zoom >= 6;
  const dp = zoom <= 3 ? 2 : zoom <= 5 ? 3 : 4;
  const pad = 1; // degrees, so long reaches crossing the edge are kept
  const keep = new Set();
  for (let k = 0; k < d.n; k++) {
    const i = d.bySize[k];
    const a = d.uplandKm2[i];
    if (a < floor) break; // sorted biggest first: nothing smaller can qualify
    const lat = (d.y0[i] + d.y1[i]) / 2e5, lon = (d.x0[i] + d.x1[i]) / 2e5;
    if (lon < w - pad || lon > e + pad || lat < s - pad || lat > n + pad) continue;
    if (a < worldMin && !inIndia(lat, lon)) continue;
    if (!classes.has(widthClass(a))) continue; // category switched off in the map
    keep.add(i);
  }
  // A reach continues into its downstream reach if it is that reach's biggest kept
  // tributary and draws with the same line width.
  const continues = i => {
    const nx = d.nextRow[i];
    if (nx < 0 || !keep.has(nx) || widthClass(d.uplandKm2[nx]) !== widthClass(d.uplandKm2[i])) return false;
    let best = -1;
    for (const c of d.kids(nx)) if (keep.has(c) && (best < 0 || d.uplandKm2[c] > d.uplandKm2[best])) best = c;
    return best === i;
  };
  const continued = new Set();
  for (const i of keep) if (continues(i)) continued.add(d.nextRow[i]);
  const r = v => +(v / 1e5).toFixed(dp);
  const lines = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  let count = 0;
  for (const head of keep) {
    if (continued.has(head)) continue; // in the middle of a line, drawn from its head
    const pts = [];
    let i = head;
    for (;;) {
      if (detail) {
        for (let v = d.offsets[i] + (pts.length ? 1 : 0); v < d.offsets[i + 1]; v++) pts.push([r(d.xy[2 * v + 1]), r(d.xy[2 * v])]);
      } else {
        if (!pts.length) pts.push([r(d.y0[i]), r(d.x0[i])]);
        pts.push([r(d.y1[i]), r(d.x1[i])]);
      }
      count++;
      if (!continues(i)) break;
      i = d.nextRow[i];
    }
    lines[widthClass(d.uplandKm2[head])].push(pts);
  }
  return { zoom, worldMinKm2: worldMin, indiaMinKm2: indiaMin, reaches: count, lines };
}

/**
 * The whole main stem through a reach, source → mouth: upstream along the biggest tributary,
 * downstream along NEXT_DOWN. Returns reach ids, length, and a lightweight path for drawing.
 */
const stemCache = new Map();
function mainStem(id, { maxPoints = 4000 } = {}) {
  const d = load();
  const start = d.rowOf(id);
  if (start === undefined) return null;
  const up = [];
  let i = start;
  for (;;) {
    const kids = d.kids(i);
    if (!kids.length || up.length > 20000) break;
    i = kids.reduce((a, b) => (d.uplandKm2[b] > d.uplandKm2[a] ? b : a));
    up.push(i);
  }
  const down = [];
  i = start;
  while (d.nextRow[i] >= 0 && down.length < 20000) { i = d.nextRow[i]; down.push(i); }
  const rows = [...up.reverse(), start, ...down];
  const key = `${d.id[rows[0]]}-${d.id[rows[rows.length - 1]]}`;
  if (stemCache.has(key)) return stemCache.get(key);
  let path = joinShapes(d, rows);
  if (path.length > maxPoints) { // thin out evenly for drawing; analysis uses the reach ids
    const step = path.length / maxPoints;
    path = Array.from({ length: maxPoints }, (_, k) => path[Math.floor(k * step)]).concat([path[path.length - 1]]);
  }
  const last = rows[rows.length - 1];
  const stem = {
    key,
    reachIds: rows.map(r => d.id[r]),
    lengthKm: Math.round(rows.reduce((t, r) => t + d.lengthKm[r], 0)),
    mouthDischargeCms: Math.round(d.dischargeCms[last]),
    path: path.map(([la, lo]) => [+la.toFixed(4), +lo.toFixed(4)]),
  };
  if (stemCache.size > 300) stemCache.delete(stemCache.keys().next().value);
  stemCache.set(key, stem);
  return stem;
}

/** Full reach descriptions (with shapes) for a list of reach ids, in the given order. */
function describeIds(ids) {
  const d = load();
  return ids.map(id => d.rowOf(id)).filter(r => r !== undefined).map(r => describe(d, r));
}

module.exports = { load, available, nearest, within, downstream, traceAlong, stretch, mainStem, network, describeIds, widthClass, MAJOR_KM2, INDIA_BBOX };
