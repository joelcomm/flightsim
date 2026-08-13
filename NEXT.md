# Flight sim — next session. Read this first.

Paste this whole file as your opening prompt.

## Where things stand

`~/flightsim` is a working, verified, cel-shaded flight sim. One source file, `src/main.js`
(~5165 lines), plus `index.html` (HUD shell + CSS + main menu) and `vite.config.js`.
`npm run build` produces `docs/index.html` — one self-contained file, ~620 KB, opens from
`file://` with no server.

> **Two sessions ran in parallel and both landed in this file.** Their work merged cleanly —
> nothing was overwritten — but this document was written from one side only and its task
> list had gone stale. It has been reconciled against the source. If you are picking this up
> after another parallel session, check the code before believing the list below.

What exists now:
- 40 x 40 km analytic world, seeded and stable. ~17% water. Peaks to 1040 m.
- 5 airfields (MERIDIAN FIELD is home), 7 settlements (1 city / 2 towns / 4 villages),
  **99 landmarks**, a road network of 15 A*-routed links, 420 cars, 360 pedestrians.
- **THE SOUND BRIDGE** — a 2.5 km span with a 109 m deck and 105 m of clearance beneath,
  carrying a real road across a firth that is >14 km round by land.
- **774 roadside buildings** — ribbon development thinning out from each town.
- **6 AI aircraft and 4 balloons** — 2 airliners, 2 crop dusters, 2 gliders in a thermal.
- **A start-field picker** on the menu; a crash returns you to the field you chose.
- **A landing scorecard** and a personal best per airfield, persisted.
- **A discovery log** — fly within 420 m of a landmark to log it; unfound ones are absent
  from the map. Persisted.
- Chunked LOD terrain, toon water, ink post-process, forests, map view (M) at 52 m a cell,
  first-person cockpit (C), synthesised sound (N to mute), eject + parachute, main menu.

## Ground rules (these matter)

- **`~/driver` is a live deployed game and is READ-ONLY.** It is the source the engine, the
  cel-shading, the ink pass and the flight model were harvested from. Copy out, never edit.
- **The flight model's signs are load-bearing.** Every yaw and roll sign in `updatePlane`
  was gotten wrong twice on the original project and fixed by looking at the screen.
  A turns left, D right, Q banks left, E banks right, bank matches turn. Verified both
  numerically and on screen. Do not "tidy" them.
- **`ENERGY` (line ~2401) is the gravity-along-flight-path constant.** Set it to 0 and the
  model is bit-for-bit the harvested one. It is 14, not 9.81, because the whole model runs
  at roughly twice real-world accelerations.
- **Temp debug helpers go in as `window.__something` and MUST be stripped before any build
  I look at. `grep -c "window\.__" src/main.js` has to be 0.** (The 4 hits in
  `docs/index.html` are three.js's `__THREE__` and the scaffold's `__err` — those are fine.)
- Comments explain WHY, not what. Match the existing density.
- Investigate and PROVE a cause before fixing. In this project the obvious theory has been
  wrong repeatedly — see "Bugs that have already bitten" below.
- Show evidence: screenshots or measured numbers, not "should work". State plainly what you
  did NOT verify.

## How to verify things here

**Offline, for anything in the terrain core.** `src/main.js` has markers
`// ---8<--- TERRAIN CORE START` (line 45) and `END` (line 437). Everything between them is
free of THREE and runs under plain node. Slice it out with `fs.readFileSync` +
`indexOf` and `import('data:text/javascript,' + encodeURIComponent(core + exports))`. This
cannot drift from what ships. Use it for terrain, siting, coverage and any geometry maths.

**In the browser.** The Claude preview pane throttles requestAnimationFrame and the sim sits
frozen between JS calls, so `setTimeout` measurements silently return zeros. Test: read a
counter twice; identical means it is not ticking. **Taking a screenshot forces frames.**
Reliable pattern: install a `window.__probe` → drive it → screenshot → read via JS.
`computer{action:"key"}` events do not carry `e.code`, so dispatch
`new KeyboardEvent('keydown',{code:'KeyM'})` instead. Screenshot coordinates are in
screenshot pixels, not CSS pixels.

**Check the build's exit code directly** (`npx vite build > /tmp/b.log 2>&1; echo $?`).
Chaining `&&` off a `tail` reports success when the build failed. That has bitten me.

## Architecture you need to know

Everything derives from one function:

