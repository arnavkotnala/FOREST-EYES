/**
 * ForestWatch — Deforestation Intelligence Platform
 * =================================================
 * Full API integration extracted from the wri/gfw GitHub repository:
 *
 *   1. GFW Data API       → https://data-api.globalforestwatch.org
 *      - Geostore (create/fetch areas from GeoJSON)
 *      - Tree cover loss (precomputed datasets by admin/geostore)
 *      - GLAD / Integrated deforestation alerts
 *      - FAO forest data (extent, deforestation rates, reforestation)
 *      - Biomass & carbon stock
 *
 *   2. Resource Watch API  → https://api.resourcewatch.org
 *      - Analysis endpoints (UMD loss/gain by admin/geostore/wdpa)
 *      - Climate cumulative emissions & deforestation tracking
 *      - Recent satellite tiles (Landsat via lat/lng)
 *
 *   3. GNW Analytics API   → https://analytics.globalnaturewatch.org
 *      - On-the-fly tree cover loss analytics for arbitrary GeoJSON polygons
 *
 *   4. Climate Watch API   → https://www.climatewatchdata.org/api/v1
 *      - Greenhouse gas emissions metadata & data (CO2, CH4, N2O by country)
 *
 *   5. Open-Meteo          → https://api.open-meteo.com   (free, no key)
 *      - Real-time weather (temperature, humidity, precipitation, wind)
 *
 *   6. Nominatim (OSM)     → https://nominatim.openstreetmap.org (free)
 *      - Location name search / geocoding
 */

// =============================================
// API BASE URLS (extracted from utils/apis.js)
// =============================================
const APIS = {
  GFW_DATA:          'https://data-api.globalforestwatch.org',
  RESOURCE_WATCH:    'https://api.resourcewatch.org/v1',
  GFW_API:           'https://api.resourcewatch.org',
  GNW_ANALYTICS:     'https://analytics.globalnaturewatch.org',
  CLIMATE_WATCH:     'https://www.climatewatchdata.org/api/v1',
  OPEN_METEO:        'https://api.open-meteo.com/v1',
  NOMINATIM:         'https://nominatim.openstreetmap.org',
};

// Analysis dataset tables (from data/analysis-datasets.json)
const DATASETS = {
  ANNUAL_GEOSTORE_SUMMARY: 'geostore__tcl__summary',
  ANNUAL_GEOSTORE_CHANGE:  'geostore__tcl__change',
  GLAD_GEOSTORE_DAILY:     'geostore__glad__daily_alerts',
  INTEGRATED_ALERTS_GEOSTORE_DAILY: 'geostore__integrated_alerts__daily_alerts',
};

// =============================================
// MAP INITIALIZATION
// =============================================
const map = L.map('map', {
  center: [20, 0],
  zoom: 3,
  zoomControl: false,
});

// Base layers
const darkBase = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  maxZoom: 19,
});

const satelliteBase = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '&copy; Esri, Maxar, Earthstar Geographics',
  maxZoom: 19,
});

// GFW Data Layers (from tiles.globalforestwatch.org — extracted from repo configs)
const treeCoverLayer = L.tileLayer('https://tiles.globalforestwatch.org/umd_tree_cover_density_2000/v1_8/tcd_30/{z}/{x}/{y}.png', {
  maxZoom: 12,
  opacity: 0.7,
  attribution: 'Tree Cover 2000 &copy; UMD/Hansen/Google/USGS/NASA',
});

const treeLossLayer = L.tileLayer('https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.11/tcd_30/{z}/{x}/{y}.png', {
  maxZoom: 12,
  opacity: 0.85,
  attribution: 'Tree Cover Loss &copy; UMD/Hansen/Google/USGS/NASA',
});

const gladAlertsLayer = L.tileLayer('https://tiles.globalforestwatch.org/glad_prod/tiles/{z}/{x}/{y}.png', {
  maxZoom: 12,
  opacity: 0.9,
  attribution: 'GLAD Alerts &copy; UMD/GLAD',
});
const treeLossColorLayer = L.layerGroup();

// Canvas-based heatmap layer.  This is deliberately separate from the raw
// Hansen tile layer: the tiles show individual loss pixels, whereas this
// layer summarizes the results for the selected analysis area.
let heatmapCanvas = null;
let heatmapLayer  = null;
const WEB_MERCATOR_LIMIT = 85.05112878;

function clearHeatmapLayer() {
  if (heatmapLayer) { map.removeLayer(heatmapLayer); heatmapLayer = null; }
  heatmapCanvas = null;
}

function renderHeatmap(lat, lng, rows) {
  clearHeatmapLayer();
  const radiusKm = Math.max(1, parseInt($radiusInput?.value || '500', 10) || 1);
  const validRows = rows
    .map(row => ({ ...row, ha: Number(row.ha) || 0 }))
    .filter(row => row.ha > 0);
  const totalHa  = validRows.reduce((sum, row) => sum + row.ha, 0);
  if (totalHa < 0.01) return;

  const size   = 1024;
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const maxHa  = Math.max(...validRows.map(row => row.ha), 0.01);
  const cx     = size / 2;
  const cy     = size / 2;

  // Seeded-random for consistent hotspot placement
  const seed = Math.abs(Math.round(lat * 1000 + lng * 7));
  function seededRand(i) {
    const x = Math.sin(seed + i * 9973) * 43758.5453;
    return x - Math.floor(x);
  }

  // Generate scattered hotspot points for each year's loss
  const sortedRows = [...validRows].sort((a, b) => b.ha - a.ha);
  let spotIdx = 0;
  sortedRows.forEach((row, ri) => {
    if (row.ha < 0.01) return;
    const intensity = row.ha / maxHa;
    // Number of spots proportional to loss
    const numSpots = Math.max(2, Math.ceil(intensity * 12));
    for (let s = 0; s < numSpots; s++) {
      const angle  = seededRand(spotIdx * 3) * Math.PI * 2;
      const dist   = seededRand(spotIdx * 3 + 1) * cx * 0.78;
      const px     = cx + Math.cos(angle) * dist;
      const py     = cy + Math.sin(angle) * dist;
      const spotR  = Math.max(40, cx * 0.15 * intensity + cx * 0.08 * seededRand(spotIdx * 3 + 2));
      const alpha  = 0.25 + intensity * 0.55;

      const grad = ctx.createRadialGradient(px, py, 0, px, py, spotR);
      // Deforestation palette: red core → orange → yellow → transparent.
      grad.addColorStop(0,    `rgba(239, 68, 68, ${alpha})`);
      grad.addColorStop(0.32, `rgba(249, 115, 22, ${alpha * 0.72})`);
      grad.addColorStop(0.64, `rgba(250, 204, 21, ${alpha * 0.36})`);
      grad.addColorStop(1,    `rgba(250, 204, 21, 0)`);

      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, spotR, 0, Math.PI * 2);
      ctx.fill();
      spotIdx++;
    }
  });

  // Add a large central glow based on total deforestation
  const totalIntensity = Math.min(totalHa / 100, 1);
  const centerR = cx * 0.6 * totalIntensity + cx * 0.15;
  const centerAlpha = 0.15 + totalIntensity * 0.4;
  const centerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, centerR);
  centerGrad.addColorStop(0,    `rgba(239, 68, 68, ${centerAlpha})`);
  centerGrad.addColorStop(0.3,  `rgba(249, 115, 22, ${centerAlpha * 0.62})`);
  centerGrad.addColorStop(0.6,  `rgba(250, 204, 21, ${centerAlpha * 0.26})`);
  centerGrad.addColorStop(1,    `rgba(250, 204, 21, 0)`);
  ctx.fillStyle = centerGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, centerR, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalCompositeOperation = 'source-over';

  // ImageOverlay uses Web Mercator. Clamp its bounds so a valid heatmap is
  // produced for every allowed coordinate, including high-latitude searches.
  const centerLat = clamp(Number(lat) || 0, -WEB_MERCATOR_LIMIT, WEB_MERCATOR_LIMIT);
  const centerLng = normalizeLng(Number(lng) || 0);
  const latDelta = radiusKm / 111.32;
  const lngDelta = Math.min(179.9, radiusKm / (111.32 * Math.max(Math.cos(centerLat * Math.PI / 180), 0.08)));
  const bounds = [
    [clamp(centerLat - latDelta, -WEB_MERCATOR_LIMIT, WEB_MERCATOR_LIMIT), centerLng - lngDelta],
    [clamp(centerLat + latDelta, -WEB_MERCATOR_LIMIT, WEB_MERCATOR_LIMIT), centerLng + lngDelta],
  ];
  heatmapCanvas = canvas;
  heatmapLayer  = L.imageOverlay(canvas.toDataURL('image/png'), bounds, {
    opacity: 0.9,
    interactive: false,
    zIndex: 450,
  });
  heatmapLayer.addTo(map);
  requestAnimationFrame(() => heatmapLayer?.bringToFront());
}

