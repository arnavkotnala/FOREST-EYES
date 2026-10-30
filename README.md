# Earth Eyes — Earth Intelligence Platform

**Forest Eyes** (deforestation and tree planting) · **River Eyes** (rivers, water quality, hydropower siting) ·
**Hazard Lens** (multi-hazard screening for any point on Earth). All the AI reasoning is done by **Gemma 4**.

Earth Eyes combines open global datasets (river networks, satellite imagery, floods, terrain, soil, climate,
forest loss) with Gemma 4. Gemma reads a **satellite image together with the measured numbers** and returns
a structured, sourced assessment. The data is always measured or modelled from a named source. Gemma
interprets it and never invents it.

---

## Gemma 4 in Earth Eyes

### Where Gemma 4 is used

| Feature | App | What Gemma 4 receives | What it returns |
|---|---|---|---|
| **Hazard Lens** | all | Esri satellite image of the area + terrain/slope, 7-day past and 3-day forecast rain, GloFAS river discharge vs normal, nearest river and downstream reach, soil | JSON: headline, overall level, each hazard (flood, landslide, debris flow, erosion, deforestation, drought/low flow, glacial) with **evidence from the image**, **evidence from the data**, confidence, actions and data gaps |
| **Water quality reading** | River Eyes | Latest cloud-free Sentinel-2 true-colour image + turbidity (Dogliotti 2015) and chlorophyll index (NDCI) | JSON: summary, what's visible in the image, likely causes, next steps (e.g. field sampling for DO/BOD) |
| **Dam site review** | River Eyes | A candidate hydropower site from the City Power Planner or River Dam Atlas, sent through the Hazard Lens | The same image + data hazard assessment, for the dam site |
| **Aqua** chat | River Eyes | Question + selected river and coordinates | Answer on hydrology, floods, water quality, dam siting |
| **Treeko** chat | Forest Eyes | Question + place + deforestation analysis + soil profile | JSON answer + suggested planting sites, each **coordinate checked** to lie inside the analysis area before it reaches the map |
| **Tree report** | Forest Eyes planner | One tree + this place's climate, soil, air quality and checklist | Per-tree report. If no model answers, a **rule-based report**, clearly labelled as such |

Everything goes through one shared client, [`backend/gemma.js`](backend/gemma.js).

### Models and providers

| Order | Provider | Model | Enabled by |
|---|---|---|---|
| 1 | **Amazon Bedrock** | Gemma 4 (your `BEDROCK_MODEL_ID`) | `BEDROCK_API_KEY` + `BEDROCK_MODEL_ID` |
| 2 | **Google AI Studio** (Gemini API) | `gemma-4-26b-a4b-it`, then `gemma-4-31b-it` | `GEMINI_API_KEY` (models set by `GEMMA_MODELS`) |
| 3 | Backup model (optional) | Gemini models in `GEMINI_FALLBACK_MODEL` | only used if every Gemma 4 attempt fails |

Every answer reports which provider and model produced it, so the UI can show *"Answered by gemma-4-…"*.
When the backup answers, it's labelled as a backup, not as Gemma.

### How we made Gemma 4 reliable

Gemma 4 on the free API sometimes returns 500s, hangs, or gets stuck repeating itself. `gemma.js` handles this:

- **Hedged retries:** every attempt is time-capped (`GEMMA_TIMEOUT_MS`), all attempts share one budget
  (`GEMMA_BUDGET_MS`). If an attempt is slow, a second one starts on the *other* Gemma 4 model
  (`GEMMA_HEDGE_MS`). The first good answer wins and the other is cancelled.
- **Loop detection:** answers that repeat words or phrases ("near-neutral, near-neutral, …") count as
  failures and are retried.
- **JSON checking:** structured answers are parsed before they're accepted. Invalid JSON is retried.
- **Two JSON modes:** the Hazard Lens uses constrained decoding (schema enforced), which was faster.
  Treeko and the tree report describe the schema in the prompt instead. In a small team test, the enforced
  schema made Gemma 4 26B loop in 7 of 8 Treeko answers, against 0 of 4 with the prompt-only schema.
- **No system role:** Gemma has no system role, so instructions and the JSON contract go at the start of
  the first user turn.
- **Images on both providers:** images are sent as `inline_data` to AI Studio and converted to Bedrock's
  image format automatically.

### Keeping Gemma 4 on topic and safe

[`frontend/forest-eyes/ai-guard.js`](frontend/forest-eyes/ai-guard.js) protects Treeko and Aqua in three layers:

1. **Before the model:** obvious code requests are refused without calling Gemma.
2. **In the prompt:** scope rules in the instructions, repeated next to the newest question so a long
   story can't push them out of view.
3. **After the model:** any answer containing code is replaced by the refusal. Forged earlier "assistant"
   turns sent by a client are dropped.

The guard is tested with attack prompts and a **held-out set never used while tuning**
(`tests/browser/guard-test.js`, `tests/browser/heldout.js`). Model output is HTML-escaped before display,
and chat and AI endpoints are rate-limited per visitor and site-wide to protect the shared quota.

### Honesty rules given to Gemma

