/**
 * Earth Intelligence Platform — hydropower site screening (dam.js)
 * ================================================================
 * POST /api/v1/dam/screen { lat, lon, targetMw }
 *
 * Screens candidate run-of-river hydropower sites along the REAL river near the point:
 *   1. snap to the nearest major river reach                 (HydroRIVERS)
 *   2. take ~60 km of main channel upstream and downstream   (HydroRIVERS network)
 *   3. place a node every ~1 km and snap it to the true valley floor: HydroRIVERS lines come
 *      from a ~500 m grid, so scan ±600 m across the valley and refine to the lowest point
 *                                                            (AWS Terrain Tiles, ~30 m)
 *   4. at every node, find where the valley sides rise WEIR_HEIGHT_M above the bed: that line
 *      is the weir axis, and its length (the crest) tells how narrow the gorge is
 *   5. for each candidate intake → powerhouse pair over a DIVERSION_KM stretch:
 *        head  H = z(intake) − z(powerhouse)
 *        flow  Q = long-term mean discharge at the powerhouse (HydroRIVERS, modelled)
 *        power P = η · ρ · g · Q · H
 *   6. rank by power and gorge narrowness, then pick non-overlapping sites up to the target.
 *
 * Preliminary screening only. NOT evaluated here (and reported as such): protected areas,
 * seismic/fault hazard, settlements and displacement, sediment, GLOF, geology, flow
 * variability and environmental flows.
 */
'use strict';

const rivers = require('./rivers.js');
const terrainTiles = require('./elevation.js');
const soil = require('./soil.js');

const ETA = 0.85;            // turbine + generator efficiency
const RHO = 1000, G = 9.81;
const DIVERSION_KM = 6;      // typical run-of-river tunnel/channel length
const CAPACITY_FACTOR = 0.5; // for annual energy: rivers rarely run at mean flow all year
const WALL_OFFSET_KM = 1;
const MIN_HEAD_M = 15;       // smaller heads are within the elevation model's error
const MAX_GRADIENT = 80;     // m/km; steeper on a >1000 km2 river means a bad elevation sample
const NODE_SPACING_KM = 1;   // candidate sites every ~1 km along the river
const WEIR_HEIGHT_M = 15;    // typical run-of-river diversion weir
const MAX_CREST_M = 2000;    // wider than this is a floodplain, not a gorge
// Typical river width from mean flow (hydraulic geometry, W ≈ a·Q^0.5; Leopold & Maddock 1953 form).
// A weir can't be shorter than the river is wide: a much shorter "crest" means the elevation
// model misread the channel (flat water, shadowed gorge), so that site is not trusted.
const riverWidthM = q => 7.2 * Math.sqrt(Math.max(0, q));
const MIN_CREST_TO_WIDTH = 0.6;
const range = (from, to, step) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, k) => +(from + k * step).toFixed(4));
const COARSE_KM = range(-0.6, 0.6, 0.075); // first scan across the valley for the river bed
const FINE_KM = range(-0.06, 0.06, 0.015); // refine around the lowest coarse sample
const PROFILE_KM = range(-1, 1, 0.025);    // cross-section for the weir axis

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Elevation never changes: cache it (~11 m grid) so repeated demos cost no API calls.
const elevCache = new Map();
const cacheKey = p => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

/** Elevations: AWS Terrain Tiles first (no rate limit), Open-Meteo as a backup. */
let elevationSource = terrainTiles.SOURCE;
async function elevations(points, zoom) {
  try {
    const z = await terrainTiles.elevations(points, zoom);
    elevationSource = terrainTiles.SOURCE;
    return z;
  } catch (err) {
    console.warn('[dam] terrain tiles unavailable, using Open-Meteo:', err.message);
    elevationSource = 'Copernicus DEM GLO-90 via Open-Meteo';
    return openMeteoElevations(points);
  }
}