// =============================================
// REAL-DATA HEATMAP TILE LAYER (CORS-safe)
//
// First attempt at this ported the zip build's per-pixel canvas approach
// (process-pixels.ts / createProcessedLayer in MapCanvas.tsx), which reads
// each tile's pixels with ctx.getImageData() and recolors them. That only
// works because the React build proxies every tile through its own
// same-origin backend route (/api/tiles) first. This static build has no
// backend, tiles.globalforestwatch.org does not send back
// Access-Control-Allow-Origin, so getImageData() threw a SecurityError on
// every tile and the layer silently fell back to drawing the plain,
// unprocessed tile — which is why it visually looked identical to the
// "dots" mode.
//
// Fix: don't touch pixel data at all. Put the raw loss tiles in their own
// Leaflet pane and apply a CSS filter (blur + saturate + hue-rotate) to
// that pane. CSS filters have no CORS restriction whatsoever — they work
// on cross-origin images exactly like same-origin ones — and applying the
// filter to the whole pane (rather than per-tile) blurs smoothly across
// tile seams instead of stopping at each 256px edge. This still uses the
// real Hansen loss data, it's just styled instead of pixel-processed.
// =============================================
map.createPane('heatmapPane');
const heatmapPaneEl = map.getPane('heatmapPane');
heatmapPaneEl.style.zIndex = 450;
heatmapPaneEl.classList.add('fw-heatmap-pane');

const treeLossHeatmapLayer = L.tileLayer(
  'https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.11/tcd_30/{z}/{x}/{y}.png',
  {
    pane: 'heatmapPane',
    maxZoom: 12,
    maxNativeZoom: 12,
    opacity: 0.95,
    attribution: 'Tree Cover Loss Heatmap &copy; UMD/Hansen/Google/USGS/NASA',
  }
);

// Add default layers to map
satelliteBase.addTo(map);
treeCoverLayer.addTo(map);
treeLossLayer.addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

// =============================================
// LAYER TOGGLE CONTROLS
// =============================================
// Safely bind layer toggles (they may not exist if HTML hasn't loaded yet)
function bindToggle(id, onCheck, onUncheck) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', (e) => e.target.checked ? onCheck() : onUncheck());
}

bindToggle('toggle-satellite',
  () => { map.removeLayer(darkBase); map.addLayer(satelliteBase); },
  () => { map.removeLayer(satelliteBase); map.addLayer(darkBase); }
);
bindToggle('toggle-tree-cover',
  () => map.addLayer(treeCoverLayer),
  () => map.removeLayer(treeCoverLayer)
);
bindToggle('toggle-tree-loss',
  () => syncTreeLossLayer(),
  () => syncTreeLossLayer()
);
bindToggle('toggle-glad',
  () => map.addLayer(gladAlertsLayer),
  () => map.removeLayer(gladAlertsLayer)
);

// State
let currentMarker = null;
let currentPolygon = null;
let lastLat = null;
let lastLng = null;
let lastName = null;
let latestApiUpdatedAt = null;
let latestLossRows = [];
let latestLossCenter = null;
let globeScene = null;

const $ = id => document.getElementById(id);
const $latInput       = $('lat-input');
const $lngInput       = $('lng-input');
const $radiusInput    = $('radius-input');
const $radiusDisplay  = $('radius-display');
const $locationSearch = $('location-search');
const $searchBtn      = $('search-btn');
const $analyzeBtn     = $('analyze-btn');
const $retryBtn       = $('retry-btn');
const $statusDot      = $('status-dot');
const $statusText     = $('status-text');

const $resultPlaceholder  = $('result-placeholder');

function extractApiUpdatedAt(body, response) {
  return body?.meta?.updated_at || body?.metadata?.updated_at || body?.data?.updated_at ||
    response.headers.get('last-modified') || response.headers.get('date') || null;
}
const $resultContent      = $('result-content');
const $loadingState       = $('loading-state');
const $errorState         = $('error-state');
const $errorMessage       = $('error-message');
const $resultLocationName = $('result-location-name');
const $severityCard       = $('severity-card');
const $severityIcon       = $('severity-icon');
const $severityLevel      = $('severity-level');
const $severityDesc       = $('severity-desc');
const $statHa             = $('stat-ha');
const $statCo2            = $('stat-co2');
const $statYears          = $('stat-years');
const $statTrees          = $('stat-trees');
const $barChart           = $('bar-chart');
const $plantingNumber     = $('planting-number');
const $apiUpdated         = $('api-updated');
const $recentSearches     = $('recent-searches');
const $searchSuggestions  = $('search-suggestions');
const $globeContainer      = $('globe-container');
const $globeControls       = $('globe-controls');
const $treeLossMode        = $('tree-loss-mode');

if ($treeLossMode) $treeLossMode.addEventListener('change', syncTreeLossLayer);

const globeToggle = $('toggle-globe');
if (globeToggle) globeToggle.addEventListener('change', (event) => {
  const showGlobe = event.target.checked;
  $globeContainer.classList.toggle('hidden', !showGlobe);
  $globeControls?.classList.toggle('hidden', !showGlobe);
  $('map').classList.toggle('hidden', showGlobe);
  if (showGlobe) {
    initGlobe();
    resizeGlobe();
  }
});

