# Team tree data (`backend/data/tree-traits/`)

One JSON file per tree, named `<id>.json` (e.g. `peepal.json`). The app loads every file here at
start-up (files starting with `_` are ignored). A file is used **only if every value has a source
and an exact quote, and a person has checked the quotes against the real page** (`checkedBy`).

- **Tree ECOCROP does not have** (peepal, jamun, burans…): becomes a new tree in the planner, scored
  on the fields you provide. It needs `annualRainfallMm` **and** at least one of `meanAnnualTempC`,
  `absMinTempC` or `altitudeM`; otherwise it is listed as "Not enough data yet".
- **Tree ECOCROP has** (banj oak, deodar…): ECOCROP's ranges stay for scoring; your altitude,
  lowest temperature (when ECOCROP has no frost limit) and traits are added and shown with their sources.

## Workflow

1. Find the tree in a **real source** (list below). Open the actual page or PDF.
2. Copy that text into GPT with the prompt below (one tree, one source per run).
3. Save GPT's JSON as `backend/data/tree-traits/<id>.json`.
4. **A team member opens the source and checks every quote and number**, fixes anything wrong,
   and writes their name in `checkedBy`. GPT can misread or invent; this step is what makes the data usable.
   If `family` is empty, fill it from Plants of the World Online (powo.science.kew.org).
5. Run `node backend/scripts/check-tree-traits.js` and fix every ✕.
6. For new trees, run `node backend/scripts/build-native-ranges.js` (Kew native ranges; needs internet).
7. Send the files to be merged. Two sources for one tree? Do one run per source, then keep the
   better-supported value in one file (the validator takes one source per field).

