# ForestWatch — Deforestation Intelligence Platform

A standalone web app built on the Global Forest Watch (wri/gfw) API ecosystem.

## How to Use
1. Open `index.html` in any modern browser (Chrome/Edge/Firefox) — no server or install needed.
2. **Search** for a location by name, OR click anywhere on the map, OR type lat/lng manually.
3. Adjust the **Analysis Radius** (1–50 km).
4. Click **Analyze Deforestation** — the app will:
   - Submit your area to the GNW Analytics API (same engine as globalforestwatch.org)
   - Show how many hectares of trees were lost (2021–2024)
   - Classify the severity: 🔴 Red / 🟠 Orange / 🟡 Yellow / 🟢 Green
   - Calculate how many trees need to be planted to offset carbon emissions
5. The **Autonomous Climate Engine** panel shows live temperature, humidity, precipitation, and a global warming risk score.

## Severity Scale
| Color | Loss (ha, 2021–2024) | Meaning |
|---|---|---|
| 🔴 Red | > 100 ha | Very High Deforestation |
| 🟠 Orange | 10–100 ha | Moderate Deforestation |
| 🟡 Yellow | 1–10 ha | Low Deforestation |
| 🟢 Green | < 1 ha | Negligible |

## APIs Used (All Free, No API Key Required)
- **GNW Analytics**: `analytics.globalnaturewatch.org` — Tree cover loss + carbon emissions
- **Open-Meteo**: `api.open-meteo.com` — Real-time weather (temp, humidity, precipitation, wind)
- **Nominatim (OSM)**: `nominatim.openstreetmap.org` — Location search/geocoding
- **Leaflet + CartoDB**: Interactive dark satellite map

## Built From
Code architecture, API endpoints, and response formats extracted from the `wri/gfw` GitHub repository.