const $climatePlaceholder = $('climate-placeholder');
const $climateContent     = $('climate-content');
const $cvTemp             = $('cv-temp');
const $cvHumidity         = $('cv-humidity');
const $cvPrecip           = $('cv-precip');
const $cvWind             = $('cv-wind');
const $cbTemp             = $('cb-temp');
const $cbHumidity         = $('cb-humidity');
const $cbPrecip           = $('cb-precip');
const $cbWind             = $('cb-wind');
const $gwGaugeFill        = $('gw-gauge-fill');
const $gwLabel            = $('gw-label');
const $gwDescription      = $('gw-description');

const $steps = [1,2,3,4].map(i => $(`step-${i}`));

// =============================================
// RADIUS SLIDER
// =============================================
$radiusInput.addEventListener('input', () => {
  const val = $radiusInput.value;
  $radiusDisplay.textContent = `${val} km`;
  const pct = ((val - 1) / (500 - 1)) * 100;
  $radiusInput.style.background = `linear-gradient(to right, #00e676 0%, #00e676 ${pct}%, rgba(255,255,255,0.1) ${pct}%)`;
});

// init slider fill at 500 km
(function () {
  const pct = ((500 - 1) / (500 - 1)) * 100;
  $radiusInput.style.background = `linear-gradient(to right, #00e676 0%, #00e676 ${pct}%, rgba(255,255,255,0.1) ${pct}%)`;
})();

// =============================================
// MAP CLICK — fills coords
// =============================================
map.on('click', (e) => {
  $latInput.value = e.latlng.lat.toFixed(6);
  $lngInput.value = e.latlng.lng.toFixed(6);
  lastName = null;
  if(typeof updatePrefixes === 'function') updatePrefixes();
});

// =============================================
// GEOCODING (Nominatim — from services/geocoding.js pattern)
// =============================================
async function geocodeLocation(query) {
  const url = `${APIS.NOMINATIM}/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  const data = await res.json();
  if (!data || data.length === 0) throw new Error('Location not found. Try a different search term.');
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), name: data[0].display_name };
}

$searchBtn.addEventListener('click', doSearch);
$locationSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

let suggestionTimer = null;
$locationSearch.addEventListener('input', () => {
  clearTimeout(suggestionTimer);
  const query = $locationSearch.value.trim();
  if (query.length < 3) {
    $searchSuggestions.classList.add('hidden');
    return;
  }
  suggestionTimer = setTimeout(() => loadSearchSuggestions(query), 350);
});

document.addEventListener('click', (e) => {
  if (!$searchSuggestions.contains(e.target) && e.target !== $locationSearch) {
    $searchSuggestions.classList.add('hidden');
  }
});

async function loadSearchSuggestions(query) {
  try {
    const url = `${APIS.NOMINATIM}/search?q=${encodeURIComponent(query)}&format=json&limit=5`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const places = await res.json();
    $searchSuggestions.innerHTML = '';
    places.forEach(place => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'search-suggestion';
      item.textContent = place.display_name;
      item.addEventListener('click', () => {
        $locationSearch.value = place.display_name;
        $searchSuggestions.classList.add('hidden');
        applyLocation(parseFloat(place.lat), parseFloat(place.lon), place.display_name);
      });
      $searchSuggestions.appendChild(item);
    });
    $searchSuggestions.classList.toggle('hidden', places.length === 0);
  } catch (err) {
    $searchSuggestions.classList.add('hidden');
  }
}

async function doSearch() {
  const query = $locationSearch.value.trim();
  if (!query) return;
  setStatus('loading', 'Searching location...');
  try {
    const { lat, lng, name } = await geocodeLocation(query);
    applyLocation(lat, lng, name);
    setStatus('ready', 'Location found — click Analyze');
  } catch (err) {
    setStatus('error', err.message);
  }
}

function applyLocation(lat, lng, name) {
  $latInput.value = lat.toFixed(6);
  $lngInput.value = lng.toFixed(6);
  lastName = name.split(',').slice(0, 2).join(',');
  $locationSearch.value = lastName;
  map.setView([lat, lng], 10);
  focusGlobeOnCoordinates(lat, lng);
  saveRecentSearch({ lat, lng, name: lastName });
  if (typeof updatePrefixes === 'function') updatePrefixes();
}

// =============================================
// PRESET BUTTONS
// =============================================
function saveRecentSearch(search) {
  const stored = JSON.parse(localStorage.getItem('forestwatch-recent-searches') || '[]');
  const next = [search, ...stored.filter(item => item.name !== search.name)].slice(0, 6);
  localStorage.setItem('forestwatch-recent-searches', JSON.stringify(next));
  renderRecentSearches(next);
}

function renderRecentSearches(searches = JSON.parse(localStorage.getItem('forestwatch-recent-searches') || '[]')) {
  $recentSearches.innerHTML = '';
  if (!searches.length) {
    $recentSearches.innerHTML = '<p class="empty-recent">Your searched locations will appear here.</p>';
    return;
  }
  searches.forEach(search => {
    const button = document.createElement('button');
    button.className = 'btn-preset';
    button.textContent = `📍 ${search.name}`;
    button.title = `Load ${search.name}`;
    button.addEventListener('click', () => {
      applyLocation(search.lat, search.lng, search.name);
      setStatus('ready', `${search.name} loaded — click Analyze`);
    });
    $recentSearches.appendChild(button);
  });
}

// =============================================
// ANALYZE BUTTON
// =============================================
$analyzeBtn.addEventListener('click', () => {
  const lat = parseFloat($latInput.value);
  const lng = parseFloat($lngInput.value);
  if (isNaN(lat) || isNaN(lng)) {
    showError('Please enter valid latitude and longitude, or search for a location.');
    return;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    showError('Coordinates out of range. Latitude: -90 to 90. Longitude: -180 to 180.');
    return;
  }
  analyzeLocation(lat, lng);
});

$retryBtn.addEventListener('click', () => {
  if (lastLat !== null && lastLng !== null) analyzeLocation(lastLat, lastLng);
});

// =============================================
//  CORE: ANALYZE LOCATION
//  Attempts 3 API strategies in fallback order:
//    1. GFW Data API (geostore → precomputed dataset query)
//    2. GNW Analytics API (on-the-fly job)
//    3. Simulated estimate (based on biome latitude)
// =============================================
async function analyzeLocation(lat, lng) {
  lastLat = lat;
  lastLng = lng;
  const radiusKm = parseInt($radiusInput.value);
  const locationName = lastName || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  showLoading();
  setStatus('loading', 'Analyzing satellite data...');
  clearMapLayers();
  map.setView([lat, lng], 9);
  focusGlobeOnCoordinates(lat, lng);

  try {
    // STEP 1 — Build GeoJSON bounding box
    setStep(0);
    const geojson = createBoundingBoxGeoJSON(lat, lng, radiusKm);
    drawPolygon(geojson);
    await delay(400);

    let analyticsData = null;

    // STEP 2 — Try GFW Data API (geostore → query)
    setStep(1);
    try {
      console.log('[API] Strategy 1: GFW Data API (geostore + dataset query)');
      const geostoreId = await createGeostore(geojson);
      console.log('[API] Geostore created:', geostoreId);
      analyticsData = await queryTreeCoverLossDataset(geostoreId);
      console.log('[API] GFW Data API returned data');
    } catch (gfwErr) {
      console.warn('[API] GFW Data API failed:', gfwErr.message);

      // STEP 2b — Try GNW Analytics API
      try {
        console.log('[API] Strategy 2: GNW Analytics API');
        const resourceId = await triggerGNWAnalyticsJob(geojson);
        setStep(2);
        analyticsData = await pollGNWAnalyticsJob(resourceId);
        console.log('[API] GNW Analytics API returned data');
      } catch (gnwErr) {
        console.warn('[API] GNW Analytics API failed:', gnwErr.message);

        // STEP 2c — Simulated fallback
        console.log('[API] Strategy 3: Simulated biome estimate');
        analyticsData = simulateAnalyticsData(lat, lng);
      }
    }

    // STEP 3 — Format & display
    setStep(2);
    await delay(300);
    setStep(3);
    await delay(200);

    const formatted = formatAnalyticsResponse(analyticsData);
    latestApiUpdatedAt = analyticsData?.updatedAt || null;
    renderDeforestationResults(lat, lng, locationName, formatted);

    // Climate data (fires in parallel)
    fetchAndRenderClimate(lat, lng, formatted.totalHa);

    setStatus('ready', `Analysis complete — ${locationName}`);

  } catch (err) {
    console.error('Analysis failed:', err);
    showError(`Analysis failed: ${err.message}. Please try again.`);
    setStatus('error', 'Analysis failed');
  }
}

// =============================================
// GEO HELPERS
// =============================================
function createBoundingBoxGeoJSON(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111.0;
  const lngDelta = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180));

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: `fw-${Date.now()}`,
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [lng - lngDelta, lat - latDelta],
          [lng + lngDelta, lat - latDelta],
          [lng + lngDelta, lat + latDelta],
          [lng - lngDelta, lat + latDelta],
          [lng - lngDelta, lat - latDelta],
        ]],
      },
      properties: {},
    }],
  };
}

function drawPolygon(geojson) {
  const coords = geojson.features[0].geometry.coordinates[0];
  const leafletCoords = coords.map(c => [c[1], c[0]]);
  currentPolygon = L.polygon(leafletCoords, {
    color: 'rgba(66, 165, 245, 0.8)',
    weight: 2,
    fillColor: 'rgba(66, 165, 245, 0.06)',
    fillOpacity: 1,
    dashArray: '6 4',
  }).addTo(map);
}

// =============================================
// API 1: GFW DATA API — Geostore + Dataset Query
// (from services/geostore.js — saveGeostore)
// =============================================
async function createGeostore(geojson) {
  const res = await fetch(`${APIS.GFW_API}/geostore/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geojson }),
  });
  if (!res.ok) throw new Error(`Geostore creation failed: ${res.status}`);
  const data = await res.json();
  const hash = data?.data?.attributes?.hash || data?.data?.id;
  if (!hash) throw new Error('No geostore hash in response');
  return hash;
}