**What to expect from Troup:** the main species have a climate paragraph ("In its natural habitat the
absolute maximum shade temperature varies from 95° to 115° F., the absolute minimum from 35° to 60° F.,
and the normal rainfall from 60 to 200 inches") → `absMaxTempC`, `absMinTempC`, `annualRainfallMm`, in °F
and inches (the app converts). Minor species (e.g. peepal, which is a short entry in vol. 3) usually give
only words ("frost-hardy", "conspicuously hardy" in drought, "evergreen or nearly so"): use them for the
category fields, and look for the numbers in ICRAF or eFlora. The 1921 edition is on the Internet
Archive (archive.org, "The Silviculture of Indian Trees", vols 1-3).

## Sources to use (in this order)

| What | Source |
|---|---|
| Climate, altitude, light, frost and drought, soils (Indian trees) | Troup, R. S., *The Silviculture of Indian Trees* (and FRI Dehradun's revised edition) |
| Ecology, uses, propagation (tropical and subtropical trees) | Orwa, C. et al. (2009) *Agroforestree Database: a tree reference and selection guide*, version 4.0, World Agroforestry Centre |
| Description, distribution, altitude | eFlora of India; Flora of India (Botanical Survey of India) |
| Pollution tolerance | CPCB *Guidelines for Developing Green Belts* (PROBES/75/1999-2000), or a peer-reviewed APTI study (give the paper) |
| Invasive risk | IUCN Global Invasive Species Database; CABI Compendium |

Do not use: GPT's own memory, blogs, nursery sales pages, Wikipedia (follow its references to the real source instead).

## Fields

| Field | Value | Units accepted (converted by the app) | Used for |
|---|---|---|---|
| `annualRainfallMm` | `{ "min", "max" }` (optional `"optMin"`, `"optMax"`) | mm, cm, in | Water check |
| `meanAnnualTempC` | `{ "min", "max" }` | °C, °F | Climate check |
| `absMinTempC` | number: lowest temperature it is recorded to withstand / absolute minimum in its range | °C, °F | Frost warning |
| `absMaxTempC` | number: highest (shade) temperature in its range | °C, °F | Report |
| `altitudeM` | `{ "min", "max" }` | m, ft | Altitude warning |
| `soilPh` | `{ "min", "max" }` | pH | Soil check |
| `soilTexture` | list of `light` (sandy), `medium` (loamy), `heavy` (clayey) | — | Soil check |
| `light` | `full-sun`, `partial-shade` or `shade-tolerant` | — | Sunlight check |
| `leafHabit` | `deciduous`, `evergreen`, `semi-evergreen` | — | Report |
| `heightM` | number (mature height) | m, ft | Report |
| `growthRate` | `slow`, `medium`, `fast` | — | Report |
| `droughtTolerance`, `frostTolerance` | `low`, `medium`, `high` | — | Report |
| `rootSystem`, `wildlifeValue`, `invasiveRisk`, `plantingSeason`, `propagation` | short text | — | Report |
| `nitrogenFixing` | `true` / `false` | — | Report |
| `uses` | list of short words (timber, fodder, fruit…) | — | Report |
| `pollutionTolerance` | `sensitive`, `intermediate`, `tolerant` | — | Report |

Every field: `{ "value": …, "unit": "…", "source": { "title", "author", "year", "edition", "page" or "url" }, "quote": "exact words" }`.
A field you cannot source: leave `value` as `null` (see `_template.json`).

## Trees to do first

**Not in ECOCROP at all.** Check the accepted name on Plants of the World Online (powo.science.kew.org)
first, because some have changed (e.g. *Polyalthia longifolia* → *Monoon longifolium*):
peepal *Ficus religiosa* · jamun *Syzygium cumini* · ashoka *Saraca asoca* · burans *Rhododendron arboreum* ·
kachnar *Bauhinia variegata* · bhimal *Grewia optiva* · kharik *Celtis australis* · kafal *Myrica esculenta* ·
mehal *Pyrus pashia* · timla *Ficus auriculata* · phaliyant *Quercus glauca* · reetha *Sapindus mukorossi* ·
chilbil *Holoptelea integrifolia* · false ashoka *Polyalthia longifolia* · gular *Ficus racemosa* ·
pilkhan *Ficus virens* · maulsari *Mimusops elengi* · kanak champa *Pterospermum acerifolium* ·
jarul *Lagerstroemia speciosa* · putranjiva *Putranjiva roxburghii*

**In ECOCROP, but altitude and traits missing** (use the same `id` as in the app):
`banj-oak`, `moru-oak`, `kharsu-oak`, `deodar`, `chir-pine`, `pindrow-fir`, `himalayan-spruce`,
`himalayan-cypress`, `utis`, `walnut`, `horse-chestnut`, `toon`, `sal`, `shisham`, `khair`, `bakain`

## The prompt (copy everything between the lines into GPT)

---

You are helping build a sourced tree database for a university forestry app. Extract facts **only
from the SOURCE TEXT below**. Do not use your own knowledge, even if you are sure.

TREE: [scientific name] ([local name])
APP ID: [id, e.g. peepal]
SOURCE: [title; author; year; edition; page numbers, or URL]
SOURCE TEXT:
<<<
[paste the text of the source here]
>>>

Rules:
1. Fill a field only if the SOURCE TEXT states it. Otherwise set `"value": null` and `"quote": ""`.
2. `quote` must be the exact words copied from the SOURCE TEXT that state the value (one or two sentences). Never paraphrase.
3. Do not convert units. Put the unit exactly as written in the text in `unit` (mm, cm, in, °C, °F, m, ft).
4. Do not infer numbers. "Grows in moist places" is not a rainfall figure; "a hill tree" is not an altitude.
5. When the text gives several values for one field (e.g. "the absolute minimum from 35° to 60° F."), use the lowest for `absMinTempC` (and for a range's `min`) and the highest for `absMaxTempC` (and a range's `max`), and quote the sentence. "Absolute maximum shade temperature" → `absMaxTempC`; "absolute minimum" → `absMinTempC`; "normal rainfall" → `annualRainfallMm`.
6. Qualitative words map to categories only when they say it plainly: "frost-hardy" → `frostTolerance` "high"; "suffers much from frost" → "low"; "drought-hardy" / "conspicuously hardy" in drought → `droughtTolerance` "high"; "evergreen or nearly so" → `leafHabit` "evergreen".
7. Categories must be exactly one of the allowed words, and only when the text says it in those or plainly equivalent words (e.g. "a strong light-demander" → `full-sun`; "tolerates heavy shade" → `shade-tolerant`). If unsure, use null.
8. Fill `source` from the SOURCE line above, and `page` with the page the quote is on, if shown.
9. `name` and `family`: as written in the text. If the text has no English name, repeat the local name; if it has no family, write "" (the team fills it from Plants of the World Online).
10. Leave `checkedBy` as "" (a person fills it after checking).
11. Output **only** one JSON object in exactly this format, with no comments and no text before or after it:

{
  "id": "[APP ID]",
  "scientific": "[scientific name]",
  "name": "[English name as written in the text, else the local name]",
  "localName": "[local name]",
  "family": "[plant family as written in the text, else \"\"]",
  "checkedBy": "",
  "fields": {
    "annualRainfallMm": { "value": { "min": null, "max": null }, "unit": "", "source": {}, "quote": "" },
    "meanAnnualTempC": { "value": { "min": null, "max": null }, "unit": "", "source": {}, "quote": "" },
    "absMinTempC": { "value": null, "unit": "", "source": {}, "quote": "" },
    "absMaxTempC": { "value": null, "unit": "", "source": {}, "quote": "" },
    "altitudeM": { "value": { "min": null, "max": null }, "unit": "", "source": {}, "quote": "" },
    "soilPh": { "value": { "min": null, "max": null }, "unit": "pH", "source": {}, "quote": "" },
    "soilTexture": { "value": null, "source": {}, "quote": "" },
    "light": { "value": null, "source": {}, "quote": "" },
    "leafHabit": { "value": null, "source": {}, "quote": "" },
    "heightM": { "value": null, "unit": "", "source": {}, "quote": "" },
    "growthRate": { "value": null, "source": {}, "quote": "" },
    "droughtTolerance": { "value": null, "source": {}, "quote": "" },
    "frostTolerance": { "value": null, "source": {}, "quote": "" },
    "rootSystem": { "value": null, "source": {}, "quote": "" },
    "nitrogenFixing": { "value": null, "source": {}, "quote": "" },
    "uses": { "value": null, "source": {}, "quote": "" },
    "wildlifeValue": { "value": null, "source": {}, "quote": "" },
    "pollutionTolerance": { "value": null, "source": {}, "quote": "" },
    "invasiveRisk": { "value": null, "source": {}, "quote": "" },
    "plantingSeason": { "value": null, "source": {}, "quote": "" },
    "propagation": { "value": null, "source": {}, "quote": "" }
  }
}

Allowed words: `soilTexture` list of "light" (sandy), "medium" (loamy), "heavy" (clayey); `light` "full-sun" |
"partial-shade" | "shade-tolerant"; `leafHabit` "deciduous" | "evergreen" | "semi-evergreen"; `growthRate`
"slow" | "medium" | "fast"; `droughtTolerance` and `frostTolerance` "low" | "medium" | "high";
`pollutionTolerance` "sensitive" | "intermediate" | "tolerant"; `nitrogenFixing` true | false;
`uses` a list of short words. `absMinTempC` = the lowest temperature the text says it withstands or
meets in its natural range; `meanAnnualTempC` = only if the text gives mean annual temperature.

---