/** Open-Meteo elevation: up to 100 points per request; free tier is rate-limited (HTTP 429). */
async function openMeteoElevations(points) {
  const missing = [...new Set(points.map(cacheKey))].filter(k => !elevCache.has(k));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100).map(k => k.split(','));
    const url = 'https://api.open-meteo.com/v1/elevation' +
      `?latitude=${chunk.map(p => p[0]).join(',')}&longitude=${chunk.map(p => p[1]).join(',')}`;
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.status !== 429) break;
      await new Promise(r => setTimeout(r, 4000 * (attempt + 1)));
    }
    if (res.status === 429) throw httpError(503, 'The free elevation service is busy (rate limit). Wait a minute and try again.');
    if (!res.ok) throw new Error(`elevation HTTP ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j.elevation) || j.elevation.length !== chunk.length) throw new Error('bad elevation response');
    chunk.forEach((p, k) => elevCache.set(p.join(','), j.elevation[k]));
  }
  if (elevCache.size > 200000) elevCache.clear();
  return points.map(p => elevCache.get(cacheKey(p)));
}

function kmBetween([la1, lo1], [la2, lo2]) {
  return Math.hypot(la2 - la1, (lo2 - lo1) * Math.cos(((la1 + la2) / 2) * Math.PI / 180)) * 111.32;
}

/** Point offset perpendicular to the direction a→b, by km (+ = left bank looking downstream). */
function perpendicular([lat, lon], a, b, km) {
  const k = Math.cos(lat * Math.PI / 180);
  const dx = (b[1] - a[1]) * k, dy = b[0] - a[0];
  const len = Math.hypot(dx, dy) || 1;
  const deg = km / 111.32;
  return [lat + (dx / len) * deg, lon + (-dy / len) * deg / k];
}

async function screen({ lat, lon, targetMw }) {
  lat = Number(lat); lon = Number(lon);
  targetMw = Math.min(5000, Math.max(1, Number(targetMw) || 100));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    throw httpError(400, 'Valid lat and lon are required.');
  }
  if (!rivers.available()) throw httpError(503, 'River network data is not installed on the server.');

  const reach = rivers.nearest(lat, lon, 20);
  if (!reach) throw httpError(404, 'No major river (≥ 1000 km² catchment) within 20 km. Click closer to a river.');
  if (reach.meanDischargeCms < 1) {
    throw httpError(404, `The nearest river channel is dry or seasonal (mean flow ${reach.meanDischargeCms} m³/s): no hydropower possible.`);
  }
  const { nodes, candidates } = await analyzeStretch(reach, 60, 60);
  return pickSites({ reach, nodes, candidates, targetMw });
}

/**
 * Detailed analysis of the main channel from upKm above to downKm below a reach:
 * nodes every ~1 km snapped to the valley floor, weir axes, and every viable
 * intake → powerhouse candidate with its head, flow, power and weir crest.
 */
async function analyzeStretch(reach, upKm, downKm) {
  return analyzeChain(rivers.stretch(reach.id, upKm, downKm));
}

/** Same analysis for an explicit list of consecutive reaches (upstream → downstream). */
async function analyzeChain(chain) {
  // Nodes every ~1 km along the channel, upstream → downstream.
  const nodes = [];
  let along = 0;
  for (const r of chain) {
    // Walk the reach's real shape (not the straight chord between its ends) placing a node
    // every ~NODE_SPACING_KM; distances are scaled to the reach's official length.
    const pts = r.shape;
    const seg = pts.slice(1).map((p, k) => kmBetween(pts[k], p));
    const total = seg.reduce((a, b) => a + b, 0) || 1;
    const n = Math.max(1, Math.round(r.reachLengthKm / NODE_SPACING_KM));
    for (let k = 0; k < n; k++) {
      let target = (k / n) * total, j = 0;
      while (j < seg.length - 1 && target > seg[j]) target -= seg[j++];
      const t = seg[j] ? Math.min(1, target / seg[j]) : 0;
      nodes.push({
        line: [pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t],
        q: r.meanDischargeCms, alongKm: along + r.reachLengthKm * (k / n), reach: r,
      });
    }
    along += r.reachLengthKm;
  }
  const last = chain[chain.length - 1];
  nodes.push({ line: last.end, q: last.meanDischargeCms, alongKm: along, reach: last });
  // Direction of flow at each node (for cross-sections)
  const dir = i => [nodes[Math.max(0, i - 1)].line, nodes[Math.min(nodes.length - 1, i + 1)].line];

  // Snap each node to the valley floor: coarse scan, then fine scan around the lowest sample.
  const coarse = await elevations(nodes.flatMap((n, i) => COARSE_KM.map(km => perpendicular(n.line, ...dir(i), km))));
  nodes.forEach((n, i) => {
    const row = coarse.slice(i * COARSE_KM.length, (i + 1) * COARSE_KM.length);
    n.offsetKm = COARSE_KM[row.indexOf(Math.min(...row))];
  });
  const fine = await elevations(nodes.flatMap((n, i) => FINE_KM.map(km => perpendicular(n.line, ...dir(i), n.offsetKm + km))));
  nodes.forEach((n, i) => {
    const row = fine.slice(i * FINE_KM.length, (i + 1) * FINE_KM.length);
    const k = row.indexOf(Math.min(...row));
    n.offsetKm += FINE_KM[k];
    n.pt = perpendicular(n.line, ...dir(i), n.offsetKm).map(v => +v.toFixed(5));
    n.bedZ = row[k];
    n.z = row[k];
  });

  // Cross-section through the snapped bed point: weir axis where both sides reach bed + WEIR_HEIGHT_M.
  const prof = await elevations(nodes.flatMap((n, i) => PROFILE_KM.map(km => perpendicular(n.pt, ...dir(i), km))));
  const mid = PROFILE_KM.indexOf(0);
  nodes.forEach((n, i) => {
    const row = prof.slice(i * PROFILE_KM.length, (i + 1) * PROFILE_KM.length);
    const crest = n.bedZ + WEIR_HEIGHT_M;
    let l = mid, r = mid;
    while (l > 0 && row[l] < crest) l--;
    while (r < row.length - 1 && row[r] < crest) r++;
    const closed = row[l] >= crest && row[r] >= crest;
    n.crestM = closed ? Math.round((PROFILE_KM[r] - PROFILE_KM[l]) * 1000) : null; // null: valley wider than 2 km
    n.weirAxis = [perpendicular(n.pt, ...dir(i), PROFILE_KM[l]), perpendicular(n.pt, ...dir(i), PROFILE_KM[r])]
      .map(p => p.map(v => +v.toFixed(5)));
    // the LOWER valley side 1 km out limits how high a dam could ever go
    n.wallM = Math.max(0, Math.min(row[0], row[row.length - 1]) - n.bedZ);
  });
  // Smooth the bed profile with a running median (5 nodes ≈ 5 km): single bumps and pits from
  // trees, banks or islands in the elevation model must not create fake heads.
  const bed = nodes.map(n => n.bedZ);
  nodes.forEach((n, i) => {
    const w = bed.slice(Math.max(0, i - 2), i + 3).sort((x, y) => x - y);
    n.z = w[Math.floor(w.length / 2)];
  });
  // Water runs downhill: the bed can't rise downstream (removes DEM bumps, e.g. bridges, cliffs).
  for (let i = 1; i < nodes.length; i++) nodes[i].z = Math.min(nodes[i].z, nodes[i - 1].z);

  // Candidate = powerhouse at node j, intake at the node ~DIVERSION_KM upstream.
  const candidates = [];
  for (let j = 1; j < nodes.length; j++) {
    let i = j;
    while (i > 0 && nodes[j].alongKm - nodes[i - 1].alongKm <= DIVERSION_KM * 1.25) i--;
    if (i === j) continue;
    const head = nodes[i].z - nodes[j].z;
    const lenKm = nodes[j].alongKm - nodes[i].alongKm;
    if (head < MIN_HEAD_M || lenKm < 1 || head / lenKm > MAX_GRADIENT) continue;
    // Compare with the river's gradient over a longer baseline (~12 km either side): a local drop
    // far steeper than that on a lowland river is an elevation-model spike, not a real head.
    let a = i, b = j;
    while (a > 0 && nodes[i].alongKm - nodes[a - 1].alongKm <= 12) a--;
    while (b < nodes.length - 1 && nodes[b + 1].alongKm - nodes[j].alongKm <= 12) b++;
    const baseKm = nodes[b].alongKm - nodes[a].alongKm;
    const baseGradient = baseKm > lenKm ? (nodes[a].z - nodes[b].z) / baseKm : head / lenKm;
    if (head / lenKm > 3 * baseGradient + 1.5) continue;
    // Big lowland rivers (e.g. the Brahmaputra in Assam) need low-head barrages designed from
    // surveys, not diversion schemes: skip them rather than trust tiny DEM differences.
    if (nodes[j].q > 2000 && baseGradient < 0.5) continue;
    const q = nodes[j].q;
    const mw = (ETA * RHO * G * q * head) / 1e6;
    if (mw < 1) continue;
    if (nodes[i].crestM === null || nodes[i].crestM > MAX_CREST_M) continue; // no gorge to hold a weir
    const widthM = riverWidthM(nodes[i].q);
    if (nodes[i].crestM < MIN_CREST_TO_WIDTH * widthM) continue; // crest narrower than the river: DEM misread
    candidates.push({
      intake: nodes[i].pt, powerhouse: nodes[j].pt,
      route: nodes.slice(i, j + 1).map(n => n.pt),
      weirAxis: nodes[i].weirAxis, weirCrestM: nodes[i].crestM, weirHeightM: WEIR_HEIGHT_M,
      riverWidthEstM: Math.round(widthM),
      intakeAlongKm: nodes[i].alongKm, powerhouseAlongKm: nodes[j].alongKm,
      diversionKm: +lenKm.toFixed(1), headM: Math.round(head), flowCms: +q.toFixed(1),
      mw: +mw.toFixed(1), gradientMPerKm: +(head / lenKm).toFixed(1),
      valleyWallM: Math.round(nodes[i].wallM),
      riverBedElevationM: Math.round(nodes[j].z),
      upstreamAreaKm2: nodes[j].reach.upstreamAreaKm2,
      mainRiverId: nodes[j].reach.mainRiverId,
    });
  }
  return { nodes, candidates };
}

/** Single-river screening result: best non-overlapping sites up to the target. */
function pickSites({ reach, nodes, candidates, targetMw }) {
  if (!candidates.length) {
    return {
      ok: false,
      reason: `No viable diversion site along this ~120 km stretch: either the river never drops ${MIN_HEAD_M} m within ~${DIVERSION_KM} km, ` +
        `or where it does the valley is too wide (> ${MAX_CREST_M / 1000} km) for a ${WEIR_HEIGHT_M} m weir. ` +
        'Low-head barrages may still be possible but need a detailed survey.',
      river: describeRiver(reach), channel: nodes.map(n => n.pt), assumptions: assumptions(), notEvaluated: NOT_EVALUATED,
    };
  }

  // Score: power (log scale) 65 %, short weir crest = narrow gorge = cheaper, stable weir 35 %.
  const maxLog = Math.max(...candidates.map(c => Math.log10(c.mw + 1)));
  for (const c of candidates) {
    const narrow = 1 - Math.min(1, c.weirCrestM / MAX_CREST_M);
    c.score = Math.round(100 * (0.65 * Math.log10(c.mw + 1) / maxLog + 0.35 * narrow));
  }
  candidates.sort((a, b) => b.score - a.score);

  // Pick non-overlapping schemes (river stretches must not overlap) until the target is met.
  const chosen = [];
  let total = 0;
  for (const c of candidates) {
    if (chosen.length >= 4 || total >= targetMw) break;
    const overlaps = chosen.some(o => c.intakeAlongKm < o.powerhouseAlongKm && o.intakeAlongKm < c.powerhouseAlongKm);
    if (overlaps) continue;
    chosen.push(c);
    total += c.mw;
  }
  chosen.sort((a, b) => a.intakeAlongKm - b.intakeAlongKm);
  chosen.forEach((c, k) => { c.rank = k + 1; });

  const annualGWh = Math.round(total * 8760 * CAPACITY_FACTOR / 1000);
  return {
    ok: true,
    targetMw,
    achievedMw: +total.toFixed(1),
    meetsTarget: total >= targetMw,
    annualGWh,
    sites: chosen,
    candidatesEvaluated: candidates.length,
    river: describeRiver(reach),
    channel: nodes.map(n => n.pt),
    profile: nodes.map(n => ({ km: +n.alongKm.toFixed(1), z: Math.round(n.z) })),
    assumptions: assumptions(),
    notEvaluated: NOT_EVALUATED,
    sources: [
      'River network & mean discharge: HydroRIVERS v1.0 (HydroSHEDS, Lehner & Grill 2013), modelled',
      `Elevation: ${elevationSource} (heads are approximate)`,
    ],
  };
}

// ---------------------------------------------------------------------------
// City planner: "this city needs X MW — where should the dams go?"
// ---------------------------------------------------------------------------
const PLAN_WEIGHTS = { power: 0.35, gorge: 0.20, distance: 0.20, foundation: 0.15, seismic: 0.10 };
// "Nearest to the city": distance dominates, the other criteria still break ties and filter bad sites
const NEAREST_WEIGHTS = { power: 0.15, gorge: 0.15, distance: 0.50, foundation: 0.10, seismic: 0.10 };
const kmFrom = ([la1, lo1], [la2, lo2]) => {
  const r = Math.PI / 180, a = Math.sin((la2 - la1) * r / 2) ** 2 +
    Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
};

const quakeCache = new Map();
/** Number of M5+ earthquakes within 50 km since 1970 (USGS), cached per ~0.25° cell. */
async function quakesNear(lat, lon) {
  const key = `${(Math.round(lat * 4) / 4).toFixed(2)},${(Math.round(lon * 4) / 4).toFixed(2)}`;
  if (!quakeCache.has(key)) {
    const job = fetch('https://earthquake.usgs.gov/fdsnws/event/1/count?format=geojson' +
      `&latitude=${lat}&longitude=${lon}&maxradiuskm=50&minmagnitude=5&starttime=1970-01-01`, { signal: AbortSignal.timeout(15000) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(j => j.count);
    job.catch(() => quakeCache.delete(key));
    quakeCache.set(key, job);
  }
  return quakeCache.get(key);
}

/**
 * Foundation proxy from topsoil (0-30 cm): stony soil (coarse fragments) usually means rock close
 * to the surface — good for a weir; clay-rich soil is weak and swelling. 0..1, higher = better.
 * Not a substitute for boreholes: it only ranks candidates.
 */
function foundationScore(s) {
  if (!s) return null;
  const stones = Math.min(1, (s.coarseFragmentsPct ?? 0) / 40);
  const clay = Math.min(1, (s.clayPct ?? 0) / 60);
  return Math.max(0, Math.min(1, 0.5 + 0.5 * stones - 0.4 * clay));
}

/** Shortest distance (km) from a point to a polyline. */
function kmToRoute(pt, route) {
  let best = Infinity;
  for (let i = 1; i < route.length; i++) {
    const [a, b] = [route[i - 1], route[i]];
    const k = Math.cos(pt[0] * Math.PI / 180);
    const ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0], px = pt[1] * k, py = pt[0];
    const dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * 111.32);
  }
  return route.length === 1 ? kmFrom(pt, route[0]) : best;
}

/**
 * Do two schemes use the same water? Same section: their river stretches overlap. Different
 * sections (which can share channel): either weir lies on/near the other's diversion route,
 * or the weirs are under 3 km apart.
 */
function clashes(a, b) {
  if (a.section === b.section) return a.intakeAlongKm < b.powerhouseAlongKm && b.intakeAlongKm < a.powerhouseAlongKm;
  return kmFrom(a.intake, b.intake) < 3 || kmToRoute(a.intake, b.route) < 0.5 || kmToRoute(b.intake, a.route) < 0.5;
}

/** Every feasible scheme that can coexist, taken best-first (no shared water, see clashes()). */
function feasibleSet(candidates, rankBy = c => c.mw) {
  const kept = [];
  for (const c of [...candidates].sort((a, b) => rankBy(b) - rankBy(a))) {
    if (!kept.some(o => clashes(o, c))) kept.push(c);
  }
  return kept;
}

/** Regions = groups of points chained within linkKm of each other (single linkage, order-independent). */
function regionsOf(items, linkKm = 15, pointOf = x => x.intake) {
  const parent = items.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (kmFrom(pointOf(items[i]), pointOf(items[j])) <= linkKm) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  items.forEach((x, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(x);
  });
  return [...groups.values()];
}

async function plan({ city, lat, lon, targetMw, radiusKm, rankBy }) {
  const WEIGHTS = rankBy === 'nearest' ? NEAREST_WEIGHTS : PLAN_WEIGHTS;
  lat = Number(lat); lon = Number(lon);
  targetMw = Math.min(5000, Math.max(10, Number(targetMw) || 300));
  radiusKm = Math.min(400, Math.max(30, Number(radiusKm) || 200));
  const cityName = String(city || '').slice(0, 120) || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    throw httpError(400, 'Valid city coordinates are required.');
  }
  if (!rivers.available()) throw httpError(503, 'River network data is not installed on the server.');
  const t0 = Date.now();
  const home = [lat, lon];

  // 1. Pre-screen every major river reach in the radius on a coarse (~300 m) elevation model:
  //    potential ≈ η·ρ·g·Q·(drop over the reach), scaled to a ~6 km scheme.
  const d = rivers.load();
  const rows = rivers.within(lat, lon, radiusKm, rivers.MAJOR_KM2).filter(i => d.dischargeCms[i] >= 5 && d.lengthKm[i] >= 0.5);
  if (!rows.length) throw httpError(404, `No major river within ${radiusKm} km of ${cityName}. Try a larger radius.`);
  const zs = await elevations(rows.flatMap(i => [[d.y0[i] / 1e5, d.x0[i] / 1e5], [d.y1[i] / 1e5, d.x1[i] / 1e5]]), 9);
  const seeds = rows.map((i, k) => {
    // big lowland rivers can't host diversion schemes (see analyzeStretch): don't spend analyses on them
    if (d.dischargeCms[i] > 1500 && Math.min(zs[2 * k], zs[2 * k + 1]) < 200) return null;
    const drop = Math.max(0, zs[2 * k] - zs[2 * k + 1]);
    const perKm = (ETA * RHO * G * d.dischargeCms[i] * drop) / 1e6 / d.lengthKm[i];
    const mid = [(d.y0[i] + d.y1[i]) / 2e5, (d.x0[i] + d.x1[i]) / 2e5];
    const distKm = kmFrom(home, mid);
    // "nearest": closeness steers which stretches get analysed, not just the final ranking
    const closeness = rankBy === 'nearest' ? 0.85 : 0.4;
    return { i, mid, distKm, score: perKm * DIVERSION_KM * (1 - closeness * distKm / radiusKm) };
  }).filter(s => s && s.score >= 5).sort((a, b) => b.score - a.score);

  // 2. Analyse the most promising stretches (at least 20 km apart) in detail, a few at a time,
  //    until the best candidates found could cover the demand ~1.5× over (max 12 stretches).
  const picked = [];
  for (const s of seeds) {
    if (picked.length >= 12) break;
    if (picked.some(p => kmFrom(p.mid, s.mid) < 20)) continue;
    picked.push(s);
  }
  const stretches = [];
  for (let k = 0; k < picked.length; k += 3) {
    const batch = await Promise.all(picked.slice(k, k + 3).map(async s => {
      try {
        return { seed: s, ...(await analyzeStretch({ id: d.id[s.i], mainRiverId: d.main[s.i] }, 15, 15)) };
      } catch (err) {
        console.warn('[dam plan] stretch failed:', err.message);
        return null;
      }
    }));
    stretches.push(...batch.filter(Boolean));
    // rough potential: best candidate per stretch (non-overlapping by construction)
    const potential = stretches.reduce((t, st) => t + Math.max(0, ...st.candidates.map(c => c.mw)), 0);
    if (k + 3 >= 6 && potential >= 1.5 * targetMw) break;
  }
  let candidates = stretches.flatMap((st, k) => st.candidates.map(c => ({ ...c, stretch: k, section: k })));
  // How much is feasible at all (not just what the city needs): every coexisting site found
  const allFeasible = feasibleSet(candidates);
  const feasible = {
    sites: allFeasible.length,
    regions: regionsOf(allFeasible).length,
    totalMw: +allFeasible.reduce((t, c) => t + c.mw, 0).toFixed(1),
    points: allFeasible.map(c => ({ intake: c.intake, mw: c.mw })),
    // Detailed analysis covers only the best stretches; the rest of the coarse screen is reported as
    // "promising, not verified" so the counts above are read as minimums.
    complete: picked.length >= seeds.length,
    unverifiedAreas: regionsOf(seeds.filter(s => !picked.includes(s)).filter(s => !picked.some(p => kmFrom(p.mid, s.mid) < 20)), 15, s => s.mid).length,
  };
  if (!candidates.length) {
    return {
      ok: false, city: { name: cityName, lat, lon }, targetMw, radiusKm,
      reason: `Within ${radiusKm} km of ${cityName} no river stretch has enough drop and a narrow enough valley for run-of-river hydropower. Try a larger radius.`,
      feasible: { sites: 0, regions: 0, totalMw: 0, points: [], complete: picked.length >= seeds.length, unverifiedAreas: 0 },
      reachesScanned: rows.length, assumptions: assumptions(), notEvaluated: PLAN_NOT_EVALUATED,
    };
  }

  // 3. Enrich the strongest candidates with distance, soil and earthquake history.
  // keep the 40 strongest (or, ranking by nearest, the 40 closest) candidates for scoring
  candidates.forEach(c => { c.distanceToCityKm = Math.round(kmFrom(home, c.powerhouse)); });
  candidates.sort(rankBy === 'nearest' ? (a, b) => a.distanceToCityKm - b.distanceToCityKm : (a, b) => b.mw - a.mw);
  candidates = candidates.slice(0, 40);
  await Promise.all(candidates.map(async c => {
    c.distanceToCityKm = Math.round(kmFrom(home, c.powerhouse));
    c.soil = soil.lookup(c.intake[0], c.intake[1]);
    c.quakesM5Within50km = await quakesNear(c.intake[0], c.intake[1]).catch(() => null);
  }));

  // 4. Score on five transparent criteria (0-1 each), weighted.
  const maxLog = Math.max(...candidates.map(c => Math.log10(c.mw + 1)));
  for (const c of candidates) {
    const f = foundationScore(c.soil);
    c.criteria = {
      power: +(Math.log10(c.mw + 1) / maxLog).toFixed(2),
      gorge: +(1 - Math.min(1, c.weirCrestM / MAX_CREST_M)).toFixed(2),
      distance: +Math.max(0, 1 - c.distanceToCityKm / radiusKm).toFixed(2),
      foundation: f === null ? null : +f.toFixed(2),
      seismic: c.quakesM5Within50km === null ? null : +(1 - Math.min(1, c.quakesM5Within50km / 10)).toFixed(2),
    };
    // missing criteria count as neutral (0.5) and are flagged in the UI
    c.score = Math.round(100 * Object.entries(WEIGHTS).reduce((t, [k, w]) => t + w * (c.criteria[k] ?? 0.5), 0));
  }
  candidates.sort((a, b) => b.score - a.score);

  // 5. Choose non-overlapping schemes until the city's demand is met.
  const chosen = [];
  let total = 0;
  for (const c of candidates) {
    if (chosen.length >= 8 || total >= targetMw) break;
    if (chosen.some(o => clashes(o, c))) continue;
    chosen.push(c);
    total += c.mw;
  }
  // A scheme can be built smaller than its potential: propose only what is still needed.
  let remaining = targetMw;
  chosen.forEach((c, k) => {
    c.rank = k + 1;
    c.proposedMw = +Math.max(0, Math.min(c.mw, remaining)).toFixed(1);
    remaining -= c.proposedMw;
  });

  return {
    ok: true,
    city: { name: cityName, lat, lon },
    targetMw, radiusKm,
    potentialMw: +total.toFixed(1),
    achievedMw: +Math.min(total, targetMw).toFixed(1),
    meetsTarget: total >= targetMw,
    annualGWh: Math.round(Math.min(total, targetMw) * 8760 * CAPACITY_FACTOR / 1000),
    sites: chosen,
    feasible,
    weights: WEIGHTS,
    rankBy: rankBy === 'nearest' ? 'nearest' : 'best',
    reachesScanned: rows.length,
    stretchesPromising: seeds.length,
    stretchesAnalysed: stretches.length,
    candidatesScored: candidates.length,
    tookMs: Date.now() - t0,
    assumptions: [
      ...assumptions(),
      `Score = ${Object.entries(WEIGHTS).map(([k, w]) => `${Math.round(w * 100)} % ${k}`).join(' + ')}; a missing criterion counts as neutral.`,
      'Foundation = topsoil proxy (stony soil suggests shallow rock, clay-rich soil is weak); it ranks sites, it does not replace boreholes.',
      'Seismic = number of M5+ earthquakes within 50 km since 1970 (USGS); not a fault or hazard map.',
      'Distance = straight line from the powerhouse to the city (a transmission-line proxy).',
    ],
    notEvaluated: PLAN_NOT_EVALUATED,
    sources: [
      'River network & mean discharge: HydroRIVERS v1.0 (HydroSHEDS, Lehner & Grill 2013), modelled',
      `Elevation: ${elevationSource}`,
      'Soil: ISRIC SoilGrids 2.0 (India grid, ~2 km, top 30 cm)',
      'Earthquakes: USGS ComCat',
    ],
  };
}

// ---------------------------------------------------------------------------
// River Dam Atlas: every feasible site along one whole river
// ---------------------------------------------------------------------------
const ATLAS_SECTION_KM = 30;
const ATLAS_MAX_SECTIONS = 20;

/**
 * input: { sketch: [[lat, lon], ...] } (a named river's rough line) or { lat, lon } (any river,
 * by clicking it). The river is followed source → mouth, cut into ~30 km sections, every section
 * is pre-screened on a coarse elevation model, and the most promising ones are analysed in detail.
 */
async function atlas({ name, sketch, lat, lon, reachId }) {
  if (!rivers.available()) throw httpError(503, 'River network data is not installed on the server.');
  const t0 = Date.now();
  let ids, riverName = String(name || '').slice(0, 120);
  if (Number.isInteger(reachId)) {
    // exactly the river the user highlighted on the map (rivers.mainStem)
    const stem = rivers.mainStem(reachId);
    if (!stem) throw httpError(404, 'That river is not in the river network.');
    ids = stem.reachIds;
    riverName = riverName || 'Selected river';
  } else if (Array.isArray(sketch) && sketch.length >= 2 && sketch.every(p => Array.isArray(p) && p.every(Number.isFinite))) {
    const tr = rivers.traceAlong(sketch);
    if (!tr) throw httpError(404, 'Could not trace this river in the river network.');
    ids = tr.reachIds;
  } else {
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw httpError(400, 'Pick a river or click on one.');
    const reach = rivers.nearest(lat, lon, 15);
    if (!reach) throw httpError(404, 'No major river (≥ 1000 km² catchment) within 15 km of that point.');
    ids = rivers.stretch(reach.id, 5000, 5000).map(r => r.id); // whole main stem, source → sea
    riverName = riverName || `River at ${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  }
  const reaches = rivers.describeIds(ids);
  const lengthKm = reaches.reduce((t, r) => t + r.reachLengthKm, 0);

  // Cut into ~30 km sections and pre-screen each on a coarse (~300 m) elevation model.
  const sections = [];
  let cur = [], km = 0;
  for (const r of reaches) {
    cur.push(r); km += r.reachLengthKm;
    if (km >= ATLAS_SECTION_KM) { sections.push(cur); cur = []; km = 0; }
  }
  if (cur.length) sections.push(cur);
  const ends = await elevations(reaches.flatMap(r => [r.start, r.end]), 9);
  const zOf = new Map(reaches.map((r, k) => [r.id, [ends[2 * k], ends[2 * k + 1]]]));
  const scored = sections.map((sec, k) => {
    let mw = 0;
    for (const r of sec) {
      const [z0, z1] = zOf.get(r.id);
      if (r.meanDischargeCms > 1500 && Math.min(z0, z1) < 200) continue; // lowland giant: no diversion schemes
      mw += (ETA * RHO * G * r.meanDischargeCms * Math.max(0, z0 - z1)) / 1e6;
    }
    return { k, sec, mw };
  });
  const promising = scored.filter(x => x.mw >= 10).sort((a, b) => b.mw - a.mw);
  const chosen = promising.slice(0, ATLAS_MAX_SECTIONS);

  // Detailed analysis, a few sections at a time.
  const candidates = [];
  for (let i = 0; i < chosen.length; i += 4) {
    const batch = await Promise.all(chosen.slice(i, i + 4).map(x =>
      analyzeChain(x.sec).then(r => r.candidates.map(c => ({ ...c, section: x.k })), err => {
        console.warn('[atlas] section failed:', err.message);
        return [];
      })));
    batch.forEach(list => candidates.push(...list));
  }
  // Rank by power and gorge narrowness (no city here), then keep every site that can coexist.
  const maxLog = Math.max(1, ...candidates.map(c => Math.log10(c.mw + 1)));
  for (const c of candidates) {
    c.score = Math.round(100 * (0.65 * Math.log10(c.mw + 1) / maxLog + 0.35 * (1 - Math.min(1, c.weirCrestM / MAX_CREST_M))));
  }
  const sites = feasibleSet(candidates, c => c.score)
    .sort((a, b) => (a.section - b.section) || (a.intakeAlongKm - b.intakeAlongKm));
  await Promise.all(sites.map(async c => {
    c.soil = soil.lookup(c.intake[0], c.intake[1]);
    c.quakesM5Within50km = await quakesNear(c.intake[0], c.intake[1]).catch(() => null);
  }));
  sites.forEach((c, k) => { c.rank = k + 1; c.kmFromSource = Math.round(sectionStartKm(sections, c.section) + c.intakeAlongKm); });

  return {
    ok: true,
    river: { name: riverName || 'River', lengthKm: Math.round(lengthKm), reaches: reaches.length },
    path: reaches.flatMap((r, k) => (k ? r.shape.slice(1) : r.shape)),
    sections: { total: sections.length, promising: promising.length, analysed: chosen.length },
    feasible: {
      sites: sites.length, regions: regionsOf(sites).length, totalMw: +sites.reduce((t, c) => t + c.mw, 0).toFixed(1),
      complete: chosen.length >= promising.length,
      unverifiedSections: promising.length - chosen.length,
    },
    sites,
    tookMs: Date.now() - t0,
    assumptions: [
      ...assumptions(),
      `The river is cut into ~${ATLAS_SECTION_KM} km sections; all are pre-screened on a ~300 m elevation model and the ${ATLAS_MAX_SECTIONS} most promising are analysed in detail.`,
      'Feasible sites = every scheme that passes all checks and can coexist (no overlapping river stretch, weirs at least 3 km apart). Regions = groups of sites within 15 km.',
    ],
    notEvaluated: PLAN_NOT_EVALUATED,
    sources: [
      'River network & mean discharge: HydroRIVERS v1.0 (HydroSHEDS, Lehner & Grill 2013), modelled',
      `Elevation: ${elevationSource}`,
      'Soil: ISRIC SoilGrids 2.0 (India grid)',
      'Earthquakes: USGS ComCat',
    ],
  };
}

