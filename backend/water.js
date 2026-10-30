/**
 * Earth Intelligence Platform — water quality from Sentinel-2 (water.js)
 * =====================================================================
 * POST /api/v1/water-quality { lat, lon }
 *
 * Optical water quality for any river or lake, from the most recent cloud-free Sentinel-2
 * images (ESA Copernicus, 10–20 m, every ~5 days), read through Microsoft Planetary Computer
 * (public, no key):
 *   - water pixels only: Sentinel-2's own scene classification (SCL = 6, water)
 *   - turbidity (FNU):   Dogliotti et al. (2015) single-band algorithm, red 665 nm switching to
 *                        NIR 865 nm in very turbid water (as used in ACOLITE)
 *   - chlorophyll index: NDCI = (B05 − B04) / (B05 + B04), Mishra & Mishra (2012)
 *   - trend over the last few clear images
 * Gemma 4 then reads the true-colour image together with the numbers.
 *
 * Satellites see colour, not chemistry: dissolved oxygen, BOD, pH, metals and bacteria
 * cannot be measured this way and are reported as such.
 */
'use strict';

const rivers = require('./rivers.js');
const gemma = require('./gemma.js');

const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
const DATA = 'https://planetarycomputer.microsoft.com/api/data/v1/item';
const BANDS = ['B03', 'B04', 'B05', 'B08', 'SCL'];
const HALF_KM = 1.5;          // analysed box: 3 × 3 km around the point
const PX = 256;               // ~12 m per pixel for a 3 km box
const LOOKBACK_DAYS = 120;
const MAX_IMAGES = 3;         // latest image + up to 2 earlier clear ones for the trend
const MIN_WATER_PX = 40;      // ~0.6 ha of open water at 12 m

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 30000) });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
      return res;
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

/** Minimal .npy reader (NumPy format 1.0/2.0, little-endian uint16 / uint8 / float32). */
function parseNpy(buf) {
  if (buf.toString('latin1', 1, 6) !== 'NUMPY') throw new Error('not a .npy file');
  const major = buf[6];
  const hlen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const start = (major === 1 ? 10 : 12) + hlen;
  const header = buf.toString('latin1', major === 1 ? 10 : 12, start);
  const descr = /'descr':\s*'([^']+)'/.exec(header)[1];
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header)[1].split(',').map(s => s.trim()).filter(Boolean).map(Number);
  const body = buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + buf.length);
  const Type = { '<u2': Uint16Array, '|u1': Uint8Array, '<f4': Float32Array, '<i2': Int16Array }[descr];
  if (!Type) throw new Error(`unsupported dtype ${descr}`);
  return { shape, data: new Type(body) };
}

