/**
 * Earth Intelligence Platform — Hazard Lens (hazard.js)
 * =====================================================
 * POST /api/v1/hazard { lat, lon, name? }
 *
 * For any point on Earth, gathers in parallel:
 *   - a satellite image of the area          (Esri World Imagery)
 *   - terrain relief and slope               (Open-Meteo elevation, Copernicus DEM 90 m)
 *   - rainfall: past 7 days + next 3 days    (Open-Meteo forecast)
 *   - river discharge forecast vs. normal    (GloFAS v4 via Open-Meteo Flood API)
 *   - the nearest river and its downstream   (HydroRIVERS / HydroSHEDS)
 *   - soil profile                           (ISRIC SoilGrids, when it answers in time)
 * …then asks Gemma 4 to read the IMAGE together with the DATA and return a structured
 * hazard assessment. Each data block says where it came from; missing data is reported,
 * never invented.
 */
'use strict';

const gemma = require('./gemma.js');
const rivers = require('./rivers.js');
const brain = require('../frontend/forest-eyes/treeko-brain.js');
const terrainTiles = require('./elevation.js');
const soilIndia = require('./soil.js');

const IMG_SPAN_DEG = 0.06;   // ~6.5 km wide at the equator
const IMG_PX = 768;

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One sentence: the most important finding for this place.' },
    overall_level: { type: 'string', enum: ['low', 'moderate', 'high', 'very_high'] },
    image_observations: {
      type: 'array', items: { type: 'string' },
      description: '3-5 concrete things visible in the satellite image (land cover, river channel, scars, settlements, ice, bare slopes).',
    },
    hazards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['flood', 'landslide', 'debris_flow', 'erosion_sediment', 'deforestation', 'drought_low_flow', 'glacial', 'other'] },
          level: { type: 'string', enum: ['low', 'moderate', 'high', 'very_high'] },
          evidence_image: { type: 'string', description: 'What in the image supports this, or "not visible".' },
          evidence_data: { type: 'string', description: 'Which numbers from the data support this, quoted with units.' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['type', 'level', 'evidence_image', 'evidence_data', 'confidence'],
      },
    },
    actions: { type: 'array', items: { type: 'string' }, description: '2-4 practical next steps for local authorities or field teams.' },
    data_gaps: { type: 'array', items: { type: 'string' }, description: 'What is missing or uncertain and should be checked on the ground.' },
  },
  required: ['headline', 'overall_level', 'image_observations', 'hazards', 'actions', 'data_gaps'],
};

const LEVELS = new Set(['low', 'moderate', 'high', 'very_high']);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function getJson(url, ms = 15000) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
    } catch (err) {
      // dropped connection / DNS blip: retry twice, like rate limits below
      if (attempt < 2) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
      throw err;
    }
    // free APIs rate-limit bursts: wait and retry twice before giving up
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

// GloFAS history per grid cell changes once a day: cache it for 6 h
const historyCache = new Map();

const round = (v, d = 1) => (Number.isFinite(v) ? +v.toFixed(d) : null);
const isoDay = t => new Date(t).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------
function bbox(lat, lon) {
  const h = IMG_SPAN_DEG / 2;
  const w = h / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  return [lon - w, lat - h, lon + w, lat + h];
}