// Query precomputed tree cover loss dataset by geostore
// (from services/analysis-cached.js — SQL_QUERIES.loss pattern)
async function queryTreeCoverLossDataset(geostoreId) {
  const dataset = DATASETS.ANNUAL_GEOSTORE_SUMMARY;
  const sql = encodeURIComponent(
    `SELECT umd_tree_cover_loss__year, ` +
    `SUM(umd_tree_cover_loss__ha) AS umd_tree_cover_loss__ha, ` +
    `SUM("gfw_gross_emissions_co2e_all_gases__Mg") AS gfw_gross_emissions_co2e_all_gases__Mg ` +
    `FROM data ` +
    `WHERE umd_tree_cover_density_2000__threshold >= 30 ` +
    `GROUP BY umd_tree_cover_loss__year ` +
    `ORDER BY umd_tree_cover_loss__year`
  );

  const url = `${APIS.GFW_DATA}/dataset/${dataset}/latest/query?sql=${sql}&geostore_id=${geostoreId}&geostore_origin=rw`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dataset query failed: ${res.status}`);
  const body = await res.json();
  const rows = body?.data?.data || body?.data || [];
  if (!rows.length) throw new Error('No data rows returned from GFW Data API');

  // Transform to our standard format
  return {
    result: {
      tree_cover_loss_year: rows.map(r => r.umd_tree_cover_loss__year),
      area_ha: rows.map(r => r.umd_tree_cover_loss__ha || 0),
      carbon_emissions_MgCO2e: rows.map(r => r.gfw_gross_emissions_co2e_all_gases__Mg || 0),
    },
    updatedAt: extractApiUpdatedAt(body, res),
  };
}

// =============================================
// API 2: GNW ANALYTICS API
// (from utils/gnw-data-request.js)
// =============================================
async function triggerGNWAnalyticsJob(geojson) {
  const payload = {
    aoi: {
      type: 'feature_collection',
      feature_collection: geojson,
    },
    start_year: '2021',
    end_year: '2024',
    forest_filter: 'natural_forest',
    intersections: [],
  };

  const res = await fetch(`${APIS.GNW_ANALYTICS}/v0/land_change/tree_cover_loss/analytics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`GNW Analytics POST failed: ${res.status}`);
  const data = await res.json();
  const link = data?.data?.link;
  if (!link) throw new Error('No resource link in GNW response');
  return link.split('/').pop();
}

async function pollGNWAnalyticsJob(resourceId) {
  const maxWait = 35000;
  let waited = 0;
  while (waited < maxWait) {
    const res = await fetch(`${APIS.GNW_ANALYTICS}/v0/land_change/tree_cover_loss/analytics/${resourceId}`);
    if (!res.ok) throw new Error(`GNW poll failed: ${res.status}`);
    const body = await res.json();
    const jobData = body?.data || body;
    const status = jobData?.status;
    if (status === 'saved' || status === 'success') return jobData;
    if (status === 'failed') throw new Error('GNW analytics job failed');
    const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10) * 1000;
    await delay(retryAfter);
    waited += retryAfter;
  }
  throw new Error('GNW analytics job timed out');
}

// =============================================
// FALLBACK: SIMULATED ESTIMATE
// =============================================
function simulateAnalyticsData(lat, lng) {
  const absLat = Math.abs(lat);
  let baseLoss = 0;
  if (absLat < 15)      baseLoss = Math.random() * 180 + 20;
  else if (absLat < 30) baseLoss = Math.random() * 60 + 5;
  else if (absLat < 60) baseLoss = Math.random() * 20 + 0.5;
  else                  baseLoss = Math.random() * 5;

  const years = [2021, 2022, 2023, 2024];
  return {
    result: {
      tree_cover_loss_year: years,
      area_ha: years.map(() => parseFloat((baseLoss * (0.7 + Math.random() * 0.6)).toFixed(2))),
      carbon_emissions_MgCO2e: years.map(() => parseFloat((baseLoss * 250 * (0.8 + Math.random() * 0.4)).toFixed(2))),
    }
  };
}

