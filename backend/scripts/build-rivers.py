"""
Builds the river network files from the HydroRIVERS v1.0 global geodatabase:

  data/hydrorivers.bin       attributes + start/end point of every kept reach
  data/hydrorivers_geom.bin  the reach shapes (simplified to ~SIMPLIFY_DEG), for maps and
                             for snapping dam sites to the real channel

Kept reaches:
  - worldwide:            upstream area >= GLOBAL_MIN_KM2  (every significant river)
  - India region (bbox):  upstream area >= INDIA_MIN_KM2   (practically every named river)
Filtering by upstream area keeps NEXT_DOWN chains intact, because area only grows downstream.

Usage:  python -I scripts/build-rivers.py "HydroRIVERS data/HydroRIVERS_v10.gdb" data
Needs:  pip install pyogrio numpy shapely
Data:   Lehner, B., Grill G. (2013). Global river hydrography and network routing:
        baseline data and new approaches to study the world's large river systems.
        Hydrological Processes, 27(15): 2171-2186. https://www.hydrosheds.org
"""
import os
import struct
import sys
import time

import numpy as np
import pyogrio.raw as raw
import shapely

GLOBAL_MIN_KM2 = 1000
INDIA_MIN_KM2 = 100
INDIA_BBOX = (68.0, 6.5, 97.5, 37.5)  # lon/lat; also covers Nepal, Bhutan, Bangladesh, east Pakistan
SIMPLIFY_DEG = 0.0015                 # ~150 m

src, out_dir = sys.argv[1], sys.argv[2]
cols = ['HYRIV_ID', 'NEXT_DOWN', 'MAIN_RIV', 'LENGTH_KM', 'DIST_DN_KM', 'UPLAND_SKM', 'DIS_AV_CMS', 'ORD_STRA']

t = time.time()
parts = [
    raw.read(src, columns=cols, where=f'UPLAND_SKM >= {GLOBAL_MIN_KM2}'),
    raw.read(src, columns=cols, bbox=INDIA_BBOX,
             where=f'UPLAND_SKM >= {INDIA_MIN_KM2} AND UPLAND_SKM < {GLOBAL_MIN_KM2}'),
]
fields = {c: np.concatenate([p[3][p[0]['fields'].tolist().index(c)] for p in parts]) for c in cols}
wkb = np.concatenate([p[2] for p in parts])
n = len(wkb)
print(f'read {n} reaches ({len(parts[0][2])} global + {len(parts[1][2])} India detail) in {time.time() - t:.0f}s', flush=True)

geoms = shapely.simplify(shapely.from_wkb(wkb), SIMPLIFY_DEG, preserve_topology=False)
# One line per reach: merge multi-part reaches into a single vertex list, in order
coords, owner = shapely.get_coordinates(geoms, return_index=True)
order = np.argsort(owner, kind='stable')
coords, owner = coords[order], owner[order]
counts = np.bincount(owner, minlength=n)
if (counts < 2).any():
    raise SystemExit(f'{int((counts < 2).sum())} reaches lost their geometry')
offsets = np.concatenate([[0], np.cumsum(counts)]).astype('<u4')
xy = np.round(coords * 1e5).astype('<i4')
first = xy[offsets[:-1]]
last = xy[offsets[1:] - 1]
print(f'{len(xy)} vertices after simplification ({len(xy) / n:.1f} per reach) in {time.time() - t:.0f}s', flush=True)

with open(os.path.join(out_dir, 'hydrorivers.bin'), 'wb') as fh:
    fh.write(b'HYRV')
    fh.write(struct.pack('<II', 1, n))
    fh.write(fields['HYRIV_ID'].astype('<i4').tobytes())
    fh.write(fields['NEXT_DOWN'].astype('<i4').tobytes())
    fh.write(fields['MAIN_RIV'].astype('<i4').tobytes())
    for c in ['LENGTH_KM', 'DIST_DN_KM', 'UPLAND_SKM', 'DIS_AV_CMS']:
        fh.write(fields[c].astype('<f4').tobytes())
    for col in (first[:, 0], first[:, 1], last[:, 0], last[:, 1]):  # x0, y0, x1, y1
        fh.write(np.ascontiguousarray(col).astype('<i4').tobytes())
    fh.write(fields['ORD_STRA'].astype('u1').tobytes())

with open(os.path.join(out_dir, 'hydrorivers_geom.bin'), 'wb') as fh:
    fh.write(b'HYRG')
    fh.write(struct.pack('<III', 1, n, len(xy)))
    fh.write(offsets.tobytes())
    fh.write(xy.tobytes())  # lon, lat pairs × 1e5
print(f'wrote {out_dir}/hydrorivers.bin and hydrorivers_geom.bin in {time.time() - t:.0f}s', flush=True)
