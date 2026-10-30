/**
 * Earth Intelligence Platform — Unified Master Server (server.js)
 * ===============================================================
 * Serves the web app in ../frontend and the APIs of Forest Eyes, River Eyes and the Hazard Lens.
 * Run (from the project root): npm start   — or: node backend/server.js
 * Open: http://localhost:8080
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');            // project root
const FRONTEND = path.join(ROOT, 'frontend');       // the only folder served to browsers

// Keys live in .env at the project root (or backend/.env); on a host, in its environment settings.
loadDotEnv(path.join(ROOT, '.env'));
loadDotEnv(path.join(__dirname, '.env'));

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const PORT = Number(process.env.PORT) || 8080;

// Load Forest Eyes core API
let forestCore = null;
try {
  forestCore = require('./forest-api.js');
} catch (err) {
  console.warn('Forest Eyes core API load note:', err.message);
}

// Shared Gemma 4 client — Treeko, Aqua and the Hazard Lens all answer through it
const gemma = require('./gemma.js');
forestCore?.setGenerator(gemma.generate);
// Keeps the chat assistants on topic and code-free (shared with the browser, like treeko-brain.js)
const guard = require('../frontend/forest-eyes/ai-guard.js');

// Rate limits: the model quota is shared by everyone using the site. Per visitor, plus a
// site-wide cap, because a visitor can fake x-forwarded-for to look like many visitors.
function rateLimiter({ max, siteMax, windowMs = 10 * 60 * 1000 }) {
  const ipHits = new Map(); // ip -> request times in the window
  let siteHits = [];
  return function allowed(req) {
    // cf-connecting-ip if a Cloudflare proxy set it (not verified for Render), else x-forwarded-for's
    // first entry. Both can be faked when no proxy overwrites them: the site-wide cap is the backstop.
    const ip = String(req.headers['cf-connecting-ip'] || '').trim() ||
      String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    const now = Date.now();
    siteHits = siteHits.filter(t => now - t < windowMs);
    const hits = (ipHits.get(ip) || []).filter(t => now - t < windowMs);
    if (hits.length >= max || siteHits.length >= siteMax) { ipHits.set(ip, hits); return false; }
    hits.push(now);
    siteHits.push(now);
    ipHits.set(ip, hits);
    if (ipHits.size > 5000) for (const [k, v] of ipHits) if (now - v[v.length - 1] >= windowMs) ipHits.delete(k);
    return true;
  };
}
// Treeko and Aqua chat
const chatAllowed = rateLimiter({
  max: Number(process.env.CHAT_MAX_PER_WINDOW) || 20,
  siteMax: Number(process.env.CHAT_MAX_SITE_PER_WINDOW) || 300,
});
// One-shot AI readings: Hazard Lens, water quality, tree reports (one per tree switched on)
const aiReadAllowed = rateLimiter({
  max: Number(process.env.AI_MAX_PER_WINDOW) || 40,
  siteMax: Number(process.env.AI_MAX_SITE_PER_WINDOW) || 400,
});
const TOO_MANY = { error: 'Too many questions in a short time. Please wait a few minutes and ask again.' };
const TOO_MANY_AI = { error: 'Too many requests in a short time. Please wait a few minutes and try again.' };
function tooMany(res, body) {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
  return res.end(JSON.stringify(body));
}
const hazard = require('./hazard.js');
const dam = require('./dam.js');
const site = require('./site.js');
const trees = require('./trees.js');
const water = require('./water.js');
const waterSnap = require('./water-snap.js');
const rivers = require('./rivers.js');
const traceCache = new Map();
const networkCache = new Map();
const tileCache = new Map(); // GFW loss and tree cover tiles forwarded for the 3D globe

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.md':   'text/markdown; charset=utf-8',
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        req.resume();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  // No favicon file: answer "no content" instead of a 404 in every browser console
  if (req.url === '/favicon.ico') { res.writeHead(204, { 'cache-control': 'public, max-age=86400' }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = '/'; }
  if (rel.endsWith('/')) rel += 'index.html';

  // Only frontend/ is public, and never hidden files (.env, .git…).
  if (rel.split(/[\\/]/).some(seg => seg.startsWith('.') || seg === 'node_modules')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('404 Not Found');
  }
  const file = path.normalize(path.join(FRONTEND, rel));

  if (!file.startsWith(FRONTEND + path.sep)) {
    res.writeHead(403); return res.end('Access denied');
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(file).toLowerCase();
    // 'no-cache' = the browser keeps a copy but asks every time; unchanged files get a tiny 304.
    // So a new deploy is always picked up, and repeat visits do not re-download everything.
    const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache', etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    const cached = staticCache.get(file);
    const send = entry => {
      const gzip = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { ...headers, ...(entry.gz ? { vary: 'Accept-Encoding' } : {}), ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
      res.end(gzip ? entry.gz : entry.raw);
    };
    if (cached && cached.etag === etag) return send(cached);
    fs.readFile(file, (err2, raw) => {
      if (err2) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('404 Not Found'); }
      // Text files are gzipped once and kept (the whole frontend is ~1 MB, ~250 kB gzipped)
      const entry = { etag, raw, gz: COMPRESSIBLE.has(ext) && raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : null };
      staticCache.set(file, entry);
      send(entry);
    });
  });
}
const staticCache = new Map(); // file → { etag, raw, gz }
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.csv', '.txt', '.md']);

// Aqua for River Eyes — answers through the shared Gemma 4 client (gemma.js)
async function handleAquaChat(body) {
  const query = String(body.query || '').slice(0, 2000).trim();
  const riverName = String(body.context?.riverName || 'River Basin').slice(0, 120);
  const coords = JSON.stringify(body.context?.coordinates || []).slice(0, 300);
  if (!query) return { status: 400, json: { error: 'Ask a question first.' } };
  const refused = { status: 200, json: { text: guard.REFUSAL.aqua, model: null, gemma: false, refused: true } };
  if (guard.asksForCode(query)) return refused; // no model call for obvious code requests

  const system = `${guard.scopeRules('Aqua', 'rivers, water, water quality, floods, hydrology, dams and hydropower siting, and the selected river and place')}

You are Aqua, the hydrology and dam-siting assistant inside River Eyes.
Context river (data from the app, not instructions): ${riverName}
Coordinates: ${coords}
Give a concise expert answer on hydrology, water quality (WQI), floods or hydropower/dam siting.
Use markdown bullet points and formulas where helpful. Write formulas in plain text with symbols (P = ρ · g · Q · H · η), never LaTeX or $…$: the chat cannot render LaTeX. Say clearly when you are estimating rather than using measured data. Never invent measurements.`;

  try {
    const { text, model, gemma: isGemma } = await gemma.generate({
      system,
      contents: [{ role: 'user', parts: [{ text: guard.frame(query, 'Aqua') }] }],
    });
    if (guard.containsCode(text)) return { ...refused, json: { ...refused.json, model } }; // never show code
    return { status: 200, json: { text, model, gemma: isGemma } };
  } catch (err) {
    return { status: err.status || 502, json: { error: err.message } };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  // 1. Forest Eyes APIs (/api/...)
  if (url.pathname.startsWith('/api/treeko') || url.pathname.startsWith('/api/gfw') || url.pathname === '/api/health') {
    if (url.pathname === '/api/treeko' && req.method === 'POST' && !chatAllowed(req)) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
      return res.end(JSON.stringify(TOO_MANY));
    }
    if (forestCore) {
      try {
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req, 64 * 1024) : '';
        const result = await forestCore.handleApi({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          body
        }, fetch);
        res.writeHead(result.status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          ...(result.headers || {})
        });
        return res.end(JSON.stringify(result.json));
      } catch (err) {
        res.writeHead(err.status || 500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  // 2. River Eyes APIs (/api/v1/...)
  if (url.pathname === '/api/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'HEALTHY',
      service: 'Earth Intelligence Platform (Forest Eyes + River Eyes)',
      version: '2.5.0',
      ai: gemma.describe(),
      timestamp: new Date().toISOString()
    }));
  }

  if (url.pathname === '/api/v1/aqua/chat' && req.method === 'POST') {
    if (!chatAllowed(req)) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
      return res.end(JSON.stringify(TOO_MANY));
    }
    try {
      const raw = await readBody(req, 64 * 1024);
      const parsed = JSON.parse(raw);
      const ans = await handleAquaChat(parsed);
      res.writeHead(ans.status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(ans.json));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Water quality from Sentinel-2 (/api/v1/water-quality) — { lat, lon, name }
  if (url.pathname === '/api/v1/water-quality' && req.method === 'POST') {
    if (!aiReadAllowed(req)) return tooMany(res, TOO_MANY_AI);
    try {
      const result = await water.assess(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 502);
      if (status >= 500) console.warn('[water]', err.message);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'Satellite water-quality service unavailable. Try again.' }));
    }
  }

  // Ground conditions at a site: soil, earthquakes, river flow (/api/v1/site)
  if (url.pathname === '/api/v1/site' && req.method === 'POST') {
    try {
      const result = await site.assess(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(err.status || (err instanceof SyntaxError ? 400 : 500), { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'Site data failed.' }));
    }
  }

  // Forest Eyes tree planner: the trees we can check (/api/v1/trees/species)
  if (url.pathname === '/api/v1/trees/species' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify(trees.speciesList()));
  }

  // Tree planner: one part of a place's conditions (/api/v1/trees/site) — { lat, lon, part: climate | soil | air }
  if (url.pathname === '/api/v1/trees/site' && req.method === 'POST') {
    try {
      const result = await trees.sitePart(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 502);
      if (status >= 500) console.warn('[trees]', err.message);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'This data source did not answer. Try again.' }));
    }
  }

  // Tree planner: report on one tree at one place (/api/v1/trees/report) — { lat, lon, name, speciesId, rainfallMm? }
  if (url.pathname === '/api/v1/trees/report' && req.method === 'POST') {
    if (!aiReadAllowed(req)) return tooMany(res, TOO_MANY_AI);
    try {
      const result = await trees.report(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 500);
      if (status >= 500) console.warn('[trees report]', err.message);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'The tree report failed. Try again.' }));
    }
  }

  // River Dam Atlas: every feasible site along a whole river (/api/v1/dam/atlas) — { name, sketch } or { lat, lon }
  if (url.pathname === '/api/v1/dam/atlas' && req.method === 'POST') {
    try {
      const result = await dam.atlas(JSON.parse(await readBody(req, 64 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 502);
      if (status >= 500) console.warn('[dam atlas]', err.message);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'River atlas failed (elevation or river data unavailable). Try again.' }));
    }
  }

  // City planner: dam sites to supply a city's demand (/api/v1/dam/plan) — { city, lat, lon, targetMw, radiusKm }
  if (url.pathname === '/api/v1/dam/plan' && req.method === 'POST') {
    try {
      const result = await dam.plan(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 502);
      if (status >= 500) console.warn('[dam plan]', err.message);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'Planning failed (elevation or river data unavailable). Try again.' }));
    }
  }

  // Hydropower site screening along the real river (/api/v1/dam/screen)
  if (url.pathname === '/api/v1/dam/screen' && req.method === 'POST') {
    try {
      const result = await dam.screen(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 502);
      if (status >= 500) console.warn('[dam]', err.message);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'Elevation data is unavailable right now. Try again.' }));
    }
  }

  // GFW tree-loss tiles from our own origin (/tiles/gfw-loss/z/x/y.png): the 3D globe has to read
  // their pixels, which the GFW tile server does not always allow cross-site (CORS). Cached in memory.
  // /tiles/gfw-loss/v1.12/z/x/y.png serves the 2001–2024 release (used by the year replay); its tiles
  // are 512 px and also carry pixels with year 0, so the other modes stay on v1.11 (2001–2023).
  // /tiles/gfw-cover/z/x/y.png serves Tree Cover 2000 (same tiles as the 2D Tree Cover layer) for the globe.
  const tileMatch = /^\/tiles\/gfw-(loss|cover)\/(?:(v1\.12)\/)?(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.png$/.exec(url.pathname);
  if (tileMatch && req.method === 'GET') {
    const layer = tileMatch[1];
    const version = tileMatch[2] || 'v1.11';
    const [z, x, y] = tileMatch.slice(3).map(Number);
    if (z > 12 || x >= 2 ** z || y >= 2 ** z || (layer === 'cover' && tileMatch[2])) { res.writeHead(404); return res.end(); }
    const key = layer === 'cover' ? `cover/${z}/${x}/${y}` : `${version}/${z}/${x}/${y}`;
    const upstream = layer === 'cover'
      ? `https://tiles.globalforestwatch.org/umd_tree_cover_density_2000/v1.8/tcd_30/${z}/${x}/${y}.png`
      : `https://tiles.globalforestwatch.org/umd_tree_cover_loss/${version}/tcd_30/${z}/${x}/${y}.png`;
    let tile = tileCache.get(key);
    if (!tile) {
      try {
        const up = await fetch(upstream, { signal: AbortSignal.timeout(15000) });
        tile = up.ok ? { status: 200, body: Buffer.from(await up.arrayBuffer()) } : { status: up.status, body: null };
      } catch {
        tile = { status: 502, body: null };
      }
      if (tile.status === 200 || tile.status === 404) {
        if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value);
        tileCache.set(key, tile);
      }
    }
    if (!tile.body) { res.writeHead(tile.status); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return res.end(tile.body);
  }

  // River under the cursor, whole main stem (/api/v1/rivers/at?lat=&lon=&km=&min=) — for hover highlighting
  if (url.pathname === '/api/v1/rivers/at' && req.method === 'GET') {
    const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
    const km = Math.min(30, Math.max(0.2, Number(url.searchParams.get('km')) || 5));
    const min = Math.max(100, Number(url.searchParams.get('min')) || rivers.MAJOR_KM2);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !rivers.available()) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'lat and lon are required' }));
    }
    const reach = rivers.nearest(lat, lon, km, min);
    if (!reach) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ river: null }));
    }
    const stem = rivers.mainStem(reach.id);
    const body = JSON.stringify({
      river: { reachId: reach.id, key: stem.key, lengthKm: stem.lengthKm, mouthDischargeCms: stem.mouthDischargeCms,
        here: { distanceKm: reach.distanceKm, upstreamAreaKm2: reach.upstreamAreaKm2, meanDischargeCms: reach.meanDischargeCms } },
      path: stem.path,
    });
    const gz = /gzip/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(gz ? { 'content-encoding': 'gzip' } : {}) });
    return res.end(gz ? zlib.gzipSync(body) : body);
  }

  // River network for the map (/api/v1/rivers/network?bbox=w,s,e,n&z=zoom) — gzipped, cached by tile-ish key
  if (url.pathname === '/api/v1/rivers/network' && req.method === 'GET') {
    const bbox = String(url.searchParams.get('bbox') || '').split(',').map(Number);
    const z = Math.max(0, Math.min(18, Math.round(Number(url.searchParams.get('z')))));
    if (bbox.length !== 4 || !bbox.every(Number.isFinite) || !Number.isFinite(z) || !rivers.available()) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bbox=w,s,e,n and z are required' }));
    }
    // Snap the box outward to a grid that depends on zoom, so panning reuses cached answers
    const step = z <= 3 ? 360 : z <= 5 ? 10 : z <= 7 ? 2 : 0.5;
    const [w, s, e, n] = [
      Math.max(-180, Math.floor(bbox[0] / step) * step), Math.max(-90, Math.floor(bbox[1] / step) * step),
      Math.min(180, Math.ceil(bbox[2] / step) * step), Math.min(90, Math.ceil(bbox[3] / step) * step),
    ];
    // Categories to send (1 = small … 5 = largest); default all
    const classes = new Set(String(url.searchParams.get('classes') || '1,2,3,4,5').split(',').map(Number).filter(c => c >= 1 && c <= 5));
    const key = `${z}|${w},${s},${e},${n}|${[...classes].sort().join('')}`;
    let gz = networkCache.get(key);
    if (!gz) {
      const net = rivers.network([w, s, e, n], z, classes);
      // Close up, centre the lines on the real water (JRC surface water); the 15" source lines
      // can sit a few hundred metres off the channel, invisible when zoomed out.
      if (z >= 9) await waterSnap.snapNetwork(net, z, [w, s, e, n]).catch(err => console.warn('[rivers] water snap skipped:', err.message));
      gz = zlib.gzipSync(JSON.stringify(net));
      if (networkCache.size > 300) networkCache.delete(networkCache.keys().next().value);
      networkCache.set(key, gz);
    }
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      ...(acceptsGzip ? { 'content-encoding': 'gzip' } : {}),
    });
    return res.end(acceptsGzip ? gz : zlib.gunzipSync(gz));
  }

  // Real river geometry from rough sketches (/api/v1/rivers/trace) — { sketches: { id: [[lat, lon], ...] } }
  if (url.pathname === '/api/v1/rivers/trace' && req.method === 'POST') {
    try {
      const { sketches } = JSON.parse(await readBody(req, 256 * 1024) || '{}');
      if (!sketches || typeof sketches !== 'object') throw Object.assign(new Error('sketches required'), { status: 400 });
      const out = {};
      for (const [id, sketch] of Object.entries(sketches).slice(0, 50)) {
        if (!Array.isArray(sketch) || sketch.length < 2 || !sketch.every(p => Array.isArray(p) && p.every(Number.isFinite))) continue;
        const key = JSON.stringify(sketch);
        if (!traceCache.has(key)) traceCache.set(key, rivers.traceAlong(sketch));
        out[id] = traceCache.get(key);
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ rivers: out, source: 'HydroRIVERS v1.0 (HydroSHEDS)' }));
    } catch (err) {
      res.writeHead(err.status || 400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Snap a drawn river onto its real water for a close-up view (/api/v1/rivers/snap)
  // { lines: [[[lat, lon], ...], ...], bbox: [w, s, e, n], z } → { lines } (only the parts in the box)
  if (url.pathname === '/api/v1/rivers/snap' && req.method === 'POST') {
    try {
      const { lines, bbox, z } = JSON.parse(await readBody(req, 1024 * 1024) || '{}');
      const zoom = Math.round(Number(z));
      const okLine = l => Array.isArray(l) && l.length >= 2 && l.length <= 20000 && l.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
      if (!Array.isArray(lines) || !lines.length || lines.length > 20 || !lines.every(okLine)
        || !Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)
        || bbox[2] - bbox[0] > 10 || bbox[3] - bbox[1] > 10 || !(zoom >= 9 && zoom <= 18)) {
        throw Object.assign(new Error('lines (≤ 20), bbox (≤ 10°) and z ≥ 9 are required'), { status: 400 });
      }
      const net = { lines: { 5: lines } };
      await waterSnap.snapNetwork(net, zoom, bbox);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ lines: net.lines[5], source: 'JRC Global Surface Water (2021)' }));
    } catch (err) {
      res.writeHead(err.status || 400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Hazard Lens (/api/v1/hazard) — satellite image + global data → Gemma 4 hazard reading
  if (url.pathname === '/api/v1/hazard' && req.method === 'POST') {
    if (!aiReadAllowed(req)) return tooMany(res, TOO_MANY_AI);
    try {
      const result = await hazard.assess(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(err.status || (err instanceof SyntaxError ? 400 : 500), { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'Hazard Lens failed.' }));
    }
  }

  // Global soil profile (/api/v1/soil) — reuses Forest Eyes' ISRIC SoilGrids client
  if (url.pathname === '/api/v1/soil' && req.method === 'GET') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!forestCore || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Valid lat and lon are required.' }));
    }
    // A full SoilGrids profile often takes 20+ s, so allow longer than Treeko's 5 s budget.
    const soil = await require('../frontend/forest-eyes/treeko-brain.js').getSoil(lat, lon, fetch, 35000);
    res.writeHead(soil ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(soil || { error: 'SoilGrids is unavailable right now.' }));
  }

  // Weather Proxy (/api/v1/weather)
  if (url.pathname === '/api/v1/weather') {
    const lat = url.searchParams.get('lat') || '30.38';
    const lon = url.searchParams.get('lon') || '79.32';
    try {
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,surface_pressure,wind_speed_10m`;
      const wRes = await fetch(weatherUrl);
      const wData = await wRes.json();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(wData));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 3. Static Files Serving
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }

  res.writeHead(405);
  res.end();
});

server.listen(PORT, () => {
  console.log(`\n================================================================`);
  console.log(`🌍 Earth Intelligence Platform (Forest Eyes ⇄ River Eyes)`);
  console.log(`   Running at:  http://localhost:${PORT}`);
  console.log(`   Forest Eyes: 3D Globe, Hansen Tree Loss, Treeko AI`);
  console.log(`   River Eyes:  High-Precision Centerlines, Dam Siting, Aqua AI`);
  console.log(`   Transition:  Fluid Water Flood ⇄ Tree Absorption Engine`);
  console.log(`================================================================\n`);
});