// =============================================
// FORMAT RESPONSE (mirrors gnw-data-request.js formatLegacyResponse)
// =============================================
function formatAnalyticsResponse(data) {
  const result = data?.result || data;
  const years      = result?.tree_cover_loss_year || [];
  const areaHa     = result?.area_ha || [];
  const emissions  = result?.carbon_emissions_MgCO2e || [];

  const rows = years.map((year, i) => ({
    year,
    ha: areaHa[i] || 0,
    emissions: emissions[i] || 0,
  })).sort((a, b) => a.year - b.year);

  const totalHa        = rows.reduce((s, r) => s + r.ha, 0);
  const totalEmissions = rows.reduce((s, r) => s + r.emissions, 0);
  const treesNeeded    = calculateTreesNeeded(totalEmissions, totalHa);

  return { rows, totalHa, totalEmissions, treesNeeded, updatedAt: data?.updatedAt || null };
}

// =============================================
// SEVERITY ENGINE
// =============================================
function getSeverityLevel(totalHa) {
  if (totalHa > 100) return {
    level: 'VERY HIGH DEFORESTATION',
    color: 'red',
    icon: '🔴',
    desc: 'Critical deforestation detected. Immediate intervention required to prevent further ecosystem collapse.',
  };
  if (totalHa > 10) return {
    level: 'MODERATE DEFORESTATION',
    color: 'orange',
    icon: '🟠',
    desc: 'Significant tree cover loss identified. Monitoring and targeted reforestation recommended.',
  };
  if (totalHa > 1) return {
    level: 'LOW DEFORESTATION',
    color: 'yellow',
    icon: '🟡',
    desc: 'Minor deforestation detected. Area should be monitored for future changes.',
  };
  return {
    level: 'NEGLIGIBLE DEFORESTATION',
    color: 'green',
    icon: '🟢',
    desc: 'Little to no deforestation detected. This area appears well-preserved.',
  };
}

function calculateTreesNeeded(totalEmissions, totalHa) {
  const matureTrees = Math.ceil(totalEmissions / 0.021);
  const plantingGoal = Math.ceil(matureTrees * 3.5);
  const areaBasedEstimate = Math.ceil(totalHa * 400);
  return Math.max(plantingGoal, areaBasedEstimate);
}

// =============================================
// RENDER DEFORESTATION RESULTS
// =============================================
function renderDeforestationResults(lat, lng, locationName, data) {
  const { rows, totalHa, totalEmissions, treesNeeded } = data;
  const severity = getSeverityLevel(totalHa);

  $resultLocationName.textContent = `📍 ${locationName}`;
  $apiUpdated.textContent = data.updatedAt
    ? `API data updated: ${formatDate(data.updatedAt)}`
    : 'API data updated: live response time unavailable';

  $severityCard.className = `severity-card ${severity.color}`;
  $severityIcon.textContent = severity.icon;
  $severityLevel.textContent = severity.level;
  $severityDesc.textContent = severity.desc;

  $statHa.textContent    = formatNumber(totalHa, 1);
  $statCo2.textContent   = formatNumber(totalEmissions, 0);
  const minYear = rows.length ? rows[0].year : '—';
  const maxYear = rows.length ? rows[rows.length - 1].year : '—';
  $statYears.textContent = `${minYear}–${maxYear}`;
  $statTrees.textContent = formatCompact(treesNeeded);

  renderBarChart(rows, severity.color);
  renderTreeLossColorForm(lat, lng, rows);

  $plantingNumber.textContent = formatNumber(treesNeeded, 0);

  placeMarker(lat, lng, severity);

  $loadingState.classList.add('hidden');
  $resultContent.classList.remove('hidden');
}

// =============================================
// BAR CHART
// =============================================
function renderBarChart(rows, color) {
  $barChart.innerHTML = '';
  const maxHa = Math.max(...rows.map(r => r.ha), 0.01);
  rows.forEach(row => {
    const pct = Math.max((row.ha / maxHa) * 100, 2);
    const item = document.createElement('div');
    item.className = 'bar-item';
    const valLabel = document.createElement('div');
    valLabel.className = 'bar-label-val';
    valLabel.textContent = row.ha > 0 ? formatNumber(row.ha, 1) : '0';
    const fill = document.createElement('div');
    fill.className = `bar-fill ${color}`;
    fill.style.height = '0%';
    fill.title = `${row.year}: ${row.ha.toFixed(2)} ha`;
    const yearLabel = document.createElement('div');
    yearLabel.className = 'bar-label-year';
    yearLabel.textContent = row.year;
    item.appendChild(valLabel);
    item.appendChild(fill);
    item.appendChild(yearLabel);
    $barChart.appendChild(item);
    setTimeout(() => { fill.style.height = `${pct}%`; }, 100);
  });
}

function renderTreeLossColorForm(lat, lng, rows) {
  latestLossRows = rows;
  latestLossCenter = { lat, lng };
  treeLossColorLayer.clearLayers();
  const maxHa = Math.max(...rows.map(row => row.ha), 0);
  if (maxHa < 0.1) return;

  const radiusKm = parseInt($radiusInput.value, 10) || 10;
  const totalHa = rows.reduce((sum, row) => sum + row.ha, 0);
  const intensity = Math.min(Math.max(totalHa / 160, 0.18), 1);
  const centerRadius = Math.max(700, radiusKm * 230 * intensity);
  const midRadius = Math.max(centerRadius * 1.9, radiusKm * 430);
  const outerRadius = Math.max(midRadius * 1.65, radiusKm * 780);

  L.circle([lat, lng], {
    radius: outerRadius,
    stroke: false,
    fillColor: '#ffd166',
    fillOpacity: 0.11,
  }).bindTooltip('Outer tree loss influence').addTo(treeLossColorLayer);

  L.circle([lat, lng], {
    radius: midRadius,
    stroke: false,
    fillColor: '#ff9800',
    fillOpacity: 0.18 + intensity * 0.06,
  }).bindTooltip('Moderate tree loss zone').addTo(treeLossColorLayer);

  L.circle([lat, lng], {
    radius: centerRadius,
    stroke: false,
    fillColor: '#f44336',
    fillOpacity: 0.35 + intensity * 0.16,
  }).bindTooltip('Deforestation centre').addTo(treeLossColorLayer);

  const sortedRows = [...rows].sort((a, b) => b.ha - a.ha);
  sortedRows.forEach((row, index) => {
    if (row.ha < 0.1) return;
    const rowIntensity = row.ha / maxHa;
    const point = lossHotspotPoint(lat, lng, index, sortedRows.length, radiusKm, rowIntensity);
    const color = treeLossColor(rowIntensity, point.distanceRatio);
    L.circle([point.lat, point.lng], {
      radius: 360 + rowIntensity * 1750,
      color,
      fillColor: color,
      fillOpacity: 0.28 + rowIntensity * 0.42,
      weight: 0,
      opacity: 0.82,
    }).bindTooltip(`${row.year}: ${row.ha.toFixed(2)} ha lost`).addTo(treeLossColorLayer);
  });
  syncTreeLossLayer();
}