async function satelliteImage(lat, lon) {
  const [w, s, e, n] = bbox(lat, lon);
  const url = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export' +
    `?bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=3857&size=${IMG_PX},${IMG_PX}&format=jpg&f=image`;
  // The image is what Gemma 4 reads: retry a dropped or failed download twice
  let buf, lastErr;
  for (let attempt = 0; attempt < 3 && !buf; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const b = Buffer.from(await res.arrayBuffer());
      if (b.length < 5000) throw new Error('empty image');
      buf = b;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  if (!buf) throw lastErr;
  return { base64: buf.toString('base64'), bbox: [w, s, e, n], source: 'Esri World Imagery (Maxar, Earthstar Geographics)' };
}

async function terrain(lat, lon) {
  // Centre + 8 points on a ~1 km ring: relief and steepest slope around the point.
  const r = 0.009, k = Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const pts = [[lat, lon]];
  for (let a = 0; a < 8; a++) {
    const t = a * Math.PI / 4;
    pts.push([lat + r * Math.sin(t), lon + (r * Math.cos(t)) / k]);
  }
  let z, source = terrainTiles.SOURCE;
  try {
    z = await terrainTiles.elevations(pts);
  } catch {
    const j = await getJson('https://api.open-meteo.com/v1/elevation' +
      `?latitude=${pts.map(p => p[0].toFixed(5)).join(',')}&longitude=${pts.map(p => p[1].toFixed(5)).join(',')}`);
    z = j.elevation;
    source = 'Copernicus DEM GLO-90 via Open-Meteo';
  }
  if (!Array.isArray(z) || z.length !== pts.length) throw new Error('bad elevation response');
  const ringKm = r * 111.32;
  const slopes = z.slice(1).map(v => Math.atan(Math.abs(v - z[0]) / (ringKm * 1000)) * 180 / Math.PI);
  return {
    elevation_m: Math.round(z[0]),
    relief_within_1km_m: Math.round(Math.max(...z) - Math.min(...z)),
    max_slope_deg: round(Math.max(...slopes)),
    mean_slope_deg: round(slopes.reduce((a, b) => a + b, 0) / slopes.length),
    source: `${source} (slope over ~1 km, underestimates local cliffs)`,
  };
}

async function rainfall(lat, lon) {
  const j = await getJson('https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat}&longitude=${lon}&daily=precipitation_sum,temperature_2m_max,temperature_2m_min` +
    '&past_days=7&forecast_days=3&timezone=auto');
  const d = j.daily || {};
  const p = d.precipitation_sum || [];
  const today = p.length - 3;
  const sum = arr => round(arr.reduce((a, b) => a + (b || 0), 0));
  return {
    past_7_days_mm: sum(p.slice(0, today)),
    next_3_days_mm: sum(p.slice(today)),
    wettest_day: p.length ? { date: d.time[p.indexOf(Math.max(...p))], mm: round(Math.max(...p)) } : null,
    temp_today_c: d.temperature_2m_max ? { min: d.temperature_2m_min[today], max: d.temperature_2m_max[today] } : null,
    source: 'Open-Meteo weather forecast + recent model reanalysis',
  };
}

async function flowHistory(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.job;
  const job = flowHistoryFetch(lat, lon);
  historyCache.set(key, { at: Date.now(), job });
  job.catch(() => historyCache.delete(key));
  if (historyCache.size > 2000) historyCache.delete(historyCache.keys().next().value);
  return job;
}

async function flowHistoryFetch(lat, lon) {
  const now = Date.now();
  const j = await getJson('https://flood-api.open-meteo.com/v1/flood' +
    `?latitude=${lat}&longitude=${lon}&daily=river_discharge` +
    `&start_date=${isoDay(now - 3 * 365 * 864e5)}&end_date=${isoDay(now - 8 * 864e5)}`);
  const time = j.daily?.time || [];
  const q = (j.daily?.river_discharge || []).map(Number);
  const valid = q.filter(Number.isFinite).sort((x, y) => x - y);
  if (!valid.length) throw new Error('no GloFAS cell here');
  return { lat, lon, time, q, sorted: valid, mean: valid.reduce((x, y) => x + y, 0) / valid.length };
}

/**
 * GloFAS works on a ~5 km grid, so the cell under a point can sit on a side stream.
 * When we know the main river (HydroRIVERS), try cells along that reach and keep the one
 * whose long-term mean flow is closest to the river's.
 */
async function riverFlow(lat, lon, reach) {
  const candidates = [[lat, lon]];
  if (reach) {
    candidates.push(reach.start, reach.end, [(reach.start[0] + reach.end[0]) / 2, (reach.start[1] + reach.end[1]) / 2]);
    // GloFAS cells are 0.05 deg: also try the neighbours of the reach midpoint
    const [mLat, mLon] = candidates[3];
    for (const [dy, dx] of [[0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.05]]) candidates.push([mLat + dy, mLon + dx]);
  }
  const results = (await Promise.all(candidates.map(([a, o]) => flowHistory(a, o).catch(() => null)))).filter(Boolean);
  if (!results.length) throw new Error('no GloFAS cell here');
  const target = reach?.meanDischargeCms;
  const best = target > 0
    ? results.reduce((p, c) => Math.abs(Math.log((c.mean + 0.1) / target)) < Math.abs(Math.log((p.mean + 0.1) / target)) ? c : p)
    : results[0];

  const fc = await getJson('https://flood-api.open-meteo.com/v1/flood' +
    `?latitude=${best.lat}&longitude=${best.lon}&daily=river_discharge,river_discharge_max&past_days=7&forecast_days=14`);
  const q = (fc.daily?.river_discharge || []).map(Number);
  const qmax = (fc.daily?.river_discharge_max || []).map(Number);
  if (!q.length) throw new Error('no GloFAS forecast here');

  const pct = p => best.sorted[Math.min(best.sorted.length - 1, Math.floor(p * best.sorted.length))];
  // Median of the yearly maxima ≈ the 2-year flood: a common "bankfull" warning level.
  // Only (nearly) complete calendar years: a partial year can miss its flood season and drag the median down.
  const years = {};
  best.time.forEach((t, i) => {
    const y = t.slice(0, 4), v = best.q[i];
    if (!Number.isFinite(v)) return;
    const yr = years[y] || (years[y] = { max: 0, days: 0 });
    yr.max = Math.max(yr.max, v);
    yr.days++;
  });
  const full = Object.values(years).filter(y => y.days >= 330);
  const maxima = (full.length ? full : Object.values(years)).map(y => y.max).sort((x, y) => x - y);
  const twoYear = maxima[Math.floor(maxima.length / 2)];
  const todayIdx = 7;
  const peak = Math.max(...q.slice(todayIdx));
  const peakUpper = Math.max(...qmax.slice(todayIdx).filter(Number.isFinite), peak);
  return {
    today_cms: round(q[todayIdx]),
    // "Normal" for this time of year: same calendar window (±15 days) in the previous ~3 years.
    // Comparing with the annual mean would call every dry season a drought.
    seasonal_normal_cms: round(seasonalNormal(best, fc.daily.time[todayIdx])),
    forecast_peak_14d_cms: round(peak),
    forecast_peak_date: fc.daily.time[todayIdx + q.slice(todayIdx).indexOf(peak)],
    ensemble_upper_peak_cms: round(peakUpper),
    mean_last_3y_cms: round(best.mean),
    p90_last_3y_cms: round(pct(0.9)),
    approx_2yr_flood_cms: round(twoYear),
    peak_vs_2yr_flood: twoYear ? round(peak / twoYear, 2) : null,
    grid_cell: [fc.latitude, fc.longitude],
    matched_to_river: !!(target > 0 && results.length > 1),
    // If even the best GloFAS cell's long-term flow is >3x off the river's, the forecast may be for
    // a side stream: say so instead of presenting it as this river's flow.
    match_quality: !(target > 0) ? 'unknown' : Math.abs(Math.log((best.mean + 0.1) / target)) <= Math.log(3) ? 'good' : 'poor',
    source: 'GloFAS v4 (Copernicus EMS) via Open-Meteo Flood API, ~5 km grid; 2-yr flood estimated from 3 years only',
  };
}

/** Mean discharge within ±15 days of `isoDate`'s day-of-year, across the history years. */
function seasonalNormal(hist, isoDate) {
  const doy = t => Math.floor((Date.parse(t) - Date.UTC(+t.slice(0, 4), 0, 1)) / 864e5);
  const target = doy(isoDate);
  const vals = [];
  hist.time.forEach((t, i) => {
    const dd = Math.abs(doy(t) - target);
    if (Math.min(dd, 365 - dd) <= 15 && Number.isFinite(hist.q[i])) vals.push(hist.q[i]);
  });
  return vals.length >= 20 ? vals.reduce((a, b) => a + b, 0) / vals.length : hist.mean;
}

function nearestRiver(lat, lon) {
  if (!rivers.available()) return null;
  const reach = rivers.nearest(lat, lon, 25);
  if (!reach) return { none_within_km: 25, note: 'No river with >= 1000 km2 catchment within 25 km.' };
  const down = rivers.downstream(reach.id, 300);
  return {
    distance_km: reach.distanceKm,
    mean_discharge_cms: reach.meanDischargeCms,
    upstream_area_km2: reach.upstreamAreaKm2,
    strahler_order: reach.strahlerOrder,
    distance_to_mouth_km: reach.distanceToMouthKm,
    downstream_300km: down && { length_km: down.lengthKm, discharge_at_end_cms: down.dischargeAtEndCms },
    _path: down?.path || [],
    _reach: reach,
    source: 'HydroRIVERS v1.0 (HydroSHEDS), long-term modelled mean discharge',
  };
}

async function soil(lat, lon) {
  // India: instant lookup from the local grid; elsewhere the SoilGrids API
  if (soilIndia.inside(lat, lon)) {
    const s = soilIndia.lookup(lat, lon, 8);
    if (!s) return null;
    return {
      summary: `${s.textureClass} topsoil (0-30 cm): clay ${s.clayPct}%, silt ${s.siltPct}%, sand ${s.sandPct}%, ` +
        `stones ${s.coarseFragmentsPct} vol%, bulk density ${s.bulkDensity} kg/dm3, organic carbon ${s.organicCarbonGkg} g/kg, pH ${s.pH}` +
        (s.distanceKm ? ` (nearest soil data ${s.distanceKm} km away; the point itself is water, rock or built-up)` : ''),
      source: s.source,
    };
  }
  const s = await brain.getSoil(lat, lon, fetch, 20000);
  if (!s?.hasData) return null;
  return { summary: s.text.slice(0, 1500), source: 'ISRIC SoilGrids 2.0 (modelled, 250 m)' };
}

/**
 * Tree cover loss 2021-2024 in a ~10 km box (UMD / Hansen et al., natural forest), via the keyless
 * Global Nature Watch analytics API. It runs as a job, so allow ~30 s.
 */
async function treeLoss(lat, lon, halfKm = 5) {
  const dLat = halfKm / 111, dLon = halfKm / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const fc = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', id: `lens-${Date.now()}`, properties: {},
      geometry: { type: 'Polygon', coordinates: [[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]] },
    }],
  };
  const base = 'https://analytics.globalnaturewatch.org/v0/land_change/tree_cover_loss/analytics';
  const res = await fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ aoi: { type: 'feature_collection', feature_collection: fc }, start_year: '2021', end_year: '2024', forest_filter: 'natural_forest', intersections: [] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const id = (await res.json())?.data?.link?.split('/').pop();
  if (!id) throw new Error('no job id');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const j = (await getJson(`${base}/${id}`, 10000))?.data;
    if (j?.status === 'saved' || j?.status === 'success') {
      const r = j.result || {};
      const byYear = {};
      (r.tree_cover_loss_year || []).forEach((y, i) => {
        if (r.natural_forests_class?.[i] !== 'Natural Forest') return;
        byYear[y] = (byYear[y] || 0) + Number(r.area_ha?.[i] || 0);
      });
      const total = Object.values(byYear).reduce((a, b) => a + b, 0);
      return {
        natural_forest_loss_ha_by_year: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, round(v, 1)])),
        total_2021_2024_ha: round(total, 1),
        area_km2: Math.round((2 * halfKm) ** 2),
        source: 'UMD / Hansen tree cover loss (natural forest) via Global Nature Watch',
      };
    }
    if (j?.status === 'failed') throw new Error('job failed');
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('timed out');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function assess({ lat, lon, name, focus }) {
  focus = focus === 'forest' ? 'forest' : 'river';
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    throw httpError(400, 'Valid lat and lon are required.');
  }
  const place = String(name || '').slice(0, 120) || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const t0 = Date.now();
  console.log(`[hazard] assessing ${place}`);

  const settle = (p, label) => p.then(v => v, err => {
    console.warn(`[hazard] ${label} unavailable:`, err.message);
    return null;
  });
  const river = nearestRiver(lat, lon);
  const [image, terr, rain, flow, soilData, loss] = await Promise.all([
    settle(satelliteImage(lat, lon), 'image'),
    settle(terrain(lat, lon), 'terrain'),
    settle(rainfall(lat, lon), 'rainfall'),
    settle(riverFlow(lat, lon, river?._reach), 'river flow'),
    settle(soil(lat, lon), 'soil'),
    focus === 'forest' ? settle(treeLoss(lat, lon), 'tree loss') : Promise.resolve(undefined),
  ]);

  const data = {
    place, centre: [round(lat, 5), round(lon, 5)],
    image_footprint_km: round(IMG_SPAN_DEG * 111.32, 1),
    terrain: terr, rainfall: rain, river_flow_forecast: flow,
    nearest_river: river && Object.fromEntries(Object.entries(river).filter(([k]) => !k.startsWith('_'))),
    soil: soilData,
    ...(focus === 'forest' ? { tree_cover_loss: loss } : {}),
  };
  const missing = Object.entries({ satellite_image: image, terrain: terr, rainfall: rain, river_flow_forecast: flow, nearest_river: river, soil: soilData,
    ...(focus === 'forest' ? { tree_cover_loss: loss } : {}) })
    .filter(([, v]) => !v).map(([k]) => k);

  const system = `You are the Hazard Lens of the Earth Intelligence Platform, an expert in hydrology,
geomorphology, natural hazards and forest ecology. You are given a satellite image centred on the place
(about ${data.image_footprint_km} km across, north up) and measured/modelled data for the same place.

Assess natural hazards for the people and environment at this place: floods, landslides, debris flows,
erosion and sediment, deforestation, drought/low flow, glacial hazards.
RULES
- Combine what you SEE in the image with the NUMBERS in the data. Quote numbers with units.
- Only describe what is actually visible. If the image is unclear or missing, say "not visible".
- Do not invent measurements, events or place names. If data is missing, list it in data_gaps.
- peak_vs_2yr_flood >= 1 means the forecast peak reaches roughly a 2-year flood; treat as a warning sign.
- Steep slopes (>25 deg), high relief, heavy recent rain, bare scars and sediment-laden channels raise landslide/debris-flow concern.
- If the GloFAS mean flow is far from the HydroRIVERS mean discharge, the flood grid cell may be on a different stream: lower your confidence and say so.
- ${focus === 'forest'
    ? 'FOCUS: forests. Lead with deforestation and land-cover change (clearings, plantations, burn scars, roads into forest) and the hazards it drives (erosion, landslides, flash floods). Use tree_cover_loss numbers when present.'
    : 'FOCUS: rivers. Lead with floods, river flow, sediment, low flow and slope hazards along the river.'}
- This is a screening aid, not an official warning.
- Write every string as a normal, short English sentence with spaces (e.g. "Bare landslide scars on the slope above the town"), never hyphenated-keywords.`;

  const parts = [{ text: `DATA (JSON, from public sources):\n${JSON.stringify(data, null, 1)}\n\nMissing data: ${missing.join(', ') || 'none'}` }];
  if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image.base64 } });

  let reading = null, model = null, provider = null, aiError = null;
  try {
    const out = await gemma.generate({ system, contents: [{ role: 'user', parts }], schema: SCHEMA, timeoutMs: 45000 });
    reading = sanitize(gemma.parseJson(out.text));
    model = out.model; provider = out.provider;
  } catch (err) {
    aiError = err instanceof SyntaxError ? 'The model answer was not valid JSON.' : err.message;
  }
  // readingSource tells the UI exactly who produced the reading: 'gemma', 'gemini' (fallback) or 'rules'.
  const readingSource = !reading ? 'rules' : model.startsWith('gemma') ? 'gemma' : 'backup';
  if (!reading) reading = ruleReading(data, missing);

  console.log(`[hazard] ${place}: ${model ? `answered by ${provider}:${model}` : `rule-based reading (AI failed: ${aiError})`}, ` +
    `missing [${missing.join(', ')}], ${Date.now() - t0} ms`);
  return {
    place, lat, lon,
    reading, readingSource, model, provider, aiError,
    data, missing,
    image: image && { bbox: image.bbox, source: image.source },
    riverPath: river?._path || [],
    tookMs: Date.now() - t0,
  };
}