- Use only the numbers provided, quoted with units, and say which source they came from.
- Report missing data as missing ("not visible", "data gap") and never fill it in.
- Satellites see colour, not chemistry: no claims about DO, BOD, pH, metals or bacteria from imagery.
- Results are **screening estimates**, not engineering or official hazard assessments.

---

## Project structure

```
frontend/                 everything the browser loads (served as-is)
  index.html              shell: Forest ⇄ River switch, Hazard Lens toggle, transition animation
  transition.css/.js      the water / forest transition
  forest-eyes/            Forest Eyes (map, 3D globe, Treeko, "Which trees can grow here?" planner)
    ai-guard.js           keeps Treeko and Aqua on topic and code-free (browser + server)
    treeko-brain.js       Treeko's prompt, JSON schema and planting-site checks (browser + server)
  river-eyes/             River Eyes (river network, site conditions, water quality, City Power Planner, River Dam Atlas, Aqua)
  hazard/                 Hazard Lens page (map, place search, PDF report)
backend/                  Node.js server, no npm packages needed (Node 22+)
  server.js               HTTP server: serves frontend/ and every /api route, rate limits, Aqua chat
  gemma.js                shared Gemma 4 client (Bedrock → AI Studio → optional backup)
  hazard.js               Hazard Lens: gathers data + satellite image, asks Gemma 4
  water.js                water quality from Sentinel-2, read by Gemma 4
  trees.js                tree planner: climate, soil, air quality, Gemma 4 tree reports
  forest-api.js           Forest Eyes API: Treeko chat + Global Forest Watch proxy
  dam.js                  hydropower screening: one river, a whole river (atlas), or a city's demand
  rivers.js               HydroRIVERS network: nearest river, tracing, map layer
  water-snap.js           centres close-up river lines on the real water (JRC Global Surface Water)
  site.js                 site conditions: soil, earthquakes, river flow
  elevation.js            elevation from AWS Terrain Tiles
  soil.js                 offline soil grids (India + global)
  forest-extent.js        tree cover in 2000 inside the analysis box
  rainfall.js, worldclim.js, tdwg.js, tree-traits.js   offline climate, botanical regions, team tree data
  data/                   prebuilt grids and networks (HydroRIVERS, SoilGrids, CHPclim, WorldClim, ECOCROP, Kew)
  datasets/               real data exports for the demo places (CSV) + sources and licences
  scripts/                rebuild data/ and datasets/ from the original sources; validation
tests/browser/            Playwright UI tests and AI-guard attack tests (not deployed)
```

## Run locally

```bash
cp .env.example .env      # add your keys (never commit .env)
npm start                 # or: node backend/server.js
```

Open http://localhost:8080. Useful links: `#river` opens River Eyes, `#lens` opens the Hazard Lens,
and `river-eyes/index.html#plan` runs the City Power Planner demo. `GET /api/v1/health` shows which
Gemma 4 providers and models are configured (never the keys).

## Deploy (Render, free)

`render.yaml` describes the service. On render.com: **New → Blueprint →** pick this repository, paste the
secret keys when asked, **Apply**. No build step is needed.

## Configuration (`.env`, or the host's environment settings)

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Gemma 4 via Google AI Studio (Hazard Lens, water reading, Aqua, Treeko, tree reports) |
| `GEMMA_MODELS` | Gemma 4 models to try, in order (default `gemma-4-26b-a4b-it,gemma-4-31b-it`) |
| `BEDROCK_API_KEY`, `BEDROCK_MODEL_ID`, `BEDROCK_REGION` | optional: Gemma 4 on Amazon Bedrock, tried first |
| `GEMINI_FALLBACK_MODEL` | optional backup model(s) if Gemma 4 does not answer |
| `GEMMA_TIMEOUT_MS`, `GEMMA_BUDGET_MS`, `GEMMA_HEDGE_MS`, `GEMMA_ATTEMPTS` | optional tuning of retries and timeouts |
| `GFW_API_KEY` | Global Forest Watch tree-loss analysis in Forest Eyes |

Treeko also has a **browser-only mode** (page opened without the server). The user pastes their own key,
which is kept only in their browser, and Treeko calls the Gemini API directly. With the server running,
Treeko answers through Gemma 4 like everything else.

## Data sources

HydroRIVERS / HydroSHEDS (Lehner & Grill 2013) · GloFAS v4 via Open-Meteo · ISRIC SoilGrids 2.0 ·
ESA Sentinel-2 (Microsoft Planetary Computer) · JRC Global Surface Water (Pekel et al. 2016) ·
UMD / Hansen tree cover loss via Global Forest Watch / Global Nature Watch · USGS earthquake catalogue ·
AWS Terrain Tiles · Esri World Imagery · Open-Meteo weather · ERA5 reanalysis · NASA POWER (MERRA-2) ·
WorldClim 2.1 · CHPclim rainfall · CAMS air quality · Kew WCVP native ranges ·
FAO ECOCROP tree requirements (via Recocrop) · UNECE critical levels for vegetation.
Details, licences and citations: [`backend/datasets/README.md`](backend/datasets/README.md).

## Team

| Module | Members |
|---|---|
| Hazard Eyes (Hazard Lens, platform core) | Arnav Kotnala |
| River Eyes | Arnav Sharma, Aryaman |
| Forest Eyes | Ishita, Akshat |

---

All results are screening estimates, not engineering or official hazard assessments.