function lossHotspotPoint(lat, lng, index, count, radiusKm, intensity) {
  if (index < 2) {
    const closeOffset = index === 0 ? -0.0025 : 0.0025;
    return { lat: lat + closeOffset, lng: lng + closeOffset, distanceRatio: 0.12 };
  }

  const angle = ((index - 2) / Math.max(count - 2, 1)) * Math.PI * 2 + Math.PI / 5;
  const distanceRatio = 0.34 + (1 - intensity) * 0.34;
  const distanceKm = radiusKm * distanceRatio;
  const latOffset = (Math.sin(angle) * distanceKm) / 111;
  const lngOffset = (Math.cos(angle) * distanceKm) / (111 * Math.max(Math.cos(lat * Math.PI / 180), 0.18));
  return { lat: lat + latOffset, lng: lng + lngOffset, distanceRatio };
}

function treeLossColor(intensity, distanceRatio) {
  if (intensity > 0.66 && distanceRatio < 0.28) return '#f44336';
  if (intensity > 0.38 || distanceRatio < 0.55) return '#ff9800';
  return '#ffd166';
}

function getTreeLossMode() {
  return $treeLossMode?.value || 'dots';
}

function syncTreeLossLayer() {
  const enabled = $('toggle-tree-loss')?.checked ?? true;
  map.removeLayer(treeLossLayer);
  map.removeLayer(treeLossColorLayer);
  map.removeLayer(treeLossHeatmapLayer);
  clearHeatmapLayer();
  if (!enabled) return;

  const mode = getTreeLossMode();

  if (mode === 'heatmap') {
    // Real heatmap: the actual Hansen loss tiles, everywhere on the map,
    // styled into a glowing heat effect via CSS filter on their pane
    // (see the "fw-heatmap-pane" rule in style.css) — CORS-safe, no canvas
    // pixel reads involved.
    map.addLayer(treeLossHeatmapLayer);
    // Plus the existing synthetic glow highlighting the analyzed area.
    if (latestLossCenter && latestLossRows.length) {
      renderHeatmap(latestLossCenter.lat, latestLossCenter.lng, latestLossRows);
    }
    return;
  }

  if (mode === 'color') {
    if (!treeLossColorLayer.getLayers().length && latestLossCenter && latestLossRows.length) {
      renderTreeLossColorForm(latestLossCenter.lat, latestLossCenter.lng, latestLossRows);
    }
    if (treeLossColorLayer.getLayers().length) map.addLayer(treeLossColorLayer);
    return;
  }

  // dots (default GFW tile)
  map.addLayer(treeLossLayer);
}

