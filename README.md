# Nowhere in Particular

*A whimsical flight of fancy.*

A cel-shaded flight sim over forty kilometres of procedurally generated nowhere. No
missions, no career, no tutorial — five airfields, ninety-nine landmarks and a reason to
go and look at the blank corners of the map.

**[Play it in your browser →](https://joelcomm.github.io/flightsim/)**

## What's out there

- A **40 × 40 km** analytic world, seeded and stable — the same hills in the same place
  every load. Roughly 17% water, peaks to 1,040 m.
- **5 airfields**, **7 settlements**, **99 landmarks**, and a road network of 15 A*-routed
  links with 420 cars and 360 people on it.
- **The Sound Bridge** — a 2.5 km span with 105 m of air underneath, carrying a real road
  across a firth that is 14 km round by land. You can fly under it.
- **Ribbon development**: 774 roadside buildings, thinning out the further you get from a
  town.
- Airliners overhead, crop dusters working a field, gliders circling a thermal you can
  join, and hot air balloons drifting.

## Things to do

| | |
|---|---|
| **Land well** | Every landing is scored on sink rate, centreline, touchdown point, wings and attitude. Personal best per airfield. |
| **Find things** | 99 landmarks. Unfound ones are absent from the map, so the blank corners are worth flying to. |
| **Race** | Three pylon courses — a turbine slalom, a city circuit and a canyon run — with a clock and a translucent ghost of your best run. |
| **Fly under things** | The stone arch, ten aqueduct bays, and the length of the bridge. |
| **Jump** | Bail out over a bullseye and score how close you land. |

Press **L** for the logbook. Landings, landmarks, course times and limbo runs all persist
between sessions; the trail you draw on the map is per-flight and starts clean on every
refresh.

Add `?mute=1` to the URL to start silent.

## Controls

```
W  throttle          A D  turn           Q E  roll
S  slow / brake      Space  nose up      Ctrl  nose down
R  eject, again for the chute
C  camera / cockpit  M  map   L  logbook  N  sound  P  pause
Esc  menu — change airfield any time
```

Hold **W**, rotate at 47 kts.

## Building it

```bash
npm install
npm run dev     # local dev server
npm run build   # writes docs/index.html
```

The build is a **single self-contained file** — around 620 KB with three.js and the whole
world inlined. It has no external requests of any kind, so `docs/index.html` opens
straight off disk with no server at all. That is also what GitHub Pages serves.

## How it is built

One source file, `src/main.js`, plus an HTML shell for the HUD and menu.

Everything in the world derives from a single function, `terrainH(x, z)` — an analytic
height field with no stored heightmap anywhere. The mesher, the flight model, the scatter,
the road router, the map and every landmark all sample the same function, so nothing can
drift out of agreement with anything else. Airfields and towns are flat because the height
field itself blends toward a base elevation there, not because anything was levelled
afterwards.

The terrain is chunked with distance-based LOD and rebuilt against a millisecond budget
spread over several frames; so is the scatter and the map mesh. The art is flat-colour
toon shading with an ink post-process, and the surface detail is kept deliberately
low-frequency — fine patterns go sub-pixel at a 40 km view distance and turn into a
shimmering mess.

## Licence

MIT — see [LICENSE](LICENSE).