- **`terrainH(x, z, out)`** (line 189) — the analytic height field. The mesher, the flight
  model, the scatter, the roads, the map mesh and every landmark all sample it. Pass the
  `SMP` scratch as `out` to get biome weights back (`land`, `wPl`, `wAr`, `wMtn`, `rw`
  strip weight, `cw` settlement weight). ~200 ns per call.
- **`SITES`** — flattened sites. Runways and settlements blend the height field toward a base
  elevation, so a strip is flat and seamlessly joined for free with no special-casing.
- **`STRIPS`** (5), **`TOWNS`** (7), **`LANDMARKS`** (99), **`PLACES`** (the nav + map list,
  each `{name, x, z, kind}` where kind is `strip|town|mark`). Line numbers throughout this
  section are stale — the file has roughly doubled. Grep, do not trust them.
- **`cityHit(wx, wy, wz)`** — the only collision in the world. Walks `LM_HIT` cylinders and
  their finer `parts` lists, `LM_BOX`, each settlement's block grid, then `SPRAWL_GRID`.
- **`roadPaths`** / **`STREET_PATHS`** → prepared into **`HIGHWAYS`** / **`STREETS`**
  (line 2826) via `preparePath` / `samplePath`. Cars and pedestrians ride these.
  **`updateTraffic(dt, px, pz)`** (line 2879) advances everything but only positions what is
  inside the cull radius.
- **`SPECIES`** — 8 instanced scatter species (6 common, 2 old-growth). **`refreshScenery(px, pz, budgetMs)`**
  (line 920) is amortised across frames against a 4 ms budget; a full pass is ~25 ms.
  **`ROAD_CELLS`** is a 14 m mask so nothing plants on the tarmac — and, since landmarks
  mask their own bounding box into it, nothing plants inside a landmark either.
- **Map**: `buildMapMesh` (3023), `toggleMap` (3098), `updateMapOverlay` (3111). The map
  camera's orientation is **pinned** (`camera.rotation.set(-Math.PI/2,0,0)`), not derived from
  `lookAt` — see the bug list.
- **`spinners[]`** (line 1529) — anything that rotates each frame (turbine rotors, windmill
  sails, the ferris wheel). Push `{o: object3D, spd}`.
- **Audio**: `initAudio` (2943) on first gesture, `bump(vol, freq, dur, type)` (2974) for
  one-shot impacts, `updateAudio` for the engine and wind.
- **`frame(now)`** (line 3424) is the loop.

---

# The work

Everything on the original list is built. What follows is what it became, then the bugs
that bit on the way, then what is genuinely still open.

## Done

- **Landmark collision you can fly through.** `hbox`/`hring` part lists on a landmark's hit
  tuple; the bounding cylinder demotes to a broad phase. `LM_BOX` is the parallel
  mechanism the bridge uses — both live in `cityHit`.
- **Pylon races.** Three courses sited from existing geometry: WINDROW SLALOM (11 gates),
  PORT MERIDIAN CIRCUIT (8), THE CANYON RUN (11). Clock, personal best, and a translucent
  **ghost of your best run**. Gates are only laid where the aeroplane could actually fly
  through — one city gate was rejected for being inside a tower.
- **Limbo runs.** The arch, all ten aqueduct bays, the Sound Bridge. A pier does not count
  and neither does a pass over the deck.
- **Landing score and logbook.** Six components, weakest one caps the mark. History of the
  last 24 landings. **L** opens a records screen with everything persisted.
- **Discovery log**, **flown track on the map**, **skydiving bullseyes**, **AI aircraft and
  balloons**, **birds flushed from woodland**, **pedestrians looking up**, **old-growth
  forest tier**, **surface grain on tarmac and walls**, **start-field picker**,
  **ribbon development** (774 roadside buildings), **52 m map**.

## Still open

- **Textures are deliberately minimal.** Only tarmac and building walls carry grain, at a
  14% multiply. Terrain has none, because it has no UVs — adding them means editing the
  chunk mesher, and the art holds together largely *because* everything is flat colour.
  Do this one carefully or not at all.
- **The audio has still never been heard.**
- **Nobody has flown the courses by hand.** They were driven through programmatically to
  prove the gate logic; whether they are *fun* is unknown, and the gate spacing and
  altitudes are first guesses.
- PIER AMUSEMENTS has no flyable opening — the pile rows are 16 m apart and `PLANE_R` is 5,
  leaving 4.8 m. Widen the deck if you want that limbo run.

## Bugs that have already bitten, so you do not repeat them

- **Arrays hard-coded to an old length.** The scatter's `counts` array and its upload loop
  were both `3` from when there were three species; adding three more left them generating
  into nothing for several sessions. Grep for magic counts when you add to a list.