function bbox(lat, lon) {
  const dLat = HALF_KM / 111.32, dLon = HALF_KM / (111.32 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/** Point on the river nearest the click (so the box is centred on water). */
function snapToRiver(lat, lon) {
  const reach = rivers.available() ? rivers.nearest(lat, lon, 5, 100) : null;
  if (!reach) return { point: [lat, lon], river: null };
  let best = reach.shape[0], bestD = Infinity;
  for (let i = 1; i < reach.shape.length; i++) {
    const [a, b] = [reach.shape[i - 1], reach.shape[i]];
    for (let t = 0; t <= 1; t += 0.1) {
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const d = (p[0] - lat) ** 2 + ((p[1] - lon) * Math.cos(lat * Math.PI / 180)) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  // the click may already be on water (wide rivers, lakes): keep it if close to the channel
  const km = Math.sqrt(bestD) * 111.32;
  return { point: km < 0.3 ? [lat, lon] : best, river: reach };
}

/** Dogliotti et al. (2015) turbidity (FNU) from water-leaving reflectance (as surface reflectance). */
// The algorithm is calibrated up to ~1000 FNU; near-infrared close to its constant C (0.2112)
// makes it blow up, so results are capped there and flagged.
const MAX_FNU = 1000;
function dogliottiFnu(red, nir) {
  const tRed = red < 0.1641 ? (228.1 * red) / (1 - red / 0.1641) : MAX_FNU;
  const tNir = nir < 0.2112 ? (3078.9 * nir) / (1 - nir / 0.2112) : MAX_FNU;
  if (red < 0.05) return tRed;
  if (red > 0.07) return tNir;
  const w = (red - 0.05) / 0.02; // blend between 0.05 and 0.07
  return Math.min(MAX_FNU, (1 - w) * tRed + w * tNir);
}

function median(arr) {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const turbidityClass = fnu => (fnu < 10 ? 'clear' : fnu < 50 ? 'moderately turbid' : fnu < 150 ? 'turbid' : fnu < 500 ? 'very turbid' : 'extremely turbid (heavy sediment)');
const chlorophyllClass = ndci => (ndci < 0 ? 'low' : ndci < 0.1 ? 'moderate' : ndci < 0.2 ? 'high' : 'very high (possible algal bloom)');

/** Analyse one Sentinel-2 scene over the box; null if not enough clear water. */
async function analyseScene(item, box) {
  const q = `collection=sentinel-2-l2a&item=${encodeURIComponent(item.id)}&${BANDS.map(b => `assets=${b}`).join('&')}&max_size=${PX}`;
  const res = await fetchRetry(`${DATA}/bbox/${box.map(v => v.toFixed(5)).join(',')}.npy?${q}`, { timeoutMs: 45000 });
  if (!res.ok) return null;
  const { shape, data } = parseNpy(Buffer.from(await res.arrayBuffer()));
  const n = shape[1] * shape[2];
  const band = k => data.subarray(k * n, (k + 1) * n);
  const [g, r, re, nir, scl] = [0, 1, 2, 3, 4].map(band);
  const valid = shape[0] > 5 ? band(5) : null;
  // Processing baseline 04.00+ (2022-01-25 onwards) stores reflectance with a +1000 offset
  const offset = parseFloat(item.properties['s2:processing_baseline'] || '0') >= 4 ? 1000 : 0;
  const refl = v => (v - offset) / 10000;
  let water = 0, cloudy = 0;
  const fnu = [], ndci = [], ndti = [];
  for (let i = 0; i < n; i++) {
    if (valid && !valid[i]) continue;
    const c = scl[i];
    if (c === 8 || c === 9 || c === 10 || c === 3) cloudy++; // cloud medium/high, cirrus, cloud shadow
    if (c !== 6) continue; // water only
    const G = refl(g[i]), R = refl(r[i]), RE = refl(re[i]), N = refl(nir[i]);
    // invalid reflectance only: very muddy rivers are genuinely bright in red (0.1-0.2), so no "glint" cut
    if (!(G > 0 && R > 0 && RE > 0 && N >= 0) || R > 0.4) continue;
    water++;
    fnu.push(dogliottiFnu(R, N));
    ndci.push((RE - R) / (RE + R));
    ndti.push((R - G) / (R + G));
  }
  if (water < MIN_WATER_PX) return null;
  const f = median(fnu), c = median(ndci);
  return {
    date: item.properties.datetime.slice(0, 10),
    sceneCloudPct: Math.round(item.properties['eo:cloud_cover']),
    waterPixels: water,
    waterAreaHa: +(water * ((2 * HALF_KM * 1000) / shape[2]) * ((2 * HALF_KM * 1000) / shape[1]) / 1e4).toFixed(1),
    cloudOverBoxPct: Math.round((cloudy / n) * 100),
    turbidityFnu: +f.toFixed(1),
    turbiditySaturated: f >= MAX_FNU,
    // narrow rivers: 10-20 m pixels mix water with bright riverbank, which inflates turbidity
    confidence: water * ((2 * HALF_KM * 1000) / shape[2]) * ((2 * HALF_KM * 1000) / shape[1]) / 1e4 >= 50 ? 'good'
      : water * ((2 * HALF_KM * 1000) / shape[2]) * ((2 * HALF_KM * 1000) / shape[1]) / 1e4 >= 15 ? 'fair' : 'low',
    turbidityClass: turbidityClass(f),
    ndci: +c.toFixed(3),
    chlorophyllClass: chlorophyllClass(c),
    ndti: +median(ndti).toFixed(3),
    imageUrl: `${DATA}/bbox/${box.map(v => v.toFixed(5)).join(',')}.png?collection=sentinel-2-l2a&item=${encodeURIComponent(item.id)}&assets=visual&max_size=512`,
    itemId: item.id,
  };
}

const READING_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two sentences: what the water looks like and what the numbers mean.' },
    image_observations: { type: 'array', items: { type: 'string' }, description: '2-4 things visible in the image (water colour, plumes, algae, banks, outfalls).' },
    likely_causes: { type: 'array', items: { type: 'string' }, description: '1-3 plausible causes, stated as possibilities.' },
    advice: { type: 'array', items: { type: 'string' }, description: '1-3 practical next steps (e.g. field sampling for DO/BOD).' },
  },
  required: ['summary', 'image_observations', 'likely_causes', 'advice'],
};

async function interpret(latest, trend, placeName) {
  try {
    const img = await fetchRetry(latest.imageUrl, { timeoutMs: 30000 });
    if (!img.ok) throw new Error(`image HTTP ${img.status}`);
    const base64 = Buffer.from(await img.arrayBuffer()).toString('base64');
    const system = `You are a water-quality analyst. You get a Sentinel-2 true-colour image (about 3 × 3 km,
north up) of a river or lake and optical water-quality estimates for its water pixels. Explain them plainly.
RULES: describe only what is visible; treat the numbers as satellite estimates, not lab measurements; never
claim anything about dissolved oxygen, BOD, pH, metals or bacteria (satellites cannot see them); short sentences.`;
    const out = await gemma.generate({
      system,
      schema: READING_SCHEMA,
      contents: [{
        role: 'user', parts: [
          { text: `Place: ${placeName}\nLatest clear image: ${latest.date}\nEstimates (median of ${latest.waterPixels} water pixels):\n` +
            `- Turbidity ${latest.turbiditySaturated ? '≥ 1000' : latest.turbidityFnu} FNU (${latest.turbidityClass}), Dogliotti 2015\n- Chlorophyll index NDCI ${latest.ndci} (${latest.chlorophyllClass})\n` +
            `Trend (newest first): ${trend.map(t => `${t.date}: ${t.turbiditySaturated ? '≥ 1000' : t.turbidityFnu} FNU, NDCI ${t.ndci}`).join('; ')}` },
          { inline_data: { mime_type: 'image/png', data: base64 } },
        ],
      }],
    });
    const r = gemma.parseJson(out.text);
    const list = v => (Array.isArray(v) ? v : []).slice(0, 4).map(x => String(x).slice(0, 240));
    return {
      source: out.gemma ? 'gemma' : 'backup', model: out.model,
      summary: String(r.summary || '').slice(0, 500),
      image_observations: list(r.image_observations), likely_causes: list(r.likely_causes), advice: list(r.advice),
    };
  } catch (err) {
    console.warn('[water] AI reading unavailable:', err.message);
    return null;
  }
}

async function assess({ lat, lon, name }) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 80 || Math.abs(lon) > 180) {
    throw httpError(400, 'Valid lat and lon are required.');
  }
  const t0 = Date.now();
  const { point, river } = snapToRiver(lat, lon);
  const box = bbox(point[0], point[1]);
  const now = Date.now();
  const search = await fetchRetry(STAC, {
    method: 'POST', headers: { 'content-type': 'application/json' }, timeoutMs: 30000,
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      intersects: { type: 'Point', coordinates: [point[1], point[0]] },
      datetime: `${new Date(now - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10)}/${new Date(now).toISOString().slice(0, 10)}`,
      query: { 'eo:cloud_cover': { lt: 60 } },
      sortby: [{ field: 'datetime', direction: 'desc' }],
      limit: 20,
    }),
  });
  if (!search.ok) throw httpError(502, 'The Sentinel-2 catalogue is unavailable right now. Try again.');
  const items = (await search.json()).features || [];
  if (!items.length) throw httpError(404, `No Sentinel-2 image with under 60 % cloud in the last ${LOOKBACK_DAYS} days here.`);

  // Newest first; keep scenes with enough clear water, at most one per day (tiles overlap)
  const scenes = [];
  const seenDays = new Set();
  for (const item of items) {
    if (scenes.length >= MAX_IMAGES) break;
    const day = item.properties.datetime.slice(0, 10);
    if (seenDays.has(day)) continue;
    try {
      const s = await analyseScene(item, box);
      if (s && s.cloudOverBoxPct < 30) { scenes.push(s); seenDays.add(day); }
    } catch (err) {
      console.warn('[water] scene failed:', item.id, err.message);
    }
    if (Date.now() - t0 > 45000) break; // keep the request reasonably quick
  }
  if (!scenes.length) {
    throw httpError(404, 'No clear view of open water here in recent images (clouds, or the river is narrower than ~20 m). Try a wider river or a lake.');
  }
  const latest = scenes[0];
  const placeName = String(name || '').slice(0, 120) || `${point[0].toFixed(3)}, ${point[1].toFixed(3)}`;
  const reading = await interpret(latest, scenes, placeName);
  return {
    place: placeName,
    point, box,
    river: river && { meanDischargeCms: river.meanDischargeCms, upstreamAreaKm2: river.upstreamAreaKm2 },
    latest,
    trend: scenes,
    reading,
    notMeasured: ['Dissolved oxygen (DO)', 'Biochemical oxygen demand (BOD)', 'pH', 'Heavy metals and chemicals', 'Bacteria (coliforms)'],
    method: [
      'Water pixels: Sentinel-2 scene classification (SCL = water); glint and mixed pixels removed.',
      'Turbidity: Dogliotti et al. (2015) single-band algorithm on surface reflectance (red 665 nm; NIR 865 nm when very turbid). Valid up to ~1000 FNU (higher values are shown as ≥ 1000). Classes: < 10 clear, 10–50 moderate, 50–150 turbid, 150–500 very turbid, > 500 FNU extremely turbid.',
      'Chlorophyll: NDCI (Mishra & Mishra 2012) = (B05 − B04)/(B05 + B04); < 0 low, 0–0.1 moderate, 0.1–0.2 high, > 0.2 very high. Turbid water can raise NDCI too.',
      'Values are medians over the water inside a 3 × 3 km box, from the newest clear images of the last ~4 months.',
    ],
    sources: ['ESA Copernicus Sentinel-2 L2A via Microsoft Planetary Computer', 'HydroRIVERS (river snap)'],
    tookMs: Date.now() - t0,
  };
}

module.exports = { assess, parseNpy, dogliottiFnu };