/**
 * Transparent rule-based reading, used ONLY when no AI model answered.
 * It never looks at the image, and the UI labels it as rule-based — never as Gemma.
 */
function ruleReading(data, missing) {
  const t = data.terrain, rain = data.rainfall, f = data.river_flow_forecast, rv = data.nearest_river;
  const order = ['low', 'moderate', 'high', 'very_high'];
  const bump = (lvl, n = 1) => order[Math.min(order.length - 1, order.indexOf(lvl) + n)];
  const hazards = [];
  const NO_IMAGE = 'Not analysed: rule-based reading cannot interpret images.';

  if (f && Number.isFinite(f.peak_vs_2yr_flood)) {
    const r = f.peak_vs_2yr_flood;
    let level = r >= 1.5 ? 'very_high' : r >= 1 ? 'high' : r >= 0.7 ? 'moderate' : 'low';
    if (rain?.next_3_days_mm >= 100 && level !== 'very_high') level = bump(level);
    hazards.push({
      type: 'flood', level, evidence_image: NO_IMAGE, confidence: f.matched_to_river ? 'medium' : 'low',
      evidence_data: `Forecast peak ${f.forecast_peak_14d_cms} m³/s on ${f.forecast_peak_date} is ${r}× the approximate 2-year flood (${f.approx_2yr_flood_cms} m³/s)` +
        (rain ? `; ${rain.next_3_days_mm} mm rain expected in 3 days.` : '.'),
    });
  }

  if (t) {
    let score = 0;
    if (t.max_slope_deg >= 30) score += 2; else if (t.max_slope_deg >= 20) score += 1;
    if (t.relief_within_1km_m >= 600) score += 1;
    if (rain && (rain.past_7_days_mm >= 100 || rain.next_3_days_mm >= 50)) score += 1;
    const level = order[Math.min(3, score)];
    hazards.push({
      type: 'landslide', level, evidence_image: NO_IMAGE, confidence: 'low',
      evidence_data: `Steepest slope ~${t.max_slope_deg}° and ${t.relief_within_1km_m} m relief within 1 km` +
        (rain ? `; ${rain.past_7_days_mm} mm rain in the past 7 days.` : '.'),
    });
  }

  if (f && f.seasonal_normal_cms > 0 && Number.isFinite(f.today_cms)) {
    const r = f.today_cms / f.seasonal_normal_cms;
    if (r < 0.5) {
      hazards.push({
        type: 'drought_low_flow', level: r < 0.25 ? 'high' : 'moderate', evidence_image: NO_IMAGE, confidence: 'low',
        evidence_data: `Flow today ${f.today_cms} m³/s is ${Math.round(r * 100)}% of normal for this time of year (${f.seasonal_normal_cms} m³/s, same dates in previous years).`,
      });
    }
  }

  const tl = data.tree_cover_loss;
  if (tl && Number.isFinite(tl.total_2021_2024_ha)) {
    const years = Object.entries(tl.natural_forest_loss_ha_by_year);
    const latest = years[years.length - 1];
    const level = tl.total_2021_2024_ha >= 100 ? 'high' : tl.total_2021_2024_ha >= 20 ? 'moderate' : 'low';
    hazards.push({
      type: 'deforestation', level, evidence_image: NO_IMAGE, confidence: 'medium',
      evidence_data: `${tl.total_2021_2024_ha} ha of natural forest lost in 2021-2024 within ~${tl.area_km2} km²` +
        (latest ? `; ${latest[1]} ha in ${latest[0]}.` : '.'),
    });
  }

  hazards.sort((a, b) => order.indexOf(b.level) - order.indexOf(a.level));
  const top = hazards[0];
  const overall = top ? top.level : 'low';
  const ACTIONS = {
    flood: 'Check official flood warnings and river gauges for this river.',
    landslide: 'Inspect slopes above settlements and roads for cracks or fresh scars.',
    drought_low_flow: 'Check water supply intakes and environmental flow requirements.',
    deforestation: 'Check recent clearing alerts (GLAD / RADD) and land-use permits for this area.',
  };
  return {
    headline: top
      ? `Rule-based screening: ${top.type.replace(/_/g, ' ')} concern is ${top.level.replace('_', ' ')} based on the numbers alone.`
      : 'Rule-based screening found no clear warning signs in the available data.',
    overall_level: overall,
    image_observations: [],
    hazards,
    actions: [...new Set(hazards.filter(h => h.level !== 'low').map(h => ACTIONS[h.type]).filter(Boolean))]
      .concat('Retry with Gemma 4 to include the satellite image in the assessment.'),
    data_gaps: [
      'The satellite image was not interpreted (no AI reading).',
      ...(rv?.mean_discharge_cms === undefined ? ['No major river found nearby.'] : []),
      ...missing.map(m => `Not available: ${m.replace(/_/g, ' ')}.`),
    ],
  };
}

/** Keeps the AI answer to the expected shape and sizes. */
function sanitize(r) {
  const str = (v, n = 400) => String(v ?? '').slice(0, n);
  const list = (v, n = 6) => (Array.isArray(v) ? v : []).slice(0, n).map(x => str(x, 300));
  return {
    headline: str(r.headline, 300),
    overall_level: LEVELS.has(r.overall_level) ? r.overall_level : 'moderate',
    image_observations: list(r.image_observations),
    hazards: (Array.isArray(r.hazards) ? r.hazards : []).slice(0, 8).map(h => ({
      type: str(h.type, 40), level: LEVELS.has(h.level) ? h.level : 'moderate',
      evidence_image: str(h.evidence_image), evidence_data: str(h.evidence_data),
      confidence: ['low', 'medium', 'high'].includes(h.confidence) ? h.confidence : 'low',
    })),
    actions: list(r.actions, 5),
    data_gaps: list(r.data_gaps, 6),
  };
}

module.exports = { assess, riverFlow, treeLoss, SCHEMA };