function sectionStartKm(sections, k) {
  let km = 0;
  for (let i = 0; i < k; i++) km += sections[i].reduce((t, r) => t + r.reachLengthKm, 0);
  return km;
}

const PLAN_NOT_EVALUATED = [
  'Protected areas and biodiversity (e.g. national parks, WDPA)',
  'Active faults and official seismic zoning (only earthquake history is used)',
  'Settlements, farmland and people who would be displaced',
  'Sediment load, glacial-lake outburst floods (GLOF) and landslide-dammed lakes',
  'Bedrock geology (only a topsoil proxy is used)',
  'Seasonal flow variability, environmental flows and downstream water users',
  'Existing dams, grid capacity and transboundary agreements',
];

function describeRiver(reach) {
  return {
    distanceFromClickKm: reach.distanceKm,
    meanDischargeCms: reach.meanDischargeCms,
    upstreamAreaKm2: reach.upstreamAreaKm2,
    strahlerOrder: reach.strahlerOrder,
  };
}

function assumptions() {
  return [
    `Run-of-river schemes: water diverted ~${DIVERSION_KM} km through a tunnel/channel to a powerhouse downstream.`,
    `Power = η·ρ·g·Q·H with η = ${ETA}, Q = long-term MEAN flow (modelled). Real design flow is usually lower.`,
    `Annual energy assumes a ${Math.round(CAPACITY_FACTOR * 100)} % capacity factor.`,
    'Head is the river-bed drop from a ~30-90 m elevation model; in narrow gorges it can be off by tens of metres.',
    'River points are snapped to the lowest ground within ±600 m across the valley (HydroRIVERS lines can be several hundred metres off).',
    `Weir axis: the line across the valley between the points where both sides rise ${WEIR_HEIGHT_M} m above the river bed; its length is the crest length.`,
    `Sites whose crest is shorter than ${MIN_CREST_TO_WIDTH * 100} % of the river's typical width (≈ 7.2·√Q m) are rejected as elevation-model errors.`,
    'The river-bed profile is smoothed (running median over ~5 km) and checked against the gradient over ~25 km, so elevation spikes cannot fake a head.',
    'Large lowland rivers (mean flow > 2000 m³/s, gradient < 0.5 m/km) are excluded: they need surveyed low-head barrages, not diversion schemes.',
    `"Valley wall" = height of the LOWER valley side ${WALL_OFFSET_KM} km from the river.`,
  ];
}

const NOT_EVALUATED = [
  'Protected areas and biodiversity (e.g. national parks, WDPA)',
  'Earthquake and active-fault hazard',
  'Settlements, farmland and people who would be displaced',
  'Sediment load, glacial-lake outburst floods (GLOF) and landslide-dammed lakes',
  'Geology and foundation conditions',
  'Seasonal flow variability, environmental flows and downstream water users',
  'Existing dams and transboundary agreements',
];

module.exports = { screen, plan, atlas };