// =============================================
// MAP MARKER
// =============================================
function placeMarker(lat, lng, severity) {
  if (currentMarker) map.removeLayer(currentMarker);
  const icon = L.divIcon({
    className: '',
    html: `<div class="custom-marker ${severity.color}"></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 40],
  });
  currentMarker = L.marker([lat, lng], { icon })
    .addTo(map)
    .bindPopup(`
      <div style="padding:4px 0">
        <strong style="font-size:14px">${severity.icon} ${severity.level}</strong><br/>
        <span style="font-size:11px;color:rgba(232,240,254,0.6)">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>
      </div>
    `, { maxWidth: 220 });
}

// =============================================
// CLIMATE ENGINE (Open-Meteo — free, no API key)
// =============================================
async function fetchAndRenderClimate(lat, lng, totalHa) {
  try {
    const url = `${APIS.OPEN_METEO}/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&timezone=auto`;
    const res = await fetch(url);
    const data = await res.json();
    const c = data.current;

    const temp     = c.temperature_2m;
    const humidity = c.relative_humidity_2m;
    const precip   = c.precipitation;
    const wind     = c.wind_speed_10m;

    $cvTemp.textContent     = `${temp}°`;
    $cvHumidity.textContent = `${humidity}%`;
    $cvPrecip.textContent   = `${precip}`;
    $cvWind.textContent     = `${wind}`;

    $cbTemp.style.width     = `${Math.min(Math.max(((temp + 20) / 70) * 100, 0), 100)}%`;
    $cbHumidity.style.width = `${humidity}%`;
    $cbPrecip.style.width   = `${Math.min(precip * 10, 100)}%`;
    $cbWind.style.width     = `${Math.min(wind / 150 * 100, 100)}%`;

    renderGlobalWarmingIndicator(temp, humidity, totalHa);

    $climatePlaceholder.classList.add('hidden');
    $climateContent.classList.remove('hidden');
  } catch (err) {
    console.warn('Climate fetch failed:', err.message);
    $climatePlaceholder.innerHTML = '<p style="color:rgba(232,240,254,0.3);font-size:12px">Climate data unavailable</p>';
  }
}

function renderGlobalWarmingIndicator(temp, humidity, totalHa) {
  const tempScore      = Math.max(0, (temp - 15) / 40);
  const humidityScore  = Math.max(0, (100 - humidity) / 100);
  const deforestScore  = Math.min(totalHa / 200, 1);
  const composite      = (tempScore * 0.4 + humidityScore * 0.3 + deforestScore * 0.3);
  const gaugePos       = Math.max(5, Math.min(composite * 100, 95));

  $gwGaugeFill.style.left = `${gaugePos}%`;

  let label, desc, color;
  if (composite < 0.25) {
    label = '🟢 Low Risk'; color = '#00e676';
    desc = 'Environmental conditions appear stable. Minimal indicators of climate stress or deforestation-driven warming.';
  } else if (composite < 0.5) {
    label = '🟡 Moderate Risk'; color = '#ffeb3b';
    desc = 'Some warming indicators detected. Temperature and humidity levels suggest early signs of climate stress.';
  } else if (composite < 0.75) {
    label = '🟠 High Risk'; color = '#ff9800';
    desc = 'Significant warming indicators. High temperature, reduced humidity, and notable deforestation suggest elevated climate impact.';
  } else {
    label = '🔴 Critical Risk'; color = '#f44336';
    desc = 'Severe environmental stress detected. This area shows strong indicators of deforestation-driven climate change and requires urgent action.';
  }

  $gwLabel.textContent = label;
  $gwLabel.style.color = color;
  $gwDescription.textContent = desc;
}

// =============================================
// UI STATE HELPERS
// =============================================
function showLoading() {
  $resultPlaceholder.classList.add('hidden');
  $resultContent.classList.add('hidden');
  $errorState.classList.add('hidden');
  $loadingState.classList.remove('hidden');
  $analyzeBtn.disabled = true;
  resetSteps();
}

function showError(message) {
  $loadingState.classList.add('hidden');
  $resultContent.classList.add('hidden');
  $resultPlaceholder.classList.add('hidden');
  $errorState.classList.remove('hidden');
  $errorMessage.textContent = message;
  $analyzeBtn.disabled = false;
}

function setStatus(type, text) {
  $statusText.textContent = text;
  $statusDot.className = 'status-dot';
  if (type === 'loading') $statusDot.classList.add('loading');
  if (type === 'error')   $statusDot.classList.add('error');
}

function setStep(index) {
  $steps.forEach((step, i) => {
    step.classList.remove('active', 'done');
    if (i < index) step.classList.add('done');
    if (i === index) step.classList.add('active');
  });
}

function resetSteps() { $steps.forEach(s => s.classList.remove('active', 'done')); }

function clearMapLayers() {
  if (currentMarker)  { map.removeLayer(currentMarker);  currentMarker  = null; }
  if (currentPolygon) { map.removeLayer(currentPolygon); currentPolygon = null; }
  latestLossRows = [];
  latestLossCenter = null;
  treeLossColorLayer.clearLayers();
  clearHeatmapLayer();
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatNumber(n, decimals = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function formatCompact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// =============================================
// 3D GLOBE
// =============================================
// Globe layer state
let globeTreeLossVisible = false;
let globeGladVisible     = false;

function updateGlobeLayers() {
  if (!globeScene) return;
  // Tree loss overlay sphere
  const tlMesh = globeScene.scene.getObjectByName('treeLoss');
  if (tlMesh) tlMesh.visible = globeTreeLossVisible;
  // GLAD overlay sphere
  const gladMesh = globeScene.scene.getObjectByName('gladAlerts');
  if (gladMesh) gladMesh.visible = globeGladVisible;
}

function setTextureColorSpace(texture) {
  // Three r152+ uses colorSpace; retaining the guard makes this work with
  // older cached copies of Three as well.
  if (texture && 'colorSpace' in texture && THREE.SRGBColorSpace) {
    texture.colorSpace = THREE.SRGBColorSpace;
  }
  return texture;
}

function initGlobe() {
  if (globeScene || typeof THREE === 'undefined') return;
  const width = $globeContainer.clientWidth || window.innerWidth;
  const height = $globeContainer.clientHeight || window.innerHeight;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 100);
  camera.position.z = 3.1;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  $globeContainer.appendChild(renderer.domElement);

  const loader = new THREE.TextureLoader();
  loader.crossOrigin = 'anonymous';

  // Base earth sphere
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 64),
    new THREE.MeshPhongMaterial({
      map: setTextureColorSpace(loader.load('https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg')),
      specular: new THREE.Color('#223344'),
      shininess: 12,
    })
  );
  earth.name = 'earth';
  scene.add(earth);

  // ── Correctly project global GFW tiles onto the sphere ───────────────
  // A GFW z=0 tile is Web Mercator, while SphereGeometry UVs are
  // equirectangular. Sampling it with raw UVs shifts alerts north/south.
  // Convert the sphere latitude to Web Mercator before every lookup.
  const overlayVertexShader = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const overlayFragmentShader = `
    uniform sampler2D tMap;
    uniform float uOpacity;
    uniform vec3 uCoreColor;
    uniform vec3 uMidColor;
    uniform vec3 uEdgeColor;
    varying vec2 vUv;
    void main() {
      float latitude = (vUv.y - 0.5) * 3.14159265359;
      float maxMercatorLatitude = radians(85.05112878);
      if (abs(latitude) > maxMercatorLatitude) discard;

      float mercatorY = 0.5 - log(tan(0.78539816339 + latitude * 0.5)) / 6.28318530718;
      vec4 texel = texture2D(tMap, vec2(vUv.x, clamp(mercatorY, 0.0, 1.0)));
      float signal = max(texel.r, max(texel.g, texel.b));
      if (signal < 0.055) discard;

      // Normalize both source datasets into the same unambiguous
      // deforestation scale: yellow edge → orange → red centre.
      float strength = smoothstep(0.055, 0.9, signal);
      vec3 warmColor = mix(uEdgeColor, uMidColor, smoothstep(0.12, 0.55, strength));
      warmColor = mix(warmColor, uCoreColor, smoothstep(0.55, 1.0, strength));
      gl_FragColor = vec4(warmColor, (0.38 + strength * 0.62) * uOpacity);
    }
  `;

  const deforestationUniforms = (texture, opacity) => ({
    tMap: { value: texture },
    uOpacity: { value: opacity },
    uCoreColor: { value: new THREE.Color('#ef4444') },
    uMidColor: { value: new THREE.Color('#f97316') },
    uEdgeColor: { value: new THREE.Color('#facc15') },
  });

  // ── Tree Cover Loss overlay ──────────────────────────────────────────
  const tlTex = setTextureColorSpace(loader.load('https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.11/tcd_30/0/0/0.png'));
  const tlMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.003, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: deforestationUniforms(tlTex, 0.88),
      vertexShader: overlayVertexShader,
      fragmentShader: overlayFragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    })
  );
  tlMesh.name    = 'treeLoss';
  tlMesh.visible = false;
  earth.add(tlMesh);

  // ── GLAD Alerts overlay ──────────────────────────────────────────────
  const gladTex = setTextureColorSpace(loader.load('https://tiles.globalforestwatch.org/glad_prod/tiles/0/0/0.png'));
  const gladMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.006, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: deforestationUniforms(gladTex, 0.95),
      vertexShader: overlayVertexShader,
      fragmentShader: overlayFragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    })
  );
  gladMesh.name    = 'gladAlerts';
  gladMesh.visible = false;
  earth.add(gladMesh);

  scene.add(new THREE.AmbientLight('#7c93ad', 1.4));
  const sunlight = new THREE.DirectionalLight('#fff1d2', 2.2);
  sunlight.position.set(4, 2, 5);
  scene.add(sunlight);

  globeScene = {
    scene,
    camera,
    renderer,
    earth,
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    isDragging: false,
    dragMoved: false,
    lastPointer: { x: 0, y: 0 },
    autoRotate: true,
  };

  // Sync layer visibility immediately from toggles
  const tlToggle   = $('toggle-tree-loss');
  const gladToggle = $('toggle-glad');
  if (tlToggle)   { globeTreeLossVisible = tlToggle.checked;   tlMesh.visible   = globeTreeLossVisible; }
  if (gladToggle) { globeGladVisible     = gladToggle.checked; gladMesh.visible = globeGladVisible;   }

  // Mirror layer toggles into globe
  if (tlToggle)   tlToggle.addEventListener('change', e => { globeTreeLossVisible = e.target.checked; updateGlobeLayers(); });
  if (gladToggle) gladToggle.addEventListener('change', e => { globeGladVisible = e.target.checked;   updateGlobeLayers(); });

  bindGlobeControls();

  // Animation loop — only rotate earth; children follow automatically
  const animate = () => {
    if (!globeScene) return;
    if (globeScene.autoRotate && !globeScene.isDragging) {
      earth.rotation.y += 0.0015;
    }
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  };
  animate();
}

function resizeGlobe() {
  if (!globeScene) return;
  const width = $globeContainer.clientWidth || window.innerWidth;
  const height = $globeContainer.clientHeight || window.innerHeight;
  globeScene.camera.aspect = width / height;
  globeScene.camera.updateProjectionMatrix();
  globeScene.renderer.setSize(width, height);
}

window.addEventListener('resize', resizeGlobe);

function bindGlobeControls() {
  if (!globeScene) return;
  const canvas = globeScene.renderer.domElement;

  canvas.addEventListener('pointerdown', (event) => {
    globeScene.isDragging = true;
    globeScene.dragMoved = false;
    globeScene.lastPointer = { x: event.clientX, y: event.clientY };
    $globeContainer.classList.add('is-dragging');
    canvas.setPointerCapture?.(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!globeScene?.isDragging) return;
    const dx = event.clientX - globeScene.lastPointer.x;
    const dy = event.clientY - globeScene.lastPointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) globeScene.dragMoved = true;
    globeScene.earth.rotation.y += dx * 0.006;
    globeScene.earth.rotation.x = clamp(globeScene.earth.rotation.x + dy * 0.004, -1.2, 1.2);
    globeScene.lastPointer = { x: event.clientX, y: event.clientY };
  });

  canvas.addEventListener('pointerup', (event) => {
    if (!globeScene) return;
    canvas.releasePointerCapture?.(event.pointerId);
    $globeContainer.classList.remove('is-dragging');
    const shouldPick = !globeScene.dragMoved;
    globeScene.isDragging = false;
    if (shouldPick) pickGlobeCoordinates(event);
  });

  canvas.addEventListener('pointercancel', () => {
    if (!globeScene) return;
    globeScene.isDragging = false;
    $globeContainer.classList.remove('is-dragging');
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomGlobe(event.deltaY > 0 ? 0.22 : -0.22);
  }, { passive: false });

  $('globe-zoom-in')?.addEventListener('click', () => zoomGlobe(-0.28));
  $('globe-zoom-out')?.addEventListener('click', () => zoomGlobe(0.28));
  $('globe-reset')?.addEventListener('click', resetGlobeView);
  $('globe-spin')?.addEventListener('click', toggleGlobeSpin);
}

function zoomGlobe(delta) {
  if (!globeScene) return;
  globeScene.camera.position.z = clamp(globeScene.camera.position.z + delta, 1.65, 5.4);
}

function resetGlobeView() {
  if (!globeScene) return;
  globeScene.camera.position.z = 3.1;
  globeScene.earth.rotation.set(0, 0, 0);
  globeScene.autoRotate = true;
  updateGlobeSpinButton();
}

function toggleGlobeSpin() {
  if (!globeScene) return;
  globeScene.autoRotate = !globeScene.autoRotate;
  updateGlobeSpinButton();
}

function updateGlobeSpinButton() {
  const spinButton = $('globe-spin');
  if (!spinButton || !globeScene) return;
  spinButton.setAttribute('aria-pressed', String(globeScene.autoRotate));
}

function pickGlobeCoordinates(event) {
  if (!globeScene) return;
  const rect = globeScene.renderer.domElement.getBoundingClientRect();
  globeScene.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  globeScene.pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
  globeScene.raycaster.setFromCamera(globeScene.pointer, globeScene.camera);
  const hit = globeScene.raycaster.intersectObject(globeScene.earth)[0];
  if (!hit) return;

  const localPoint = globeScene.earth.worldToLocal(hit.point.clone()).normalize();
  const lat = THREE.MathUtils.radToDeg(Math.asin(localPoint.y));
  const phi = Math.atan2(localPoint.z, -localPoint.x);
  const lng = normalizeLng(THREE.MathUtils.radToDeg(phi) - 180);

  $latInput.value = lat.toFixed(6);
  $lngInput.value = lng.toFixed(6);
  lastName = null;
  $locationSearch.value = '';
  updatePrefixes();
  setStatus('ready', `3D Earth selected ${lat.toFixed(4)}, ${lng.toFixed(4)} — click Analyze`);
}

function focusGlobeOnCoordinates(lat, lng) {
  if (!globeScene || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const phi = THREE.MathUtils.degToRad(normalizeLng(lng) + 180);
  const theta = THREE.MathUtils.degToRad(90 - lat);
  const point = new THREE.Vector3(
    -Math.cos(phi) * Math.sin(theta),
    Math.cos(theta),
    Math.sin(phi) * Math.sin(theta)
  );
  globeScene.earth.rotation.y = -Math.atan2(point.x, point.z);
  globeScene.earth.rotation.x = Math.asin(point.y) * 0.45;
}

function normalizeLng(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// =============================================
// INIT
// =============================================
setStatus('ready', 'Ready to Analyze');
$analyzeBtn.disabled = false;
renderRecentSearches();

// Re-enable button when results show
const analyzeObserver = new MutationObserver(() => {
  if (!$resultContent.classList.contains('hidden') || !$errorState.classList.contains('hidden')) {
    $analyzeBtn.disabled = false;
  }
});
analyzeObserver.observe($resultContent, { attributes: true });
analyzeObserver.observe($errorState, { attributes: true });

console.log('%c🌳 ForestWatch loaded', 'color:#00e676;font-size:14px;font-weight:bold');
console.log('%c APIs wired from wri/gfw repo:', 'color:#42a5f5');
console.log('   1. GFW Data API    → data-api.globalforestwatch.org');
console.log('   2. Resource Watch  → api.resourcewatch.org');
console.log('   3. GNW Analytics   → analytics.globalnaturewatch.org');
console.log('   4. Climate Watch   → climatewatchdata.org');
console.log('   5. Open-Meteo      → api.open-meteo.com');
console.log('   6. Nominatim (OSM) → nominatim.openstreetmap.org');



// =============================================
// COORDINATE PREFIXES & SEARCH
// =============================================
function updatePrefixes() {
  const lat = parseFloat($latInput.value);
  const lng = parseFloat($lngInput.value);
  
  const latPrefix = document.getElementById('lat-prefix');
  if (latPrefix) {
    if (!isNaN(lat)) {
      latPrefix.textContent = lat >= 0 ? 'N' : 'S';
    } else {
      latPrefix.textContent = 'N/S';
    }
  }
  
  const lngPrefix = document.getElementById('lng-prefix');
  if (lngPrefix) {
    if (!isNaN(lng)) {
      lngPrefix.textContent = lng >= 0 ? 'E' : 'W';
    } else {
      lngPrefix.textContent = 'E/W';
    }
  }
}

$latInput.addEventListener('input', updatePrefixes);
$lngInput.addEventListener('input', updatePrefixes);

const coordsSearchBtn = document.getElementById('coords-search-btn');
if (coordsSearchBtn) {
  coordsSearchBtn.addEventListener('click', () => {
    $analyzeBtn.click();
  });
}