- **`lookAt` from directly overhead is degenerate.** It derives screen-up from the tiny
  horizontal offset between camera and target. Panning the map made that offset swing and
  the whole map rolled 112°. The map camera's rotation is pinned now — leave it pinned.
- **A camera looks down its own local −Z but the aircraft's nose is +Z.** Copying the
  airframe's rotation onto the camera points it at the tail.
- **`ShaderMaterial` defaults `fog` to false.** Setting `fog: true` on one without three's
  fog uniforms throws every frame.
- **`vertexColors: true` plus `instanceColor`** makes three read a `color` attribute the
  geometry does not have; everything renders black.
- **A sky dome parked at the world origin** is wrong in a 40 km world — it now follows the
  camera.
- **A ribbon sampled its height once, on the centreline.** Both road edges got that same
  y, so on any cross-slope the uphill edge was buried in the hill and the downhill edge
  floated — 4% of the road was inside the terrain, up to 3.4 m deep, which is what made it
  look chopped into blocks. Corners now sample individually and long segments subdivide.
  If a surface has width, give every corner its own height.
- **Anything sited by `radius from HOME` needs clamping to the world.** HOME is not at the
  origin, so a 13 km radius put drop zones at z = 26 km in a world that stops at 20 — and
  `updatePilot` clamps the parachutist to the world, so those targets were arithmetically
  impossible to hit. The balloons had the identical bug earlier.
- **`THREE.Line` is one device pixel wide whatever you ask for.** The flown track rendered
  perfectly and was invisible from a map camera 32 km up. Anything that must read at map
  scale has to be a ribbon of triangles with a width in metres.
- **`updateMapOverlay` rescales every child of `mapMarks`** to hold the pins at constant
  screen size. Adding anything with absolute world coordinates to that group multiplies its
  vertices by the camera height. Give it its own group.
- **A `const` is not hoisted, a `function` is.** Race-course siting calls `cityHit` from
  earlier in the file than `PLANE_R` was declared; the call resolved and then died in the
  temporal dead zone. If you call a function from further up the file, check what it reads.
- **The scatter did not know landmarks existed.** It masked strips, towns and roads, so
  trees grew through the castle and across the speedway. Landmarks now mask their own
  measured bounding box.
- **Hard thresholds silently drop content.** A 5 m minimum road elevation stranded a
  seaside town and lost 2 of 7 links without a word; a 34 m relief limit made EAGLE SHELF
  vanish entirely. Prefer graded penalties, and always log how many of a thing were placed
  versus attempted.
- **A town's contents were rotated the opposite way to its own layout.** `toWorld` is a
  **+hdg** rotation; the massing, roofs and street tarmac were all drawn at `-hdg`. It is
  invisible at 0° and 90° (a rectangle is unchanged by 180°) and severe at 120°, so the
  one town anybody had looked at closely was the one that happened to be fine. 37% of
  street traffic was driving on grass. If a sign looks wrong, find a case where the two
  conventions *disagree* before believing either.
- **A coarse grid cannot see a thin thing.** The road router sampled runway proximity at
  250 m grid nodes; a runway is 30-48 m wide, so the penalty fired on almost nothing.
  Worse, airfield nodes were the strip *centre*, so the road's destination was the runway.
  Measure against the real rectangle, and remember A* snaps a goal to the nearest node —
  an apron less than RG/2 from the tarmac gets rounded back onto it.
- **A weighted average hides a single bad component.** The landing score gave 82/100 to a
  touchdown two thirds of the way down the strip because five other terms were fine. The
  weakest component now caps the mark.
- **Verifying by teleport is a trap.** Setting `plane.position` does not move the chase
  camera with it — it lerps, and the preview pane only advances frames on a screenshot, so
  the first several shots show the old place. Pause (P) so the camera catches up while the
  aircraft holds still, and prefer calling the function under test and reading the number.

## Known not verified

- **Traffic and pedestrians have never been checked visually in motion.** 420 cars and 360
  people are confirmed numerically — correct instance counts, correct positions 0.30 m above
  ground, correct geometry — but I have never seen them clearly enough to judge how they
  look. Worth a low slow pass down a city street early on.
- **The audio has never been heard.** The graph runs at 48 kHz and the start button unlocks
  it correctly, but nobody has judged how it sounds.
- Only a handful of the 99 landmarks have been eyeballed. The rest are confirmed *placed on
  appropriate ground* and spread evenly (2 empty cells of a 7x7 lattice, max 6 per cell),
  not confirmed to *look* right.
- The bridge has been seen from the air but nobody has actually flown under it.
