# Earth Intelligence Platform

**Forest Eyes** (deforestation) + **River Eyes** (rivers, water quality, hydropower siting) + **Hazard Lens**
(Gemma 4 reads a satellite image together with live river, flood, terrain, rain, soil and forest data).

## Project structure

```
frontend/                 everything the browser loads (served as-is)
  index.html              shell: Forest ⇄ River switch, Hazard Lens toggle, transition animation
  transition.css/.js      the water / forest transition
  forest-eyes/            Forest Eyes app (map, 3D globe, Treeko assistant, "Which trees can grow here?" planner)
  river-eyes/             River Eyes app (river network, site conditions, water quality, City Power Planner, River Dam Atlas)
  hazard/                 Hazard Lens page
backend/                  Node.js server, no npm packages needed (Node 22+)
  server.js               HTTP server: serves frontend/ and every /api route
  gemma.js                shared Gemma 4 client (Amazon Bedrock → Google AI Studio → backup model)
  hazard.js               Hazard Lens: gathers data + satellite image, asks Gemma 4
  dam.js                  hydropower screening: one river, a whole river (atlas), or a city's demand
  rivers.js               HydroRIVERS network: nearest river, tracing, map layer
  water-snap.js           centres close-up river lines on the real water (JRC Global Surface Water)
  water.js                water quality (turbidity, chlorophyll) from Sentinel-2 images
  site.js                 site conditions: soil, earthquakes, river flow
  soil.js                 instant India soil lookups (SoilGrids grid)
  elevation.js            elevation from AWS Terrain Tiles
  forest-api.js           Forest Eyes API: Treeko chat + Global Forest Watch proxy
  forest-extent.js        tree cover in 2000 inside the analysis box (for the annual deforestation rate)
  trees.js                Forest Eyes tree planner: climate (ERA5), soil, air (CAMS) and per-tree reports
  tree-traits.js          team-sourced tree data (data/tree-traits/): validation and merge
  tdwg.js                 botanical region of a point, for Kew's native / introduced records
  rainfall.js             long-term annual rainfall (CHPclim grid, data/rain_chpclim.bin)
  data/                   river network (HydroRIVERS), India soil grid (SoilGrids) and tree requirements (FAO ECOCROP), prebuilt
  datasets/               real data exports for the demo places (CSV) + sources and licences
  scripts/                rebuild data/ and datasets/ from the original sources
```

## Run locally

```
copy .env.example .env      # then add your keys to .env (never commit it)
npm start                   # or: node backend/server.js
```
Open http://localhost:8080 — useful links: `#river` (opens River Eyes), `#lens` (opens the Hazard Lens),
`river-eyes/index.html#plan` (runs the City Power Planner demo).

## Deploy (Render, free)

`render.yaml` describes the service. Push this folder to GitHub, then on render.com:
**New → Blueprint →** pick the repository, paste the secret keys when asked, **Apply**.

## Keys (`.env`, or the host's environment settings)

| Variable | Needed for |
|---|---|
| `GEMINI_API_KEY` | Gemma 4 via Google AI Studio (Treeko, Aqua, Hazard Lens) |
| `GFW_API_KEY` | Global Forest Watch tree-loss analysis in Forest Eyes (without it, Global Nature Watch is used) |
| `BEDROCK_API_KEY`, `BEDROCK_MODEL_ID`, `BEDROCK_REGION` | optional: Gemma 4 on Amazon Bedrock, tried first |

## Data sources

HydroRIVERS / HydroSHEDS (Lehner & Grill 2013) · GloFAS v4 via Open-Meteo · ISRIC SoilGrids 2.0 ·
ESA Sentinel-2 (Microsoft Planetary Computer) · JRC Global Surface Water (Pekel et al. 2016) ·
UMD / Hansen tree cover loss via Global Forest Watch / Global Nature Watch · USGS earthquake catalogue ·
AWS Terrain Tiles · Esri World Imagery · Open-Meteo weather · ERA5 reanalysis · NASA POWER (MERRA-2) · WorldClim 2.1 ·
CHPclim rainfall · CAMS air quality ·
Kew WCVP native ranges ·
FAO ECOCROP tree requirements (via Recocrop) · UNECE critical levels for vegetation. Details and citations: `backend/datasets/README.md`.

All results are screening estimates, not engineering or official hazard assessments.
