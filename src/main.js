// Nowhere in Particular — the whole thing, one module. Imported by index.html.
//
// The engine, the cartoon shading, the ink post-process and the entire flight model
// are harvested from Public Nuisance (~/driver). That project is live and read-only:
// everything here was copied out, never edited in place. What changed is only what
// had to — the town is gone, and in its place is an analytic wilderness.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import * as BGU from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// =================================================================
//  RENDERER / SCENE / CAMERA
// =================================================================
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Shadow maps are deliberately OFF, unlike the town this came from. There a 4096 map
// over a 240 m box covered the whole playable area; out here the aircraft ranges over
// 16 km, so the same map would either be a blurry smear or would have to be re-fitted
// to the frustum every frame. The toon ramp plus the hemisphere fill already carry the
// form, and the one thing a cast shadow was really doing — telling you how high you
// are over the ground — is done better by the blob shadow under the aircraft.
renderer.shadowMap.enabled = false;
app.appendChild(renderer.domElement);

const SKY_COLOR = 0xbfe6f7;
const scene = new THREE.Scene();
// Fog is the world's edge. Chunked terrain reaches ~8 km; fog closes it out at 6 km,
// so the outermost, coarsest ring is already a wash of sky colour before it ends.
const worldFog = new THREE.Fog(SKY_COLOR, 1400, 8600);
scene.fog = worldFog;
renderer.setClearColor(SKY_COLOR);

// far has to clear the fog, but every metre of it costs depth precision, and the ink
// pass reads that depth buffer — a mushy depth buffer is a mushy outline. 12 km is the
// smallest number that keeps the fogged-out horizon from visibly clipping.
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.4, 12000);

// ---8<--- TERRAIN CORE START (kept free of THREE so it can be run under plain node)
// =================================================================
//  MATH + VALUE NOISE
//  Small, deterministic, no dependencies. The whole world falls out of an integer
//  hash seeded by one constant, so every load raises exactly the same land and the
//  place can actually be learned — which is the point of a fixed world.
// =================================================================
const SEED = 20260811;
// Half-extent. At 40 x 40 km the same field scales that gave the old 16 km world 6-8
// cells of variety now give ~15, so growing the map buys genuinely new country rather
// than more of the same country — several landmasses, real archipelagos, deserts you
// can get lost in. Crossing it corner to corner is about 16 minutes at cruise.
const WORLD = 20000;
const SEA_Y = 0;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// A 2D integer hash. The multiply-xor-shift chain is the usual avalanche mixer; what
// matters is that neighbouring lattice points decorrelate completely, or the noise
// shows its grid.
function hash2i(ix, iz) {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ SEED) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return ((h ^ (h >>> 16)) >>> 0) * 2.3283064365386963e-10;   // /2^32 -> 0..1
}

// Value noise with a smoothstep fade. Gradient noise would look better, but this is
// sampled by the flight model at arbitrary points every frame as well as by the
// mesher, and the smoothstep fade already gives a continuous first derivative — which
// is all the normals need to come out smooth.
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2i(ix, iz), b = hash2i(ix + 1, iz);
  const c = hash2i(ix, iz + 1), d = hash2i(ix + 1, iz + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}

// Octave frequencies step by 2.03 rather than 2, and each octave carries its own
// offset: on an exact doubling every octave's lattice lands on the same integer
// coordinates and the sum shows a hard grid through the middle of the world.
function fbm(x, z, oct) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f + i * 57.3, z * f - i * 91.7);
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return sum / norm;
}

// The 1-|2n-1| fold turns the noise's smooth minima into creases. Mountains want
// crests, not blobs, and this is the cheapest way to get them.
function ridge(x, z, oct) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    const n = vnoise(x * f + i * 17.1, z * f + i * 33.9);
    sum += amp * (1 - Math.abs(2 * n - 1));
    norm += amp; amp *= 0.5; f *= 2.07;
  }
  return sum / norm;
}

// =================================================================
//  TERRAIN
//  Three low-frequency fields, not four drawn regions:
//    continent -> where there is land at all, so the coastline falls out for free
//    rugged    -> how much mountain amplitude this place gets
//    arid      -> desert vs plains, both shape and palette
//  Height is a weighted blend of per-biome height functions using those weights.
//  Because the weights are continuous, every transition blends itself: no seams to
//  handle, and foothills and beaches come out of the arithmetic rather than being
//  special-cased.
// =================================================================
// Field scales are set so the world spans several cells of each field's coarsest
// octave — much broader and it is one blob of one biome, much finer and it is noise.
//
// The continent field is deliberately the broadest and the *smoothest* (three octaves,
// not four). Those two knobs do different jobs and it is worth keeping them apart:
// COAST decides how much of the world is sea, while the scale and octave count decide
// how shredded the coastline is. An earlier pass had them at 1/2600 and four octaves,
// which measured 6.7% of samples straddling a waterline — an archipelago of hundreds of
// islets rather than country you can fly across. This is 3.0%.
const CONT_S = 1 / 4200, RUG_S = 1 / 1900, ARID_S = 1 / 2400, FOR_S = 1 / 1500;
const COAST = 0.36;                    // continent value at the waterline -> ~15% sea

// Scratch for the biome weights. terrainH fills it when asked, so the mesher gets
// the weights it needs to colour a vertex without paying for the fields twice.
const SMP = { land: 0, wPl: 0, wAr: 0, wMtn: 0, rw: 0, cw: 0 };

// =================================================================
//  FLATTENED SITES — the runways and the city
//  Both are one idea: a rotated rectangle that blends the height field toward a base
//  elevation, easing out over `fall` metres. Distance is measured to the *rectangle*,
//  so the falloff wraps the ends as well as the sides and there is no crease where a
//  strip stops. Because the mesh, the scatter and the flight model all sample the same
//  function, every one of them is flat and seamlessly joined for free.
// =================================================================
const SITES = [];
let sitesReady = false;
// Scratch filled by siteAt(): the winning blend, and separately how much of this point
// is strip and how much is city — which is what paints the ground and keeps the trees
// off both. Module scope rather than a returned object because terrainH is the hottest
// function in the sim and this must not allocate.
let _siteT = 0, _siteY = 0, _stripW = 0, _cityW = 0;

function siteAt(x, z, rawH) {
  _siteT = 0; _siteY = 0; _stripW = 0; _cityW = 0;
  for (let i = 0; i < SITES.length; i++) {
    const s = SITES[i];
    const dx = x - s.x, dz = z - s.z;
    if (dx * dx + dz * dz > s.r2) continue;     // bounding circle first — this is hot
    const lz = dx * s.sn + dz * s.cs;           // along the strip
    const lx = dx * s.cs - dz * s.sn;           // across it
    const ax = Math.abs(lx) - s.hw, az = Math.abs(lz) - s.halfLen;
    let t;
    if (ax <= 0 && az <= 0) t = 1;
    else {
      const d = Math.hypot(Math.max(ax, 0), Math.max(az, 0));
      if (d >= s.fall) continue;
      t = 1 - smoothstep(0, s.fall, d);
    }
    if (s.city) {
      // The city pad stops at the water. Without this gate the flatten would raise
      // the sea bed to the city's elevation and fill in the bay it was sited for —
      // the coastline is most of why that site won. Gated on the RAW height, so the
      // pad fades out exactly where the shore is.
      t *= smoothstep(-2, 12, rawH);
      if (t <= 0) continue;
      if (t > _cityW) _cityW = t;
    } else if (t > _stripW) _stripW = t;
    if (t > _siteT) { _siteT = t; _siteY = s.y; }
  }
}

// The height field. `out` is optional; pass SMP to get the biome weights back.
//
// Everything added on top of the continental shelf is non-negative and scaled by
// `land`, which is ~0 at the waterline. That is what makes the beaches work: detail
// fades out before the water does, so the ground always meets the sea flat.
function terrainH(x, z, out) {
  const c = fbm(x * CONT_S + 11.5, z * CONT_S - 4.25, 3);
  // signed shelf: above COAST the interior swells, below it the ground drops away
  // into a sea bed. The two sides get different gains so the seas are deeper than
  // the plains are high, which is what makes coasts read as coasts.
  const s = c - COAST;
  const shelf = s >= 0 ? s * 260 : s * 420;
  const land = smoothstep(COAST - 0.02, COAST + 0.10, c);

  let h = shelf;
  let wPl = 0, wAr = 0, wMtn = 0;
  if (land > 0.001) {
    const rg = fbm(x * RUG_S - 88.1, z * RUG_S + 130.7, 3);
    const ar = fbm(x * ARID_S + 301.4, z * ARID_S + 57.2, 3);
    // Only the top of the rugged field makes real mountains. Take the whole field
    // and the world is mountainous everywhere, which reads as noise rather than as
    // ranges — you want to be able to fly *between* them.
    wMtn = smoothstep(0.46, 0.72, rg);
    wAr = smoothstep(0.46, 0.62, ar) * (1 - wMtn);
    wPl = 1 - wMtn - wAr;

    let det = 0;
    if (wPl > 0.001) {
      det += wPl * (fbm(x * 0.00095 + 5, z * 0.00095 - 9, 4) * 34
                  + fbm(x * 0.0052 - 3, z * 0.0052 + 7, 2) * 6);
    }
    if (wAr > 0.001) {
      // Dunes run in bands: a directional sine whose phase is dragged around by a
      // slow noise, so the crests curve and branch instead of ruling the desert
      // into stripes.
      const ph = (x * 0.0026 + z * 0.0011) + fbm(x * 0.0009 + 21, z * 0.0009 - 13, 2) * 9;
      det += wAr * ((0.5 + 0.5 * Math.sin(ph)) * 26 + fbm(x * 0.0014 + 40, z * 0.0014 + 40, 3) * 18);
    }
    if (wMtn > 0.001) {
      // squared, so the ridges tower instead of plateauing — the peaks get most of
      // the amplitude and the valleys between them stay flyable
      const r = ridge(x * 0.00062 - 17, z * 0.00062 + 29, 5);
      det += wMtn * (r * r * 1000 + fbm(x * 0.004 + 2, z * 0.004 + 2, 3) * 40);
    }
    h += land * det;
  }

  // The sites flatten the FUNCTION, not a mesh — see the note above SITES.
  if (sitesReady) {
    siteAt(x, z, h);
    if (_siteT > 0) h = lerp(h, _siteY, _siteT);
  }

  if (out) {
    out.land = land; out.wPl = wPl; out.wAr = wAr; out.wMtn = wMtn;
    out.rw = sitesReady ? _stripW : 0;
    out.cw = sitesReady ? _cityW : 0;
  }
  return h;
}

// Where the woods are. Its own field, at a finer scale than the biome fields, so a
// forest is a place with an edge you can fly along rather than an even sprinkle of
// trees over every green thing in the world.
function forestF(x, z) {
  return fbm(x * FOR_S + 611.3, z * FOR_S - 407.9, 3);
}

// What fraction of a ring at radius r is sea — the test behind "is this a beach" and
// "is this an island".
function waterFrac(x, z, r, n) {
  let w = 0;
  for (let i = 0; i < n; i++) {
    const a = i / n * 6.283185307;
    if (terrainH(x + Math.cos(a) * r, z + Math.sin(a) * r) < 0) w++;
  }
  return w / n;
}

// Worst deviation from the centre height over a rotated footprint, and the lowest
// point in it. This is what decides whether a strip can actually go here.
function footprint(x, z, hdg, halfLen, hw) {
  const sn = Math.sin(hdg), cs = Math.cos(hdg);
  const y0 = terrainH(x, z);
  let worst = 0, lowest = Infinity;
  for (let t = -1; t <= 1.001; t += 0.2) {
    for (let s = -1; s <= 1; s++) {
      const y = terrainH(x + t * halfLen * sn + s * hw * cs, z + t * halfLen * cs - s * hw * sn);
      const d = Math.abs(y - y0);
      if (d > worst) worst = d;
      if (y < lowest) lowest = y;
    }
  }
  return { y0, worst, lowest };
}

// The airfields, in the order they are placed. Each has a character, and each is sited
// by the thing that makes it that character — the beach one wants sea nearby, the shelf
// one wants height, the island one wants to be surrounded by water. Placing them by
// rule rather than by hand means they belong to the seed: the same five fields, in the
// same places, every load, on ground that genuinely suits them.
const STRIP_SPECS = [
  { key: 'home', name: 'MERIDIAN FIELD', halfLen: 550, hw: 24, fall: 300, surf: 0x33353d,
    pick: c => c.y > 14 && c.y < 190 && c.wMtn < 0.30, maxRelief: 55 },
  { key: 'dust', name: 'DRY LAKE', halfLen: 380, hw: 20, fall: 240, surf: 0xc9ae82,
    pick: c => c.wAr > 0.50 && c.y > 10 && c.y < 260, maxRelief: 45 },
  { key: 'beach', name: 'LONGSHORE', halfLen: 310, hw: 16, fall: 170, surf: 0xbfa878,
    pick: c => c.y > 3 && c.y < 30, near: (c) => waterFrac(c.x, c.z, 380, 10) > 0.2, maxRelief: 26 },
  { key: 'shelf', name: 'EAGLE SHELF', halfLen: 260, hw: 15, fall: 230, surf: 0x6f7278,
    // Genuinely level ground above 300 m is rare, and it got rarer when the continent
    // field was broadened — at a 34 m limit this strip stopped being sited at all and
    // vanished from the world without a word. A wider falloff lets it accept a rougher
    // shelf and still blend the cut into the mountain rather than notching it.
    pick: c => c.y > 260, maxRelief: 52 },
  { key: 'isle', name: 'CASTAWAY', halfLen: 240, hw: 14, fall: 150, surf: 0xbfa878,
    pick: c => c.y > 4 && c.y < 90, near: (c) => waterFrac(c.x, c.z, 1500, 14) > 0.75, maxRelief: 26 },
];

// Settlements, largest first — they are placed in this order and each keeps clear of
// the ones already down, so the city gets the best ground and the villages fill in
// around it. `tier` drives everything downstream: block size, building height, palette.
const T_CITY = 0, T_TOWN = 1, T_VILLAGE = 2;
const TOWN_SPECS = [
  { name: 'PORT MERIDIAN', tier: T_CITY,    half: 1500, fall: 800, minSep: 9000, wantCoast: 80, maxRelief: 110 },
  { name: 'HALLOWFIELD',   tier: T_TOWN,    half: 760,  fall: 460, minSep: 5200, wantCoast: 25, maxRelief: 80 },
  { name: 'DUNMORE',       tier: T_TOWN,    half: 700,  fall: 440, minSep: 5200, wantCoast: 0,  maxRelief: 80 },
  { name: 'ASHBY',         tier: T_VILLAGE, half: 340,  fall: 240, minSep: 2800, wantCoast: 0,  maxRelief: 55 },
  { name: 'CALDER',        tier: T_VILLAGE, half: 300,  fall: 220, minSep: 2800, wantCoast: 30, maxRelief: 55 },
  { name: 'WICKLOW',       tier: T_VILLAGE, half: 320,  fall: 230, minSep: 2800, wantCoast: 0,  maxRelief: 55 },
  { name: 'TARNSIDE',      tier: T_VILLAGE, half: 280,  fall: 210, minSep: 2800, wantCoast: 0,  maxRelief: 55 },
];
const TOWNS = [];
const HDGS = [0, Math.PI / 6, Math.PI / 3, Math.PI / 2, 2 * Math.PI / 3, 5 * Math.PI / 6];

// Site everything, once, before anything samples terrainH in anger — so every base
// elevation is measured on unflattened ground and no site can feed back on itself.
//
// Two phases, because a 40 km world is 16 times the area the single-pass scan was
// written for: one cheap sweep that records a candidate per lattice point with a
// four-sample relief estimate, then a full rotated-footprint search over only the best
// handful of candidates per site.
function siteWorld() {
  const cands = [];
  const STEP = 520, EXT = WORLD * 0.86;
  for (let gx = -EXT; gx <= EXT; gx += STEP) {
    for (let gz = -EXT; gz <= EXT; gz += STEP) {
      const y = terrainH(gx, gz, SMP);
      if (y < 3) continue;                           // in the sea
      // cheap relief estimate: four samples on a 260 m cross
      let rel = 0;
      for (const [ox, oz] of [[260, 0], [-260, 0], [0, 260], [0, -260]])
        rel = Math.max(rel, Math.abs(terrainH(gx + ox, gz + oz) - y));
      cands.push({ x: gx, z: gz, y, rel, wAr: SMP.wAr, wMtn: SMP.wMtn, land: SMP.land });
    }
  }

  const placed = [];
  const clearOf = (c, minSep) => placed.every(p => Math.hypot(c.x - p.x, c.z - p.z) > minSep);

  // ---- settlements go first: they need the most room and the best ground ----
  //
  // A settlement footprint is nothing like a runway's, so it gets its own fit test. In
  // particular it must NOT demand that every sample is dry land: the first version did,
  // which quietly made a coastal site impossible — the very thing the scoring rewards —
  // and no city was ever placed at all. What it wants is a good majority of usable land
  // level with the middle, and for the bigger places, water at one edge.
  const townFit = (x, z, half) => {
    const y0 = terrainH(x, z);
    let land = 0, n = 0, worst = 0;
    for (let a = -1; a <= 1.001; a += 0.25) {
      for (let b = -1; b <= 1.001; b += 0.25) {
        const y = terrainH(x + a * half, z + b * half); n++;
        if (y > 1) { land++; const d = Math.abs(y - y0); if (d > worst) worst = d; }
      }
    }
    return { y0, landFrac: land / n, worst };
  };
  for (const spec of TOWN_SPECS) {
    const relCap = spec.tier === T_CITY ? 30 : spec.tier === T_TOWN ? 40 : 55;
    const pool = cands
      .filter(c => c.y > 6 && c.y < 260 && c.wMtn < 0.18 && c.rel < relCap && clearOf(c, spec.minSep))
      .sort((a, b) => a.rel - b.rel)
      .slice(0, 90);
    let best = null;
    for (const c of pool) {
      const fp = townFit(c.x, c.z, spec.half);
      if (fp.landFrac < 0.5 || fp.worst > spec.maxRelief) continue;
      const coast = clamp01((1 - fp.landFrac) / 0.35);
      const score = fp.worst - coast * spec.wantCoast;
      if (!best || score < best.score) best = { c, fp, score, coast };
    }
    if (!best) continue;
    const hdg = HDGS[(hash2i(best.c.x | 0, best.c.z | 0) * HDGS.length) | 0];
    const t = { name: spec.name, tier: spec.tier, half: spec.half, fall: spec.fall,
      x: best.c.x, z: best.c.z, y: best.fp.y0, hdg,
      sn: Math.sin(hdg), cs: Math.cos(hdg), coast: best.coast };
    TOWNS.push(t);
    SITES.push({ x: t.x, z: t.z, y: t.y, sn: t.sn, cs: t.cs, hw: t.half,
      halfLen: t.half, fall: t.fall, city: true, r2: (t.half + t.fall) ** 2 * 2 });
    placed.push({ x: t.x, z: t.z });
  }

  // ---- then the airfields ----
  const strips = [];
  for (const spec of STRIP_SPECS) {
    const minSep = spec.key === 'home' ? 3200 : 2600;
    let pool = cands.filter(c => spec.pick(c) && c.rel < spec.maxRelief * 1.6 && clearOf(c, minSep));
    // the home field wants to be a short hop from the city, not next door to it and
    // not an hour away — it is where every flight starts
    if (spec.key === 'home' && TOWNS.length) {
      const C = TOWNS[0];
      pool.sort((a, b) => Math.abs(Math.hypot(a.x - C.x, a.z - C.z) - 6500)
                        - Math.abs(Math.hypot(b.x - C.x, b.z - C.z) - 6500));
      pool = pool.slice(0, 70);
    }
    // The character test comes BEFORE the shortlist, not after. Applying it after
    // slicing to the flattest 45 meant the island strip was looking for an island
    // among the 45 flattest patches of ground in the world, found none, and silently
    // never got built.
    if (spec.near) pool = pool.filter(spec.near);
    pool.sort((a, b) => a.rel - b.rel);
    pool = pool.slice(0, 45);

    let best = null;
    for (const c of pool) {
      for (const hdg of HDGS) {
        const fp = footprint(c.x, c.z, hdg, spec.halfLen, spec.hw);
        if (fp.lowest < (spec.key === 'beach' || spec.key === 'isle' ? 2 : 6)) continue;
        if (fp.worst > spec.maxRelief) continue;
        if (!best || fp.worst < best.fp.worst) best = { c, hdg, fp };
      }
    }
    if (!best) continue;
    const s = { key: spec.key, name: spec.name, surf: spec.surf,
      x: best.c.x, z: best.c.z, y: best.fp.y0, hdg: best.hdg,
      sn: Math.sin(best.hdg), cs: Math.cos(best.hdg),
      hw: spec.hw, halfLen: spec.halfLen, fall: spec.fall, city: false,
      r2: (spec.hw + spec.fall) ** 2 + (spec.halfLen + spec.fall) ** 2,
      relief: best.fp.worst };
    SITES.push(s); strips.push(s); placed.push({ x: s.x, z: s.z });
  }

  // Never leave the player without somewhere to start, however odd the seed.
  if (!strips.length) {
    const s = { key: 'home', name: 'MERIDIAN FIELD', surf: 0x33353d,
      x: 0, z: 0, y: Math.max(20, terrainH(0, 0)), hdg: 0, sn: 0, cs: 1,
      hw: 24, halfLen: 550, fall: 300, city: false,
      r2: (24 + 300) ** 2 + (550 + 300) ** 2, relief: -1 };
    SITES.push(s); strips.push(s);
  }
  sitesReady = true;
  return strips;
}
// ---8<--- TERRAIN CORE END

const STRIPS = siteWorld();
const HOME = STRIPS[0];
for (const s of STRIPS)
  console.log(`strip ${s.name} at ${s.x | 0},${s.z | 0} · elev ${s.y.toFixed(0)}m`
    + ` · hdg ${((-s.hdg * 180 / Math.PI % 360) + 360) % 360 | 0}° · raw relief ${s.relief.toFixed(1)}m`);
for (const t of TOWNS)
  console.log(`town ${t.name} (tier ${t.tier}) at ${t.x | 0},${t.z | 0} · elev ${t.y.toFixed(0)}m`
    + ` · half ${t.half}m · coast ${(t.coast * 100) | 0}%`);
if (TOWNS.length < TOWN_SPECS.length)
  console.warn(`only ${TOWNS.length}/${TOWN_SPECS.length} settlements found a site`);

// =================================================================
//  CARTOON SHADING
//  Toon ramp for the flat colour; the ink lines are a post-process at the bottom
//  rather than a back-face shell per mesh, exactly as in the game this came from.
// =================================================================
function toonRamp(steps) {
  const c = document.createElement('canvas'); c.width = steps; c.height = 1;
  const g = c.getContext('2d');
  const stops = [0.55, 0.78, 1.0, 1.0];
  for (let i = 0; i < steps; i++) {
    const v = Math.round(255 * stops[Math.min(i, stops.length - 1)]);
    g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(i, 0, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false;
  return t;
}
const RAMP = toonRamp(3);
const matCache = new Map();
function toon(color) {                       // shared per colour, so merging stays cheap
  if (!matCache.has(color)) matCache.set(color, new THREE.MeshToonMaterial({ color, gradientMap: RAMP }));
  return matCache.get(color);
}
// A thin bright edge where the surface curls away from the camera — the classic
// animated-film rim. One smoothstep on the view angle, tinted mostly by the surface's
// own colour so an orange fuselage rims orange, not white. Only the aircraft gets it;
// on the ground it reads as frost.
function addRim(mat) {
  mat.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>',
      `{
        float rimNV = 1.0 - saturate(dot(normalize(vViewPosition), normal));
        outgoingLight += (diffuseColor.rgb * 0.7 + 0.3) * smoothstep(0.55, 0.75, rimNV) * 0.35;
      }
      #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'rim1';
  return mat;
}
const rimCache = new Map();
function toonRim(color) {
  if (!rimCache.has(color)) rimCache.set(color, addRim(new THREE.MeshToonMaterial({ color, gradientMap: RAMP })));
  return rimCache.get(color);
}
const INK_COLOR = 0x14192e;

const dummy = new THREE.Object3D();
function baked(geo, x, y, z, rx, ry, rz) {
  const g = geo.clone();
  dummy.position.set(x || 0, y || 0, z || 0); dummy.rotation.set(rx || 0, ry || 0, rz || 0);
  dummy.scale.set(1, 1, 1); dummy.updateMatrix();
  g.applyMatrix4(dummy.matrix); return g;
}
const merge = list => {
  const norm = list.map(g => (g.index ? g.toNonIndexed() : g));
  return BGU.mergeGeometries(norm);
};
const BOX = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const rnd = (a, b) => a + Math.random() * (b - a);

// blob shadows under the hero objects
function blobShadow(size) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,.5)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; scene.add(m); return m;
}

// =================================================================
//  SUN / SKY / CLOUDS
//  Permanent mid-morning. The town this came from had a full day cycle built and
//  then shelved it because the game read better in daylight; the same is true here,
//  and a fixed sun means the water shader's uSun never has to change.
// =================================================================
const hemi = new THREE.HemisphereLight(0xcdeaff, 0x6f8a52, 2.1);
scene.add(hemi);
const sunDir = new THREE.Vector3(0.42, 0.78, 0.32).normalize();
const sun = new THREE.DirectionalLight(0xfff6e2, 2.5);
sun.position.copy(sunDir).multiplyScalar(500);
scene.add(sun, sun.target);

let skyDome = null;
// Sky dome. depthTest and depthWrite are both off and it draws first: it must not
// stamp anything into the depth buffer, because the ink pass reads that buffer and a
// dome that writes depth comes back as a horizon-wide ink line.
{
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x63b0e8) },
      uBot: { value: new THREE.Color(SKY_COLOR) },
    },
    vertexShader: `varying float vY;
      void main(){ vY = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uTop, uBot; varying float vY;
      void main(){
        // Banded rather than a smooth ramp — a gradient sky under a cel shaded world is
        // the one thing that gives the look away. The joins get a narrow blend: dead
        // hard edges read as a rainbow arch drawn across the sky rather than as paint.
        float t = clamp(vY * 1.25, 0.0, 1.0);
        float b = floor(t * 3.0), f = fract(t * 3.0);
        float band = clamp((b + smoothstep(0.72, 1.0, f)) / 3.0, 0.0, 1.0);
        gl_FragColor = vec4(mix(uBot, uTop, band), 1.0);
      }`,
  });
  skyDome = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 20), domeMat);
  skyDome.renderOrder = -10; skyDome.frustumCulled = false; scene.add(skyDome);
}

// Fat storybook clouds. Scattered on a lattice that follows the aircraft rather than
// sprinkled once over the whole world: spread 110 puffs across 40 x 40 km and you fly
// for minutes under an empty sky. Deterministic per cell, so they stay put as you pass
// them and the same cloud is over the same bay every time.
const CLOUD_CELL = 1400, CLOUD_R = 8000;
let cloudMesh = null, cloudCX = 1e9, cloudCZ = 1e9;
{
  const lobes = [];
  for (let i = 0; i < 7; i++)
    lobes.push(baked(new THREE.SphereGeometry(rnd(9, 17), 7, 5), rnd(-26, 26), rnd(-3, 4), rnd(-9, 9)));
  const n = Math.ceil(CLOUD_R / CLOUD_CELL);
  let cap = 0;
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) if (i * i + j * j <= n * n) cap++;
  cloudMesh = new THREE.InstancedMesh(merge(lobes),
    new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP }), cap);
  cloudMesh.frustumCulled = false; cloudMesh.count = 0;
  scene.add(cloudMesh);
}
function refreshClouds(px, pz) {
  const cx = Math.round(px / CLOUD_CELL), cz = Math.round(pz / CLOUD_CELL);
  if (cx === cloudCX && cz === cloudCZ) return;
  cloudCX = cx; cloudCZ = cz;
  const n = Math.ceil(CLOUD_R / CLOUD_CELL);
  let k = 0;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      if (i * i + j * j > n * n) continue;
      const gx = cx + i, gz = cz + j;
      const r = hash2i(gx * 917 + 31, gz * 5237 - 17);
      if (r > 0.62) continue;
      dummy.position.set((gx + hash2i(gx, gz + 7) - 0.5) * CLOUD_CELL,
        430 + hash2i(gx + 3, gz) * 620,
        (gz + hash2i(gx + 11, gz) - 0.5) * CLOUD_CELL);
      dummy.rotation.set(0, hash2i(gx - 5, gz - 5) * 6.283, 0);
      dummy.scale.setScalar(1.5 + hash2i(gx + 21, gz + 21) * 2.4);
      dummy.updateMatrix();
      cloudMesh.setMatrixAt(k++, dummy.matrix);
    }
  }
  cloudMesh.count = k;
  cloudMesh.instanceMatrix.needsUpdate = true;
}

// =================================================================
//  TERRAIN MESH — chunks that follow the aircraft
//  Levels of detail are nested rings of chunks, each level twice the size of the one
//  inside it at a lower mesh resolution. Every chunk is cached by (level, cx, cz), so
//  flying forward builds only the handful of chunks that are genuinely new.
//
//  The nesting is exact, which is the whole trick. A level's chunk interval is forced
//  to start on an even index and to be an even number of chunks long, so a coarse
//  chunk is either wholly covered by the finer level inside it or wholly outside it —
//  never half. That removes both the overlap (coarse mesh poking through fine) and the
//  gap (a hole to the sky) that a naive radius test gives you.
//
//  Differing resolution across a ring boundary still leaves cracks, so every chunk
//  carries a skirt: a vertical curtain hanging from its border. It costs a few hundred
//  triangles and it makes the seam problem go away entirely.
// =================================================================
const LEVELS = [
  { size: 512, res: 32 },     // 16 m quads
  { size: 1024, res: 24 },    // 43 m
  { size: 2048, res: 16 },    // 128 m
  { size: 4096, res: 12 },    // 341 m
  { size: 8192, res: 8 },     // 1024 m — pure fog filler, but it has to be there
  { size: 16384, res: 6 },    // and one more, so terrain still outruns the pushed-back fog
];
const RING = 2;               // 2*RING chunks per axis per level

const C_SAND = new THREE.Color(0xe4d09a), C_GRASS = new THREE.Color(0x77c157),
      C_GRASS2 = new THREE.Color(0x4f9440), C_DUNE = new THREE.Color(0xdcb673),
      C_DUNE2 = new THREE.Color(0xbe8a4e), C_ROCK = new THREE.Color(0x8d8f99),
      C_ROCK2 = new THREE.Color(0x646771), C_SNOW = new THREE.Color(0xf4f8ff),
      C_BED = new THREE.Color(0xa8a074), C_TARMAC = new THREE.Color(0x33353d),
      C_URBAN = new THREE.Color(0x8d9184);
const _ca = new THREE.Color(), _cb = new THREE.Color();

// Ground cover, as a texture rather than as noise. The trap with detailing flat-shaded
// terrain is high-frequency speckle: it looks like grain from fifty feet and turns into a
// shimmering mess at four miles, because a 40 km view makes any fine pattern sub-pixel.
// So this is deliberately LOW frequency — broad soft blotches you read as heath, scrub and
// bare patches — with only a whisper of fine grain under it. Blotches survive being
// minified; speckle does not.
//
// Wrapped value noise, so the tile is seamless and can repeat across the whole world
// without a visible edge.
function groundGrain(size, cells, amp) {
  const lat = n => {
    const a = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) a[j * n + i] = hash2i(i * 37 + n, j * 91 - n);
    return a;
  };
  const samp = (a, n, u, v) => {
    const x = u * n, y = v * n;
    const i0 = ((x | 0) % n + n) % n, j0 = ((y | 0) % n + n) % n;
    const i1 = (i0 + 1) % n, j1 = (j0 + 1) % n;
    let fx = x - Math.floor(x), fy = y - Math.floor(y);
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    return (a[j0 * n + i0] * (1 - fx) + a[j0 * n + i1] * fx) * (1 - fy)
         + (a[j1 * n + i0] * (1 - fx) + a[j1 * n + i1] * fx) * fy;
  };
  const A = lat(cells), B = lat(cells * 4);
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'), img = ctx.createImageData(size, size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      const n2 = samp(A, cells, u, v) * 0.74 + samp(B, cells * 4, u, v) * 0.26;
      const b = Math.round((1 - amp + amp * n2) * 255);
      const k = (j * size + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = b; img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;                       // the ground is seen at a grazing angle constantly
  return t;
}
// 190 m of world per tile: big enough that the pattern never reads as a repeating grid
// from the air, small enough that a low pass has something to move against.
const GROUND_UV = 190;
const GROUND_TEX = groundGrain(256, 6, 0.17);
const terrainMat = new THREE.MeshToonMaterial({
  vertexColors: true, gradientMap: RAMP, map: GROUND_TEX });
// The map view is the same geometry seen from 32 km up, where a 190 m tile is a few
// pixels across and would boil. It gets the same material without the detail.
const mapMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: RAMP });

// Colour by biome weight and height, so the whole world is one material and the
// palette shifts continuously wherever the weights do.
function terrainColor(h, slope, land, wPl, wAr, wMtn, rw, cw, patch, out) {
  out.copy(C_GRASS).lerp(C_GRASS2, patch);
  if (wAr > 0.001) out.lerp(_ca.copy(C_DUNE).lerp(C_DUNE2, patch * 0.8), wAr);
  _cb.copy(C_ROCK).lerp(C_ROCK2, patch);
  // Sedimentary banding. Real strata are level, so this keys off height alone and gets
  // its phase nudged by `patch` — otherwise every mountain in the world would band on
  // exactly the same contours and the whole range would read as one object. About 37 m
  // of height per band, and only ±9% of brightness: enough to give a 600 m face some
  // structure, not enough to turn grey rock into stripes.
  //
  // Applied to _cb only, which is the bare-rock colour used by the mountain body and by
  // the steep-ground override below. Grass, sand and snow never see it.
  _cb.multiplyScalar(0.91 + 0.09 * Math.sin(h * 0.17 + patch * 5.0));
  if (wMtn > 0.001) out.lerp(_cb, wMtn * smoothstep(40, 150, h));
  // snow line, softened by slope: snow does not sit on a cliff face
  out.lerp(C_SNOW, smoothstep(430, 620, h) * smoothstep(0.55, 0.8, slope));
  // a sand band just above the water, and a pale bed just below it
  out.lerp(C_SAND, 1 - smoothstep(1.5, 10, h));
  if (h < 0) out.lerp(C_BED, smoothstep(0, -16, h));
  // steep ground is bare rock whatever the biome says — this is what puts cliffs in
  // the plains and keeps grass off the mountain faces
  out.lerp(_cb, smoothstep(0.62, 0.34, slope) * land);
  // developed ground: scrubbed-out grey-green under the streets, so the city reads as
  // a place from the air even before its buildings resolve out of the fog
  if (cw > 0) out.lerp(C_URBAN, smoothstep(0.15, 0.75, cw) * 0.8);
  if (rw > 0) out.lerp(C_TARMAC, smoothstep(0.6, 0.96, rw));
}

const chunks = new Map();                 // key -> { mesh, lastSeen }
const pending = [];                       // keys queued for build
const terrainGroup = new THREE.Group(); scene.add(terrainGroup);
let frameNo = 0;

// Even start, even length — see the nesting note above. The start is rounded to the
// NEAREST even index, not floored to one: flooring biases every level's coverage
// backward by up to a whole chunk, and at the outermost level that let the terrain
// end exactly at the aircraft. Measured at 0 m of forward coverage in the worst case,
// which is a hole you fly straight out of.
function interval(p, S) {
  const lo = 2 * Math.round((Math.floor(p / S) - RING) / 2);
  return [lo, lo + 2 * RING - 1];
}

function buildChunk(L, cx, cz) {
  const { size, res } = LEVELS[L];
  const q = size / res;
  const n = res + 1;                      // surface vertices per axis
  const m = n + 2;                        // with a one-quad margin
  const x0 = cx * size, z0 = cz * size;

  // One pass over a margined grid. The margin exists so that the central-difference
  // normal is correct for the border vertices too — without it the seam between two
  // chunks of the same level lights differently on each side and you can see the grid.
  const H = new Float32Array(m * m);
  const WL = new Float32Array(m * m), WA = new Float32Array(m * m),
        WM = new Float32Array(m * m), WR = new Float32Array(m * m), WC = new Float32Array(m * m);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const k = j * m + i;
      H[k] = terrainH(x0 + (i - 1) * q, z0 + (j - 1) * q, SMP);
      WL[k] = SMP.land; WA[k] = SMP.wAr; WM[k] = SMP.wMtn; WR[k] = SMP.rw; WC[k] = SMP.cw;
    }
  }

  const NV = n * n, BL = 4 * (n - 1), TOT = NV + BL;
  const pos = new Float32Array(TOT * 3), nor = new Float32Array(TOT * 3), col = new Float32Array(TOT * 3);
  const c3 = new THREE.Color();
  let lo = Infinity, hi = -Infinity;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const mi = (j + 1) * m + (i + 1);
      const y = H[mi];
      if (y < lo) lo = y; if (y > hi) hi = y;
      const k = (j * n + i) * 3;
      pos[k] = x0 + i * q; pos[k + 1] = y; pos[k + 2] = z0 + j * q;
      let nx = H[mi - 1] - H[mi + 1], ny = 2 * q, nz = H[mi - m] - H[mi + m];
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
      // a cheap high-frequency patchiness so a big flat field is not one flat colour
      const patch = vnoise(pos[k] * 0.021, pos[k + 2] * 0.021);
      const wa = WA[mi], wm = WM[mi];
      terrainColor(y, ny, WL[mi], 1 - wa - wm, wa, wm, WR[mi], WC[mi], patch, c3);
      col[k] = c3.r; col[k + 1] = c3.g; col[k + 2] = c3.b;
    }
  }

  // the border walked as one closed loop, so the skirt seals the corners too
  const loop = new Int32Array(BL);
  let li = 0;
  for (let i = 0; i < n - 1; i++) loop[li++] = i;
  for (let j = 0; j < n - 1; j++) loop[li++] = j * n + (n - 1);
  for (let i = n - 1; i > 0; i--) loop[li++] = (n - 1) * n + i;
  for (let j = n - 1; j > 0; j--) loop[li++] = j * n;

  const drop = q * 1.5 + 6;
  for (let i = 0; i < BL; i++) {
    const src = loop[i] * 3, dst = (NV + i) * 3;
    pos[dst] = pos[src]; pos[dst + 1] = pos[src + 1] - drop; pos[dst + 2] = pos[src + 2];
    nor[dst] = nor[src]; nor[dst + 1] = nor[src + 1]; nor[dst + 2] = nor[src + 2];
    col[dst] = col[src]; col[dst + 1] = col[src + 1]; col[dst + 2] = col[src + 2];
  }

  const idx = new Uint32Array((n - 1) * (n - 1) * 6 + BL * 6);
  let t = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;   // wound so the front face is up
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  for (let i = 0; i < BL; i++) {
    const a = loop[i], b = loop[(i + 1) % BL], ap = NV + i, bp = NV + ((i + 1) % BL);
    idx[t++] = a; idx[t++] = b; idx[t++] = ap;   // outward-facing, see the loop winding
    idx[t++] = b; idx[t++] = bp; idx[t++] = ap;
  }

  // UVs straight off world position, so the ground cover is continuous across every
  // chunk boundary and across every LOD change — a chunk that swaps level keeps exactly
  // the same texture underneath it, which is what stops the swap being visible. Taken
  // from `pos` rather than recomputed so the skirt vertices get the same treatment.
  const uv = new Float32Array(TOT * 2);
  for (let i = 0; i < TOT; i++) {
    uv[i * 2] = pos[i * 3] / GROUND_UV;
    uv[i * 2 + 1] = pos[i * 3 + 2] / GROUND_UV;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  // Set by hand: computeBoundingSphere would walk 1,200 vertices for something the
  // chunk's own extent already tells us exactly.
  const cxw = x0 + size / 2, czw = z0 + size / 2, cyw = (lo + hi) / 2;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cxw, cyw, czw),
    Math.hypot(size * 0.7071, (hi - lo) / 2 + drop));

  const mesh = new THREE.Mesh(g, terrainMat);
  terrainGroup.add(mesh);
  return mesh;
}

// Work out which chunks should exist right now, queue the missing ones, and drop the
// ones that have been out of the plan for a while. The grace period matters: turning
// back across a ring boundary must not rebuild everything you just left.
function planChunks(px, pz) {
  pending.length = 0;
  let inner = null;
  for (let L = 0; L < LEVELS.length; L++) {
    const S = LEVELS[L].size;
    const ivX = interval(px, S), ivZ = interval(pz, S);
    for (let cx = ivX[0]; cx <= ivX[1]; cx++) {
      for (let cz = ivZ[0]; cz <= ivZ[1]; cz++) {
        if (inner && 2 * cx >= inner.x[0] && 2 * cx + 1 <= inner.x[1]
                  && 2 * cz >= inner.z[0] && 2 * cz + 1 <= inner.z[1]) continue;
        const key = L + ':' + cx + ':' + cz;
        const have = chunks.get(key);
        if (have) have.lastSeen = frameNo;
        else pending.push(key);
      }
    }
    inner = { x: ivX, z: ivZ };
  }
  for (const [key, c] of chunks) {
    if (frameNo - c.lastSeen < 240) continue;
    terrainGroup.remove(c.mesh); c.mesh.geometry.dispose(); chunks.delete(key);
  }
}

function pumpChunks(budgetMs) {
  const t0 = performance.now();
  while (pending.length) {
    const key = pending.shift();
    const [L, cx, cz] = key.split(':').map(Number);
    chunks.set(key, { mesh: buildChunk(L, cx, cz), lastSeen: frameNo });
    if (performance.now() - t0 > budgetMs) break;
  }
}

// =================================================================
//  SCENERY
//  Trees, rocks and cacti, scattered by biome. Not chunked like the terrain: a
//  deterministic lattice around the aircraft, rebuilt only when it has moved a cell.
//  Each cell hashes to its own occupancy, species and jitter, so the scatter is part
//  of the same fixed world — the same tree stands on the same hill every load — while
//  only ever costing three draw calls.
//
//  The species geometries bake their colours into a vertex attribute, so a tree's
//  brown trunk and green canopy live in ONE instanced mesh with one material.
// =================================================================
const SCEN_CELL = 40, SCEN_R = 1250, SCEN_NEAR = 520;
// Where the roads are, at 14 m resolution. The scatter can see strips and towns because
// those live in the height field, but a highway is only geometry — so without this it
// happily plants a wood straight down the middle of one. Keys are packed into a single
// integer: a Set of strings would mean tens of thousands of concatenations per rebuild.
const ROAD_CELL = 14;
const ROAD_CELLS = new Set();
const roadKey = (gx, gz) => (gx + 8192) * 16384 + (gz + 8192);
function markRoad(path, brush) {
  for (let i = 0; i < path.length - 1; i++) {
    const [x0, z0] = path[i], [x1, z1] = path[i + 1];
    const L = Math.hypot(x1 - x0, z1 - z0), steps = Math.max(1, Math.ceil(L / (ROAD_CELL * 0.5)));
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      const gx = Math.round((x0 + (x1 - x0) * f) / ROAD_CELL);
      const gz = Math.round((z0 + (z1 - z0) * f) / ROAD_CELL);
      for (let a = -brush; a <= brush; a++)
        for (let b = -brush; b <= brush; b++) ROAD_CELLS.add(roadKey(gx + a, gz + b));
    }
  }
}
// Same mask, a rectangle at a time. Landmarks use this to keep the scatter out of
// themselves: a wood growing up through the castle, or a line of pines straight across
// the speedway, reads as the landmark being broken rather than as trees.
function markRect(cx, cz, rx, rz) {
  const i0 = Math.round((cx - rx) / ROAD_CELL), i1 = Math.round((cx + rx) / ROAD_CELL);
  const j0 = Math.round((cz - rz) / ROAD_CELL), j1 = Math.round((cz + rz) / ROAD_CELL);
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) ROAD_CELLS.add(roadKey(i, j));
}
const onRoad = (x, z) => ROAD_CELLS.has(roadKey(Math.round(x / ROAD_CELL), Math.round(z / ROAD_CELL)));
// Every pool is sized for the worst case — every cell in range growing this one
// species — rather than for its typical share. A pool that runs out truncates in cell
// iteration order, which does not thin the scatter evenly: it wipes out whichever side
// of the aircraft is visited last, and you get a forest with a straight edge down it.
// Derived from the lattice rather than guessed: two guesses (380, then 520) were both
// under the real density in mountain country, where nearly every cell is rock. Capacity
// is nearly free — draw cost follows .count, which is set fresh on every scatter.
const SCEN_MAX = (() => {
  const n = Math.ceil(SCEN_R / SCEN_CELL);
  let c = 0;
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) if (i * i + j * j <= n * n) c++;
  return c;
})();
function tinted(geo, hex) {
  const c = new THREE.Color(hex), n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
const CYL = (rt, rb, h, s) => new THREE.CylinderGeometry(rt, rb, h, s);
const scenMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: RAMP });

const SPECIES = [
  { // 0 — conifer, three tiers so the silhouette has some structure
    geo: merge([tinted(baked(CYL(0.3, 0.46, 3.6, 5), 0, 1.8, 0), 0x6b4a2f),
                tinted(baked(new THREE.ConeGeometry(2.3, 4.2, 7), 0, 4.5, 0), 0x36702f),
                tinted(baked(new THREE.ConeGeometry(1.8, 3.4, 7), 0, 6.6, 0), 0x3f7d3a),
                tinted(baked(new THREE.ConeGeometry(1.15, 2.4, 6), 0, 8.6, 0), 0x4f9440)]),
    tall: true,
  },
  { // 1 — boulder, two lumps so it does not read as a single die
    geo: merge([tinted(new THREE.DodecahedronGeometry(1.6, 0), 0x8d8f99),
                tinted(baked(new THREE.DodecahedronGeometry(0.9, 0), 1.5, -0.4, 0.7), 0x7a7d87)]),
    tall: true,
  },
  { // 2 — saguaro
    geo: merge([tinted(baked(CYL(0.55, 0.65, 5.2, 6), 0, 2.6, 0), 0x4f8a52),
                tinted(baked(CYL(0.32, 0.32, 2.2, 5), -0.95, 3.4, 0, 0, 0, Math.PI / 2.6), 0x4f8a52),
                tinted(baked(CYL(0.32, 0.32, 1.7, 5), 0.9, 4.1, 0, 0, 0, -Math.PI / 2.6), 0x4f8a52)]),
    tall: true,
  },
  { // 3 — broadleaf, a trunk under a clump of overlapping crowns
    geo: merge([tinted(baked(CYL(0.36, 0.5, 3.2, 5), 0, 1.6, 0), 0x6f5033),
                tinted(baked(new THREE.IcosahedronGeometry(2.4, 0), 0, 4.6, 0), 0x4e8f3a),
                tinted(baked(new THREE.IcosahedronGeometry(1.7, 0), 1.6, 4.0, 0.9), 0x5da045),
                tinted(baked(new THREE.IcosahedronGeometry(1.5, 0), -1.5, 4.3, -0.8), 0x44822f)]),
    tall: true,
  },
  { // 4 — shrub, near ground only. Small enough that it never needs to draw far out.
    geo: merge([tinted(baked(new THREE.IcosahedronGeometry(1.0, 0), 0, 0.7, 0), 0x5b8f42),
                tinted(baked(new THREE.IcosahedronGeometry(0.75, 0), 0.9, 0.5, 0.4), 0x6a9d4d)]),
    tall: false,
  },
  { // 5 — dead desert scrub
    geo: merge([tinted(baked(CYL(0.12, 0.22, 2.6, 4), 0, 1.3, 0), 0x8a7355),
                tinted(baked(CYL(0.1, 0.1, 1.5, 4), 0.5, 2.1, 0, 0, 0, -0.8), 0x8a7355),
                tinted(baked(CYL(0.1, 0.1, 1.2, 4), -0.45, 2.3, 0.2, 0, 0, 0.9), 0x8a7355)]),
    tall: false,
  },
  { // 6 — old-growth conifer. Half again as tall as the ordinary one and darker, so the
    // deep wood has a canopy above the canopy instead of being one height everywhere.
    geo: merge([tinted(baked(CYL(0.5, 0.78, 6.4, 6), 0, 3.2, 0), 0x5a3f28),
                tinted(baked(new THREE.ConeGeometry(3.4, 6.4, 8), 0, 7.4, 0), 0x24551f),
                tinted(baked(new THREE.ConeGeometry(2.7, 5.2, 8), 0, 10.8, 0), 0x2b6326),
                tinted(baked(new THREE.ConeGeometry(1.7, 3.6, 7), 0, 14.0, 0), 0x36702f)]),
    tall: true, pool: 2, big: 1.35,
  },
  { // 7 — old-growth broadleaf, a wide spreading crown rather than a taller cone
    geo: merge([tinted(baked(CYL(0.62, 0.95, 5.0, 6), 0, 2.5, 0), 0x5d4229),
                tinted(baked(new THREE.IcosahedronGeometry(4.2, 0), 0, 7.6, 0), 0x3d7a2c),
                tinted(baked(new THREE.IcosahedronGeometry(3.0, 0), 3.0, 6.6, 1.5), 0x4b8c36),
                tinted(baked(new THREE.IcosahedronGeometry(2.6, 0), -2.7, 7.0, -1.4), 0x356d26),
                tinted(baked(new THREE.IcosahedronGeometry(2.2, 0), 0.6, 9.6, -2.4), 0x4e9440)]),
    tall: true, pool: 2, big: 1.25,
  },
  { // 8 — desert: a weathered red sandstone outcrop. The desert was two species and read
    // as the emptiest biome in the world; this is the one that gives it a horizon line.
    geo: merge([tinted(new THREE.DodecahedronGeometry(2.6, 0), 0xa8663f),
                tinted(baked(new THREE.DodecahedronGeometry(1.7, 0), 2.4, -0.5, 0.9), 0x94583a),
                tinted(baked(new THREE.DodecahedronGeometry(1.15, 0), -2.0, -0.7, -1.1), 0xb87548)]),
    tall: true, pool: 3, big: 1.15,
  },
  { // 9 — ocotillo: a spray of bare whippy canes, nothing like the saguaro's silhouette
    geo: (() => {
      const arms = [];
      for (let i = 0; i < 7; i++) {
        const a = i / 7 * 6.283185;
        arms.push(tinted(baked(CYL(0.07, 0.16, 3.4 + (i % 3) * 0.8, 4),
          Math.cos(a) * 0.5, 1.7 + (i % 3) * 0.4, Math.sin(a) * 0.5,
          Math.sin(a) * 0.34, 0, -Math.cos(a) * 0.34), 0x6f7d46));
      }
      return merge(arms);
    })(),
    tall: false,
  },
];
// The old-growth pools are deliberately small: they only ever plant in the heaviest part
// of the forest field, and sizing them like the common species would be tens of thousands
// of matrices reserved for trees that are never there.
for (const sp of SPECIES) sp.max = sp.tall ? SCEN_MAX * (sp.pool || 6) : SCEN_MAX;
for (const s of SPECIES) {
  s.mesh = new THREE.InstancedMesh(s.geo, scenMat, s.max);
  s.mesh.frustumCulled = false; s.mesh.count = 0;
  scene.add(s.mesh);
}

let scenCX = 1e9, scenCZ = 1e9;
const SC = { land: 0, wPl: 0, wAr: 0, wMtn: 0, rw: 0, cw: 0 };

// The rebuild is spread over several frames against a millisecond budget. A full pass
// is ~25 ms of height sampling and matrix composition, and the aircraft crosses a cell
// every 0.7 s at cruise — done in one go that is a dropped frame twice a second, which
// you feel as a steady stutter.
//
// New instances are written straight into the live buffer while the old `count` still
// stands, so a half-finished pass simply shows a scatter that is part old and part new.
// The two differ by the 40 m the aircraft has moved, so there is nothing to see.
let scat = null;
function refreshScenery(px, pz, budgetMs) {
  const cx = Math.round(px / SCEN_CELL), cz = Math.round(pz / SCEN_CELL);
  if (!scat && cx === scenCX && cz === scenCZ) return;   // same cell, nothing moved
  const n = Math.ceil(SCEN_R / SCEN_CELL);
  // One slot per species. This was hard-coded to three when there were three, and
  // adding broadleaf, shrub and scrub silently left them with an undefined count —
  // every comparison against it was false and every increment produced NaN, so those
  // three were scattered into nothing for as long as they have existed.
  if (!scat || scat.cx !== cx || scat.cz !== cz)
    scat = { cx, cz, i: -n, counts: new Array(SPECIES.length).fill(0) };
  const counts = scat.counts;
  const t0 = performance.now();
  for (; scat.i <= n; scat.i++) {
    const i = scat.i;
    if (budgetMs && scat.i > -n && performance.now() - t0 > budgetMs) return;
    for (let j = -n; j <= n; j++) {
      const dist2 = (i * i + j * j) * SCEN_CELL * SCEN_CELL;
      if (i * i + j * j > n * n) continue;          // circle, so it does not pop in at the corners
      const gx = cx + i, gz = cz + j;
      const r = hash2i(gx * 7919, gz * 104729);     // one draw decides everything about this cell
      // Forest density: inside a wood nearly every cell is taken and carries several
      // trees; outside it the old sparse scatter is unchanged.
      const fw = smoothstep(0.46, 0.62, forestF(gx * SCEN_CELL, gz * SCEN_CELL));
      if (r > lerp(0.55, 0.995, fw)) continue;
      const x = (gx + (hash2i(gx, gz + 4001) - 0.5) * 0.9) * SCEN_CELL;
      const z = (gz + (hash2i(gx + 4001, gz) - 0.5) * 0.9) * SCEN_CELL;
      const y = terrainH(x, z, SC);
      if (y < 2.5 || SC.rw > 0.02 || SC.cw > 0.30) continue;   // not on the beach, never on a strip or in town
      // slope from a two-sample difference — trees do not grow on a cliff face
      // The two samples that measure slope also give the local gradient, which places
      // every other stem in the cell for free. Nine trees used to mean nine height
      // lookups and a 40 ms hitch every time the aircraft crossed a cell boundary —
      // about twice a second at cruise. Woods sit on gentle ground by construction, so
      // a linear fit across 40 m is well under a metre out.
      const e = 9;
      const hxe = terrainH(x + e, z), hze = terrainH(x, z + e);
      const dhx = (hxe - y) / e, dhz = (hze - y) / e;
      const slope = Math.hypot(hxe - y, hze - y) / e;
      // Species by biome, then by a per-cell draw so a wood is mixed rather than a
      // plantation of one clone.
      const pick = hash2i(gx + 909, gz - 909);
      let sp;
      if (slope > 0.5 || SC.wMtn > 0.55 || y > 430) sp = 1;                      // rock
      else if (SC.wAr > 0.45) {
        // Four species now, not two. The outcrop is rare and only on the drier, flatter
        // ground — a boulder field every fifty metres would read as gravel, not desert.
        const dry = hash2i(gx + 611, gz - 611);
        sp = dry > 0.90 ? 8 : pick < 0.38 ? 2 : pick < 0.62 ? 9 : 5;
      }
      else if (SC.wPl > 0.35 && y < 430) {
        // Only the heaviest part of the forest field grows old. Its own hash, not `pick`,
        // or the choice of species and the choice of age would be the same coin.
        const age = hash2i(gx - 1301, gz + 1301);
        sp = (fw > 0.86 && age > 0.62) ? (age < 0.86 ? 6 : 7)
           : pick < 0.42 ? 0 : pick < 0.78 ? 3 : 4;
      }
      else sp = pick < 0.7 ? 1 : 4;
      // Draw distance is per species, not global: the big silhouettes carry to the far
      // ring while shrubs stop early. Same lattice and same hash either way, so nothing
      // moves as you approach — the small stuff simply appears, sub-pixel, and no pop.
      if (!SPECIES[sp].tall && dist2 > SCEN_NEAR * SCEN_NEAR) continue;
      const pool = SPECIES[sp];
      // A forest cell plants a small stand rather than a single specimen. Each stem
      // still samples the ground for itself — sharing one height across a 40 m cell
      // leaves trees hanging in the air on any slope.
      const isWood = fw > 0.15 && (sp === 0 || sp === 3 || sp === 6 || sp === 7);
      // Deep forest packs a cell properly rather than dotting it. Every extra stem
      // costs its own height sample — sharing one across a 40 m cell hangs trees in
      // mid-air on a slope — so this is the single most expensive knob in the scatter,
      // and it is why the pools below are sized in multiples of the cell count.
      const stems = isWood ? 1 + Math.round(fw * 8) : 1;
      for (let k = 0; k < stems; k++) {
        if (counts[sp] >= pool.max) break;
        let tx = x, tz = z, ty = y;
        if (k > 0) {
          tx = x + (hash2i(gx * 31 + k, gz * 17) - 0.5) * SCEN_CELL * 0.9;
          tz = z + (hash2i(gx * 17, gz * 31 + k) - 0.5) * SCEN_CELL * 0.9;
          ty = y + dhx * (tx - x) + dhz * (tz - z);
          if (ty < 2.5) continue;
        }
        if (onRoad(tx, tz)) continue;
        const sc = (0.7 + hash2i(gx + 77 + k * 13, gz + 77) * (sp === 1 ? 1.4 : 0.7))
                 * (pool.big || 1);
        dummy.position.set(tx, ty - 0.3, tz);
        dummy.rotation.set(0, hash2i(gx - 31 + k, gz + 31) * 6.283, 0);
        dummy.scale.set(sc, sc * (0.8 + hash2i(gx + k, gz) * 0.5), sc);
        dummy.updateMatrix();
        pool.mesh.setMatrixAt(counts[sp]++, dummy.matrix);
      }
    }
  }
  for (let s = 0; s < SPECIES.length; s++) {
    SPECIES[s].mesh.count = counts[s];
    SPECIES[s].mesh.instanceMatrix.needsUpdate = true;
  }
  scenCX = cx; scenCZ = cz; scat = null;
}

// =================================================================
//  WATER
//  The toon water shader from the river, reused almost verbatim for the sea: four
//  summed sines over world xz, a finite-difference normal lit in hard bands, a
//  fresnel lift toward the sky and stepped cartoon glints.
//
//  One plane, big enough that it always outruns the fog, rather than one that follows
//  the camera — the waves are computed from world position, so a static sheet and a
//  following one look identical, and a static one cannot judder. transparent +
//  depthWrite:false keeps it invisible to the ink pass; depth *testing* still applies,
//  so terrain above sea level occludes it correctly.
// =================================================================
const waterMat = new THREE.ShaderMaterial({
  // fog stays OFF here even though the sea is fogged: this is a raw ShaderMaterial,
  // so three's fog uniforms are not in it, and setting the flag makes the renderer
  // reach for uniforms.fogColor and throw every frame. The fog is done by hand in the
  // fragment shader instead — see the bottom of main().
  transparent: true, depthWrite: false, fog: false,
  uniforms: {
    uTime: { value: 0 },
    uSun: { value: sunDir },
    uDeep: { value: new THREE.Color(0x2e6cb0) },
    uShallow: { value: new THREE.Color(0x58a4e0) },
    uSky: { value: new THREE.Color(0xcfe9ff) },
    uFogColor: { value: new THREE.Color(SKY_COLOR) },
    uFogNear: { value: worldFog.near }, uFogFar: { value: worldFog.far },
  },
  vertexShader: `
    varying vec3 vWorld;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: `
    uniform float uTime, uFogNear, uFogFar;
    uniform vec3 uSun, uDeep, uShallow, uSky, uFogColor;
    varying vec3 vWorld;
    float wave(vec2 p) {
      p.x -= uTime * 2.0;                    // the whole field drifts
      return sin(p.x*0.23 + uTime*0.9) * 1.4
           + sin(p.x*0.11 - p.y*0.19 + uTime*0.6) * 1.8
           + sin(p.y*0.31 + uTime*1.4) * 1.0
           + sin((p.x+p.y)*0.53 - uTime*1.9) * 0.7;
    }
    void main() {
      vec2 p = vWorld.xz * 1.4;
      float e = 0.7;
      float h0 = wave(p);
      // deliberately over-steep normals: a physically-sized ripple quantizes to one
      // flat toon band and the sea reads as paint again
      vec3 n = normalize(vec3(h0 - wave(p + vec2(e, 0.0)), 1.6, h0 - wave(p + vec2(0.0, e))));
      float d = max(dot(n, normalize(uSun)), 0.0);
      float band = floor(clamp((d - 0.35) * 1.6, 0.0, 0.999) * 3.0) / 2.0;
      vec3 col = mix(uDeep, uShallow, band);
      vec3 view = normalize(cameraPosition - vWorld);
      float fres = pow(1.0 - max(view.y, 0.0), 2.0);
      col = mix(col, uSky, fres * 0.5);
      float spec = pow(max(dot(n, normalize(normalize(uSun) + view)), 0.0), 30.0);
      col = mix(col, vec3(1.0), step(0.6, spec) * 0.7);   // hard-edged cartoon glints
      // White water on the tops of the biggest waves only. wave() runs to about +-4.9,
      // so this takes roughly the top fifth and leaves the rest of the sea alone —
      // whitecaps everywhere would read as static rather than as sea.
      col = mix(col, vec3(1.0), step(2.9, h0) * 0.42);
      // The glitter track: a much tighter highlight than the one above, broken up by a
      // fine fast ripple so it twinkles instead of sitting there as a smear. Stepped,
      // not smoothed, because everything else in this world has a hard edge.
      // Frequency matters more than amplitude here. At 1.7 m per cycle this read as a
      // uniform stipple over the whole sea — the same speckle trap the ground texture
      // avoids, because anything finer than a few metres is sub-pixel at range and turns
      // into noise. About 20 m per cycle instead, so a glint is a glint.
      float fine = sin(p.x * 0.31 + uTime * 2.2) * sin(p.y * 0.27 - uTime * 1.7);
      float glint = pow(max(dot(n, normalize(normalize(uSun) + view)), 0.0), 90.0);
      col = mix(col, vec3(1.0), step(0.62, glint * (0.5 + 0.5 * fine)) * 0.9);
      // fog by hand: this is a raw ShaderMaterial, so three's fog chunks are not in it,
      // and an unfogged sea against a fogged coast puts a hard blue line on the horizon
      float f = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorld));
      gl_FragColor = vec4(mix(col, uFogColor, f), 0.88);
    }`,
});
{
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), waterMat);
  sea.position.y = SEA_Y; sea.renderOrder = 1; sea.frustumCulled = false;
  scene.add(sea);
}

// =================================================================
//  THE AIRFIELDS
//  The ground under each is already flat — terrainH did that. All that is left is the
//  paint. Everything sits a little proud of the surface and uses polygonOffset: at a
//  12 km far plane a 2 cm gap is not enough to beat depth quantisation.
// =================================================================
// A tiling grain, in the spirit of ~/driver's noiseCanvas(). Deliberately shallow: the
// art holds together because everything is flat colour, so this has to read as surface
// texture at fifty feet and be invisible at five hundred, not as a photograph. The whole
// range sits between 0.86 and 1.0 of the underlying colour, which is a multiply of at
// most 14% — enough to break up a big flat face, not enough to change what colour it is.
function grainTex(size, cell, lo) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const n = size / cell;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // hash2i on the wrapped neighbour keeps the tile seamless across its own edge
      const v = lo + (1 - lo) * hash2i(i % n, j % n);
      const b = Math.round(v * 255);
      g.fillStyle = `rgb(${b},${b},${b})`;
      g.fillRect(i * cell, j * cell, cell, cell);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
const TARMAC_GRAIN = grainTex(64, 4, 0.86);      // coarse chippings
const WALL_GRAIN = grainTex(64, 8, 0.90);        // gentler, so a wall stays a wall

const paint = (color) => {
  const m = toon(color).clone();
  m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4;
  m.map = TARMAC_GRAIN;
  return m;
};
function buildStrip(s) {
  const g = new THREE.Group();
  g.position.set(s.x, s.y, s.z); g.rotation.y = s.hdg; scene.add(g);
  const L = s.halfLen * 2;
  // the surface itself: a slightly crisper slab over ground the height field has
  // already levelled, so this is really just a clean edge for it
  const slab = new THREE.Mesh(BOX(s.hw * 2, 0.3, L), paint(s.surf));
  slab.position.y = 0.06; g.add(slab);

  const marks = [];
  for (let z = -s.halfLen + 26; z <= s.halfLen - 26; z += 34)
    marks.push(baked(BOX(1.6, 0.02, 14), 0, 0, z));
  for (const end of [-1, 1]) for (let k = -3; k <= 3; k++)
    marks.push(baked(BOX(2.4, 0.02, 9), k * 4.2, 0, end * (s.halfLen - 16)));
  const mm = new THREE.Mesh(merge(marks), paint(0xf0ede6));
  mm.position.y = 0.24; g.add(mm);

  // a windsock at the threshold, so you can find the field again from the air
  const pole = new THREE.Mesh(BOX(0.4, 7, 0.4), toon(0xd7dbe0));
  pole.position.set(s.hw + 8, 3.5, -s.halfLen + 40); g.add(pole);
  const sock = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.8, 12).rotateZ(-Math.PI / 2), toon(0xff7a2b));
  sock.position.set(s.hw + 9.8, 6.5, -s.halfLen + 40); g.add(sock);

  // A marker board at each threshold. Out-field strips are short and the same colour
  // as the ground they sit on, so from a mile out the orange is what you actually see.
  for (const end of [-1, 1]) {
    const b = new THREE.Mesh(BOX(3.2, 1.6, 0.4), toon(0xff7a2b));
    b.position.set(0, 1.6, end * (s.halfLen + 6)); g.add(b);
  }
}
for (const s of STRIPS) buildStrip(s);

// =================================================================
//  THE SETTLEMENTS
//  A street grid on the flat pad the height field already laid. Tier decides the whole
//  character: a city gets a downtown of towers falling off to sprawl, a town gets four
//  storeys, a village gets cottages round a green.
//
//  Everything is placed against the height field rather than against the grid, so each
//  place shapes itself to its pad — blocks stop where the ground stops being flat,
//  which along a coast means the streets end at the water and the front comes out
//  ragged and believable instead of ruled off square.
//
//  Every settlement in the world shares ONE instanced draw call of boxes and ONE merged
//  mesh of streets, so seven of them cost exactly what one did.
// =================================================================
const TIER = [
  //          block  maxTop  lotHalf  gap   density floor
  { blk: 168, top: 178, lot: 42, gap: 0.82, densMin: 0.58, coreR: 1250 },   // city
  { blk: 124, top: 34,  lot: 30, gap: 0.80, densMin: 0.62, coreR: 520 },    // town
  { blk: 96,  top: 13,  lot: 23, gap: 0.72, densMin: 0.70, coreR: 200 },    // village
];
const PALETTE = [0xb9bfc8, 0xa8b0ba, 0xcdd2d8, 0x9aa4b0, 0xc6bcae, 0x8f99a6, 0xdad4c8];
const RUSTIC  = [0xd6c6a8, 0xc9b48f, 0xe0d6c0, 0xb9a888, 0xcdbfa2];
const TOWN_MAX_TOP = 190;
// Declared up here rather than beside cityHit: the race course siting calls cityHit while
// laying gates, which happens before that point in the file. A function declaration is
// hoisted but a const is not, so leaving it down there is a temporal-dead-zone throw.
const PLANE_R = 5;                     // wingtips count, not just the fuselage
const allLots = [], allRoad = [], roofLots = [];
const STREET_PATHS = [];        // drivable/walkable centrelines inside the towns

for (const t of TOWNS) {
  const T = TIER[t.tier], half = t.half, N = Math.floor(half / T.blk);
  const toWorld = (lx, lz) => [t.x + lx * t.cs + lz * t.sn, t.z - lx * t.sn + lz * t.cs];
  // is the pad still flat here? this is what clips a settlement to its shoreline
  const onPad = (lx, lz) => {
    const [wx, wz] = toWorld(lx, lz);
    return Math.abs(terrainH(wx, wz) - t.y) < 1.5;
  };
  t.boxes = []; t.grid = new Map(); t.blk = T.blk;

  for (let i = -N; i <= N; i++) {
    for (let j = -N; j <= N; j++) {
      const bx = i * T.blk, bz = j * T.blk;
      const r = Math.hypot(bx, bz);
      if (r > half * 0.86) continue;
      // Density thins toward the edge so a place has outskirts rather than a wall —
      // but not too far. An early pass floored it at 0.34 and clipped the streets a
      // block further out than the buildings, which left a wide apron of empty roads
      // that read as a demolished district, not a suburb.
      const dens = lerp(1.0, T.densMin, smoothstep(half * 0.3, half * 0.86, r));
      if (hash2i(i * 8191 + 13 + t.x, j * 131071 - 7 + t.z) > dens) continue;
      const isPark = hash2i(i * 26597 + t.z, j * 51749 + t.x) > (t.tier === 2 ? 0.86 : 0.93);
      // a squared falloff from the middle gives a proper centre rather than a uniform slab
      const core = 1 - smoothstep(T.blk, T.coreR, r);
      const hMax = lerp(t.tier === 0 ? 16 : 7, T.top, core * core);

      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const lx = bx + ox * T.lot, lz = bz + oz * T.lot;
        if (hash2i(lx | 0, lz | 0) > T.gap) continue;          // a gap in the block
        if (!onPad(lx, lz)) continue;                          // off the pad / in the sea
        const w = T.lot * 0.55 + hash2i(lx + 5, lz - 5) * T.lot * 0.62;
        const d = T.lot * 0.55 + hash2i(lx - 9, lz + 9) * T.lot * 0.62;
        const [wx, wz] = toWorld(lx, lz);
        if (isPark) { allLots.push({ wx, wz, y: t.y, w: w * 1.5, d: d * 1.5, h: 0.5, hdg: t.hdg, park: true }); continue; }
        const hgt = (t.tier === 0 ? 8 : 5) + hash2i(lx + 77, lz + 77) ** 1.7 * hMax;
        const pal = t.tier === 0 ? PALETTE : RUSTIC;
        allLots.push({ wx, wz, y: t.y, w, d, h: hgt, hdg: t.hdg, park: false, pal });
        // ---- the detail pass: what actually reads on a low pass ----
        const r1 = hash2i(lx + 313, lz - 313);
        if (hgt > 55) {
          // a tall block steps in as it rises, which is most of what makes a skyline
          // look like a skyline rather than a bar chart
          allLots.push({ wx, wz, y: t.y + hgt, w: w * 0.66, d: d * 0.66,
                         h: hgt * (0.18 + r1 * 0.26), hdg: t.hdg, park: false, pal });
          if (r1 > 0.62)                                   // and a mast on some of them
            allLots.push({ wx, wz, y: t.y + hgt * 1.25, w: 1.1, d: 1.1,
                           h: 10 + r1 * 16, hdg: t.hdg, park: false, pal: [0x6e737b] });
        } else if (hgt > 16 && r1 > 0.45) {
          // rooftop plant on the mid-rise: tanks, lift housings, air handlers
          allLots.push({ wx: wx + (r1 - 0.5) * w * 0.5, wz: wz + (r1 - 0.5) * d * 0.5,
                         y: t.y + hgt, w: w * 0.3, d: d * 0.3, h: 2 + r1 * 3,
                         hdg: t.hdg, park: false, pal: [0x8b9099] });
        } else if (hgt <= 16) {
          // low-rise gets a pitched roof — the single biggest thing that stops a village
          // reading as a heap of grey boxes
          roofLots.push({ wx, wz, y: t.y + hgt, w: w * 1.06, d: d * 1.06,
                          h: 2.2 + hash2i(lx - 41, lz + 41) * 3.4, hdg: t.hdg });
        }
        const idx = t.boxes.push({ lx, lz, hw: w / 2, hd: d / 2, top: t.y + hgt }) - 1;
        const key = Math.floor(lx / T.blk) + ':' + Math.floor(lz / T.blk);
        if (!t.grid.has(key)) t.grid.set(key, []);
        t.grid.get(key).push(idx);
      }
    }
  }

  // Streets, cut into short pieces so a run that leaves the pad simply stops there.
  const SEG = Math.min(84, T.blk * 0.6);
  // The street is laid as short pieces, but traffic needs to know where a street RUNS —
  // so contiguous on-pad stretches are also recorded as a polyline to drive along.
  const addRun = (fixed, w, horiz) => {
    let run = null;
    const endRun = () => { if (run && run.length > 1) STREET_PATHS.push(run); run = null; };
    for (let u = -half; u < half; u += SEG) {
      const mid = u + SEG / 2;
      const lx = horiz ? mid : fixed, lz = horiz ? fixed : mid;
      if (Math.hypot(lx, lz) > half * 0.88 || !onPad(lx, lz)) { endRun(); continue; }
      const [wx, wz] = toWorld(lx, lz);
      allRoad.push(baked(BOX(horiz ? SEG : w, 0.02, horiz ? w : SEG), 0, 0, 0)
        // +hdg, matching toWorld. It was -hdg, which is invisible at 0° and 90° (a
        // rectangle is the same rotated 180°) and shears every other town off its own
        // street grid — the five 120° towns had most of their traffic on the grass.
        .rotateY(t.hdg).translate(wx, t.y + 0.12, wz));
      if (!run) run = [];
      run.push([wx, wz]);
    }
    endRun();
  };
  for (let i = -N; i <= N; i++) {
    const w = (t.tier === 0 && i % 5 === 0) ? 26 : t.tier === 2 ? 9 : 13;
    addRun(i * T.blk - T.blk / 2, w, true);
    addRun(i * T.blk - T.blk / 2, w, false);
  }
}

// Roofs get their own instanced mesh because they are their own shape: a unit box with
// the top face pinched into a ridge, so one geometry serves every cottage in the world.
if (roofLots.length) {
  const rg = BOX(1, 1, 1).toNonIndexed();
  const pa = rg.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    if (pa.getY(i) > 0) pa.setX(i, 0);               // collapse the top edge to a ridge
  }
  rg.computeVertexNormals();
  const rmesh = new THREE.InstancedMesh(rg,
    new THREE.MeshToonMaterial({ gradientMap: RAMP }), roofLots.length);
  rmesh.frustumCulled = false;
  const ROOFS = [0x9c4b3a, 0x7d5a46, 0xb2604a, 0x6b6f76, 0x8a4a3c];
  const rc = new THREE.Color();
  roofLots.forEach((L, n) => {
    dummy.position.set(L.wx, L.y + L.h / 2, L.wz);
    dummy.rotation.set(0, L.hdg, 0);
    dummy.scale.set(L.w, L.h, L.d);
    dummy.updateMatrix();
    rmesh.setMatrixAt(n, dummy.matrix);
    rc.set(ROOFS[(hash2i(L.wx | 0, L.wz | 0) * ROOFS.length) | 0]);
    rmesh.setColorAt(n, rc);
  });
  rmesh.instanceMatrix.needsUpdate = true;
  if (rmesh.instanceColor) rmesh.instanceColor.needsUpdate = true;
  scene.add(rmesh);
}

if (allLots.length) {
  const mesh = new THREE.InstancedMesh(BOX(1, 1, 1),
    new THREE.MeshToonMaterial({ gradientMap: RAMP, map: WALL_GRAIN }), allLots.length);
  mesh.frustumCulled = false;
  const col = new THREE.Color();
  allLots.forEach((L, n) => {
    dummy.position.set(L.wx, L.y + L.h / 2, L.wz);
    // +hdg, so the massing sits square on the lattice toWorld laid it out on — and
    // square with the collision boxes, which were always in the correct local frame.
    dummy.rotation.set(0, L.hdg, 0);
    dummy.scale.set(L.w, L.h, L.d);
    dummy.updateMatrix();
    mesh.setMatrixAt(n, dummy.matrix);
    col.set(L.park ? 0x5f9c4a : L.pal[(hash2i(L.wx | 0, L.wz | 0) * L.pal.length) | 0]);
    mesh.setColorAt(n, col);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
}
console.log(`settlements: ${TOWNS.length} places, ${allLots.length} massing boxes, ${roofLots.length} roofs, ${allRoad.length} street segments`);

// Landmark registries. Declared up here rather than with the landmarks themselves
// because the bridge, which the road network builds, is one of them.
const LANDMARKS = [];
const spinners = [];                    // rotors, updated per frame
const LM_HIT = [];                      // {x,z,r,top} cylinders you can fly into
// Boxes, for the things you are meant to fly UNDER. A cylinder cannot express "solid
// deck, open water beneath"; this can. Oriented in the XZ plane, bounded in Y.
const LM_BOX = [];                      // {x,z,sn,cs,hw,hd,y0,y1}
let lmMasked = 0;                       // how many landmarks got a scatter exclusion

// =================================================================
//  THE ROAD NETWORK
//  Roads between the settlements, routed by A* over a coarse grid of the height field
//  rather than drawn as straight lines. The cost of entering a cell is its distance
//  times a steep penalty on gradient, so a road would far rather go two miles round a
//  hill than a quarter mile over it — which is exactly what real roads do, and it is
//  what makes them read as roads from the air instead of as pencil lines.
//
//  Water is impassable, so island settlements simply end up with no road, and the
//  runways are expensive to cross so a road does not run down a live strip.
// =================================================================
const RG = 250;                                  // routing grid pitch, metres
// Only genuinely submerged ground is impassable. A hard 5 m wall here stranded any
// town sited on the coast — CALDER sits at 6 m — and two of the seven links silently
// failed to route. Low ground is expensive instead, which keeps roads up off the beach
// without cutting seaside towns out of the network.
const ROAD_MIN_Y = 1.2, ROAD_LOW_Y = 6;
const RGN = Math.floor((WORLD * 2) / RG) + 1;    // nodes per axis
const roadPaths = [];
let BRIDGE = null;                               // the one water crossing, see below
{
  const H = new Float32Array(RGN * RGN);
  const STRIPPEN = new Float32Array(RGN * RGN);
  const SHORE = new Uint8Array(RGN * RGN);
  const BRIDGEMASK = new Uint8Array(RGN * RGN);   // cells the bridge makes passable
  const nx = i => -WORLD + i * RG;
  // How far is this from the nearest runway *rectangle*? Reading SMP.rw at the grid
  // nodes could not do this job: a strip is 30-48 m wide and the grid is 250 m, so the
  // sample almost always lands beside the tarmac and the penalty fired on nothing. An
  // exact distance does not care what the grid pitch is, and a band one and a half
  // cells wide is one that a single step — even a diagonal — cannot hop over.
  const STRIP_BAND = RG * 1.5;
  function stripNear(x, z) {
    let best = Infinity;
    for (const s of STRIPS) {
      const dx = x - s.x, dz = z - s.z;
      const lz = dx * s.sn + dz * s.cs, lx = dx * s.cs - dz * s.sn;
      const ox = Math.max(0, Math.abs(lx) - s.hw), oz = Math.max(0, Math.abs(lz) - s.halfLen);
      const d = Math.hypot(ox, oz);
      if (d < best) best = d;
    }
    return best;
  }
  for (let j = 0; j < RGN; j++) {
    for (let i = 0; i < RGN; i++) {
      const k = j * RGN + i;
      H[k] = terrainH(nx(i), nx(j), SMP);
      // graded, not a wall: the road still has to be able to reach the airfield
      STRIPPEN[k] = Math.max(0, 1 - stripNear(nx(i), nx(j)) / STRIP_BAND);
    }
  }
  for (let j = 1; j < RGN - 1; j++)
    for (let i = 1; i < RGN - 1; i++) {
      const k = j * RGN + i;
      if (H[k] < ROAD_MIN_Y) continue;
      SHORE[k] = (H[k - 1] < ROAD_LOW_Y || H[k + 1] < ROAD_LOW_Y ||
                  H[k - RGN] < ROAD_LOW_Y || H[k + RGN] < ROAD_LOW_Y) ? 1 : 0;
    }

  // Which landmass is each node on? A* with a linear-scan open set is fine when it
  // succeeds, but a route that CANNOT succeed explores the entire grid before giving
  // up — and with an island airfield in the world that case is guaranteed. One flood
  // fill up front turns every impossible route into an O(1) rejection.
  const COMP = new Int32Array(RGN * RGN).fill(-1);
  {
    const stack = [];
    let comp = 0;
    for (let start = 0; start < COMP.length; start++) {
      if (COMP[start] !== -1 || H[start] < ROAD_MIN_Y) continue;
      COMP[start] = comp; stack.push(start);
      while (stack.length) {
        const k = stack.pop(), ki = k % RGN, kj = (k / RGN) | 0;
        for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const ni = ki + di, nj = kj + dj;
          if (ni < 0 || nj < 0 || ni >= RGN || nj >= RGN) continue;
          const nk = nj * RGN + ni;
          if (COMP[nk] !== -1 || H[nk] < ROAD_MIN_Y) continue;
          COMP[nk] = comp; stack.push(nk);
        }
      }
      comp++;
    }
  }
  const compAt = (x, z) => {
    const i = clamp(Math.round((x + WORLD) / RG), 0, RGN - 1);
    const j = clamp(Math.round((z + WORLD) / RG), 0, RGN - 1);
    return COMP[j * RGN + i];
  };

  // ---- THE BRIDGE -------------------------------------------------------------
  // A bridge is worth building where the water is narrow but going round it is long.
  //
  // The first attempt looked for a strait between two landmasses and found none, which
  // the offline harness explained in one line: this world is a single continent of
  // 1333 km² plus five islets of a few cells each. There is nothing to join. What there
  // are plenty of are firths — bays where two shores sit a kilometre apart across the
  // water and twenty by land. So the test is not "different landmass", it is "how far
  // is it round?", measured by a bounded flood fill over the land.
  // (BRIDGE itself is declared at module scope — the geometry is built further down.)
  {
    const landStep = (startK, goalK, cap) => {
      const seen = new Uint8Array(RGN * RGN);
      seen[startK] = 1;
      let frontier = [startK];
      for (let step = 1; step <= cap; step++) {
        const next = [];
        for (const k of frontier) {
          const ki = k % RGN, kj = (k / RGN) | 0;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ni = ki + di, nj = kj + dj;
            if (ni < 0 || nj < 0 || ni >= RGN || nj >= RGN) continue;
            const nk = nj * RGN + ni;
            if (seen[nk] || H[nk] < ROAD_MIN_Y) continue;
            if (nk === goalK) return step;
            seen[nk] = 1; next.push(nk);
          }
        }
        if (!next.length) return Infinity;
        frontier = next;
      }
      return Infinity;
    };

    const cands = [];
    for (let j = 0; j < RGN; j++) {
      for (let i = 0; i < RGN; i++) {
        const k = j * RGN + i;
        if (H[k] < ROAD_MIN_Y) continue;
        for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
          for (let n = 3; n <= 7; n++) {                    // 750 m .. 1750 m of water
            const ni = i + di * n, nj = j + dj * n;
            if (ni < 0 || nj < 0 || ni >= RGN || nj >= RGN) break;
            const nk = nj * RGN + ni;
            if (H[nk] < ROAD_MIN_Y) continue;               // still wet, reach further
            let wet = true;
            for (let q = 1; q < n && wet; q++)
              if (H[(j + dj * q) * RGN + (i + di * q)] >= ROAD_MIN_Y) wet = false;
            if (!wet) break;
            cands.push({ i, j, ni, nj, k, nk, span: n * RG * Math.hypot(di, dj) });
            break;
          }
        }
      }
    }
    // Longest spans first — a bridge should look like a bridge — then keep the first
    // one whose shores are genuinely far apart by land.
    cands.sort((p, q) => q.span - p.span);
    let best = null;
    for (const c of cands.slice(0, 60)) {
      const detour = landStep(c.k, c.nk, 55);               // 55 cells ≈ 14 km of coast
      if (detour === Infinity || detour * RG > c.span * 8) { best = { ...c, detour }; break; }
    }
    if (best) {
      const ax = nx(best.i), az = nx(best.j), bx = nx(best.ni), bz = nx(best.nj);
      let dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz); dx /= L; dz /= L;
      // Run the corridor inland at each end: that is the approach viaduct the deck ramps
      // down along, so the road meets the ground instead of stopping in mid air.
      const RAMP = 340;
      const x0 = ax - dx * RAMP, z0 = az - dz * RAMP;
      const x1 = bx + dx * RAMP, z1 = bz + dz * RAMP;
      const total = L + RAMP * 2;
      const yA = terrainH(x0, z0), yB = terrainH(x1, z1);
      // 62 m of air under the deck: the aeroplane is 10 m across and 3 m tall, so going
      // under is a dare you can take rather than a wall with a hole in it.
      const deckY = Math.max(62, yA + 26, yB + 26);
      BRIDGE = { x0, z0, x1, z1, dx, dz, total, deckY, yA, yB, ramp: RAMP,
                 ax, az, bx, bz, span: L, hw: 11 };
      // Chaikin smoothing pulls the routed line off the straight crossing, and a road
      // 60 m to one side of a bridge is a road in the sea. Anything close enough to be
      // meant for the bridge gets projected onto its centreline instead.
      BRIDGE.snap = (x, z) => {
        const px = x - BRIDGE.x0, pz = z - BRIDGE.z0;
        const t = px * BRIDGE.dx + pz * BRIDGE.dz;
        if (t < -30 || t > BRIDGE.total + 30) return null;
        if (Math.abs(px * -BRIDGE.dz + pz * BRIDGE.dx) > 260) return null;
        const tc = clamp(t, 0, BRIDGE.total);
        return [BRIDGE.x0 + BRIDGE.dx * tc, BRIDGE.z0 + BRIDGE.dz * tc];
      };
      BRIDGE.yAt = (x, z) => {
        const px = x - BRIDGE.x0, pz = z - BRIDGE.z0;
        const t = px * BRIDGE.dx + pz * BRIDGE.dz;
        if (t < 0 || t > BRIDGE.total) return null;
        if (Math.abs(px * -BRIDGE.dz + pz * BRIDGE.dx) > 60) return null;
        if (t < RAMP) return lerp(BRIDGE.yA, BRIDGE.deckY, smoothstep(0, RAMP, t));
        if (t > BRIDGE.total - RAMP)
          return lerp(BRIDGE.deckY, BRIDGE.yB, smoothstep(BRIDGE.total - RAMP, BRIDGE.total, t));
        return BRIDGE.deckY;
      };
      // open the crossing to the router
      const steps = Math.ceil(L / RG) + 1;
      for (let m2 = 0; m2 <= steps; m2++) {
        const gi = Math.round(best.i + (best.ni - best.i) * m2 / steps);
        const gj = Math.round(best.j + (best.nj - best.j) * m2 / steps);
        if (gi < 0 || gj < 0 || gi >= RGN || gj >= RGN) continue;
        BRIDGEMASK[gj * RGN + gi] = 1;
      }
      console.log(`bridge: ${L | 0} m span at ${ax | 0},${az | 0} · deck ${deckY | 0} m`
        + ` · ${best.detour === Infinity ? '>14 km' : ((best.detour * RG / 1000).toFixed(1) + ' km')} round by land`);
    } else {
      console.warn('bridge: no crossing worth building found');
    }
  }

  const NB = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  function route(ax, az, bx, bz) {
    const si = Math.round((ax + WORLD) / RG), sj = Math.round((az + WORLD) / RG);
    const gi = Math.round((bx + WORLD) / RG), gj = Math.round((bz + WORLD) / RG);
    const start = sj * RGN + si, goal = gj * RGN + gi;
    if ((H[start] < ROAD_MIN_Y && !BRIDGEMASK[start]) || (H[goal] < ROAD_MIN_Y && !BRIDGEMASK[goal])) return null;
    if (COMP[start] < 0 || COMP[start] !== COMP[goal]) return null;   // different landmass
    const g = new Float32Array(RGN * RGN).fill(Infinity);
    const came = new Int32Array(RGN * RGN).fill(-1);
    const open = [start]; g[start] = 0;
    const f = new Float32Array(RGN * RGN).fill(Infinity);
    f[start] = 0;
    const done = new Uint8Array(RGN * RGN);
    let guard = 0;
    while (open.length && guard++ < 400000) {
      // linear scan for the best open node: the grids are small and this keeps the
      // whole router to forty lines with no heap to get wrong
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (f[open[k]] < f[open[bi]]) bi = k;
      const cur = open[bi]; open[bi] = open[open.length - 1]; open.pop();
      if (cur === goal) break;
      if (done[cur]) continue;
      done[cur] = 1;
      const ci = cur % RGN, cj = (cur / RGN) | 0;
      for (const [di, dj] of NB) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= RGN || nj >= RGN) continue;
        const nk = nj * RGN + ni;
        // A 250 m grid can step clean across a narrow inlet with dry land at both ends,
        // so "is this node dry" is not enough on its own: SHORE marks any node with
        // water in reach, and crossing one is expensive rather than merely allowed.
        // Roads were paddling through bays before this.
        if (done[nk] || (H[nk] < ROAD_MIN_Y && !BRIDGEMASK[nk])) continue;
        const d = Math.hypot(di, dj) * RG;
        const grade = Math.abs(H[nk] - H[cur]) / d;
        const cost = d * (1 + grade * 22) + STRIPPEN[nk] * STRIPPEN[nk] * 30000
          + (SHORE[nk] ? 1800 : 0) + (H[nk] < ROAD_LOW_Y ? 2200 : 0);
        const ng = g[cur] + cost;
        if (ng < g[nk]) {
          g[nk] = ng; came[nk] = cur;
          f[nk] = ng + Math.hypot(gi - ni, gj - nj) * RG;
          open.push(nk);
        }
      }
    }
    if (came[goal] < 0 && goal !== start) return null;
    const path = [];
    for (let k = goal; k !== -1; k = came[k]) path.push([nx(k % RGN), nx((k / RGN) | 0)]);
    return path.reverse();
  }

  // Minimum spanning tree over the settlements, so every place that can be reached is
  // reached, with no redundant parallel roads.
  // Every settlement and every airfield is a node — an airstrip nobody can drive to is
  // a strange thing to have in a landscape.
  // An airfield's road wants to arrive at an apron beside the strip, not down the middle
  // of it. Routing to the strip centre is what actually put roads on three of the five
  // runways: the destination WAS the runway, so no penalty could ever have saved it.
  // Try both sides, take the first that is dry and on the same landmass.
  let aprons = 0;
  const apronOf = s => {
    // Offset by a whole grid cell, not just clear of the tarmac: A* snaps the goal to
    // the nearest node, and a snap can move it up to RG/2 on each axis — an apron only
    // 140 m out gets rounded straight back onto the runway it was meant to avoid.
    const lx = s.hw + RG, lz = -s.halfLen * 0.45;
    for (const side of [1, -1]) {
      const x = s.x + side * lx * s.cs + lz * s.sn;
      const z = s.z - side * lx * s.sn + lz * s.cs;
      if (terrainH(x, z) >= ROAD_LOW_Y && compAt(x, z) >= 0 && compAt(x, z) === compAt(s.x, s.z)) {
        aprons++; return { x, z };
      }
    }
    return { x: s.x, z: s.z };            // nowhere beside it works — better a road than none
  };
  const nodes = TOWNS.map(t => ({ x: t.x, z: t.z, name: t.name }))
    .concat(STRIPS.map(t => { const a = apronOf(t); return { x: a.x, z: a.z, name: t.name }; }));
  // Both ends of the bridge join the network as nodes. Without this the crossing is only
  // used if it happens to lie on a good route between two settlements — and a bridge with
  // no road on it is a folly.
  let bridgeNodes = null;
  if (BRIDGE) {
    bridgeNodes = [nodes.length, nodes.length + 1];
    nodes.push({ x: BRIDGE.x0, z: BRIDGE.z0, name: 'BRIDGE N' });
    nodes.push({ x: BRIDGE.x1, z: BRIDGE.z1, name: 'BRIDGE S' });
  }
  // Spanning tree per landmass, so islands quietly get their own little network (or
  // none) instead of dragging a road into the sea.
  const edges = [];
  const seen = new Set();
  const byComp = new Map();
  nodes.forEach((n, i) => {
    const c = compAt(n.x, n.z);
    if (c < 0) return;
    if (!byComp.has(c)) byComp.set(c, []);
    byComp.get(c).push(i);
  });
  for (const group of byComp.values()) {
    if (group.length < 2) continue;
    const inTree = [group[0]], out = group.slice(1);
    while (out.length) {
      let best = null;
      for (const a of inTree) for (const b of out) {
        const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
        if (!best || d < best.d) best = { a, b, d };
      }
      edges.push([best.a, best.b]); seen.add(best.a + ':' + best.b); seen.add(best.b + ':' + best.a);
      inTree.push(best.b); out.splice(out.indexOf(best.b), 1);
    }
    // then a few extra links between near neighbours, so the network has loops in it
    // rather than being a pure tree — a tree reads as arbitrary from the air
    for (const a of group) for (const b of group) {
      if (a >= b || seen.has(a + ':' + b)) continue;
      const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
      if (d > 11000) continue;
      if (hash2i(a * 7919 + 5, b * 104729 - 5) > 0.45) continue;
      edges.push([a, b]); seen.add(a + ':' + b); seen.add(b + ':' + a);
    }
  }

  // and force the span itself into the edge list
  if (bridgeNodes) edges.push(bridgeNodes);

  const ribbons = [];
  for (const [a, b] of edges) {
    const p = route(nodes[a].x, nodes[a].z, nodes[b].x, nodes[b].z);
    if (!p || p.length < 2) continue;
    // two rounds of Chaikin knock the 45-degree staircase off the grid path
    let sm = p;
    for (let pass = 0; pass < 2; pass++) {
      const q = [sm[0]];
      for (let i = 0; i < sm.length - 1; i++) {
        const [x0, z0] = sm[i], [x1, z1] = sm[i + 1];
        q.push([x0 * 0.75 + x1 * 0.25, z0 * 0.75 + z1 * 0.25]);
        q.push([x0 * 0.25 + x1 * 0.75, z0 * 0.25 + z1 * 0.75]);
      }
      q.push(sm[sm.length - 1]); sm = q;
    }
    if (BRIDGE) sm = sm.map(([x, z]) => BRIDGE.snap(x, z) || [x, z]);
    roadPaths.push(sm);
    // lay a ribbon that hugs the ground: every vertex samples the height field, so the
    // road rides the terrain instead of floating over the dips
    const W = 9;
    // A road surface tilts with the ground it is laid on. This used to sample the height
    // once, on the centreline, and give both edges that same y — so on any cross-slope
    // the uphill edge was buried in the hill and the downhill one floated. Four per cent
    // of the ribbon was inside the terrain, up to 3.4 m deep, and that is what chopped it
    // into disconnected blocks with hard edges.
    //
    // Two changes: every corner takes its own height sample, and a long segment is cut
    // into pieces so a rise in the middle of it cannot poke through a flat quad either.
    // The bridge is the exception — a deck stays level across its width.
    const RIB = 18;                                   // metres of road per quad
    const cornerY = (x, z, bY) =>
      (bY !== null && bY !== undefined) ? bY + 0.3 : terrainH(x, z) + 0.28;
    for (let i = 0; i < sm.length - 1; i++) {
      const [ax0, az0] = sm[i], [ax1, az1] = sm[i + 1];
      let tx = ax1 - ax0, tz = az1 - az0;
      const segL = Math.hypot(tx, tz) || 1; tx /= segL; tz /= segL;
      const px = -tz * W / 2, pz = tx * W / 2;
      const steps = Math.max(1, Math.ceil(segL / RIB));
      for (let k = 0; k < steps; k++) {
        const f0 = k / steps, f1 = (k + 1) / steps;
        const x0 = ax0 + (ax1 - ax0) * f0, z0 = az0 + (az1 - az0) * f0;
        const x1 = ax0 + (ax1 - ax0) * f1, z1 = az0 + (az1 - az0) * f1;
        // On the bridge the road rides the deck, not the sea bed.
        const bY0 = BRIDGE && BRIDGE.yAt(x0, z0), bY1 = BRIDGE && BRIDGE.yAt(x1, z1);
        const aL = cornerY(x0 + px, z0 + pz, bY0), aR = cornerY(x0 - px, z0 - pz, bY0);
        const bL = cornerY(x1 + px, z1 + pz, bY1), bR = cornerY(x1 - px, z1 - pz, bY1);
        // smoothing shifts the line off the grid nodes it was checked on, so re-check the
        // actual ribbon: a piece that ends up wet is simply not laid
        if (Math.min(aL, aR, bL, bR) < 1.5) continue;
        const g2 = new THREE.BufferGeometry();
        g2.setAttribute('position', new THREE.Float32BufferAttribute([
          x0 + px, aL, z0 + pz, x1 + px, bL, z1 + pz, x1 - px, bR, z1 - pz,
          x0 + px, aL, z0 + pz, x1 - px, bR, z1 - pz, x0 - px, aR, z0 - pz,
        ], 3));
        g2.setAttribute('normal', new THREE.Float32BufferAttribute(
          [0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0], 3));
        // uv is unused by the toon material but merge() demands every geometry carry the
        // same attribute set, and the town streets are boxes, which have one
        g2.setAttribute('uv', new THREE.Float32BufferAttribute([0,0, 1,0, 1,1, 0,0, 1,1, 0,1], 2));
        ribbons.push(g2);
      }
    }
  }
  if (ribbons.length) allRoad.push(...ribbons);
  // How close does the finished network actually come to the sea? This is the number
  // that says whether the water avoidance worked, rather than a squint at the map.
  let lowest = Infinity, wet = 0, pts = 0;
  for (const path of roadPaths)
    for (const [px, pz] of path) {
      const bY = BRIDGE && BRIDGE.yAt(px, pz);
      const y = (bY !== null && bY !== undefined) ? bY : terrainH(px, pz); pts++;
      if (y < lowest) lowest = y;
      if (y < 0) wet++;
    }
  // How many of the roads still run over tarmac? This is the number that says whether
  // the apron nodes and the graded band actually worked, rather than a squint from 500 ft.
  let onStrip = 0, stripPts = 0;
  for (const path of roadPaths)
    for (const [px, pz] of path) { stripPts++; if (stripNear(px, pz) <= 0) onStrip++; }
  console.log(`roads: ${aprons}/${STRIPS.length} airfields reached by an apron beside the `
    + `strip · ${onStrip}/${stripPts} path points on a runway`);
  console.log(`roads: ${edges.length} links attempted, ${roadPaths.length} routed, `
    + `${ribbons.length} ribbon quads · lowest point on any road ${lowest.toFixed(1)}m`
    + ` · ${wet}/${pts} path points below sea level`);
}

// Keep the scatter off the tarmac. Highways get a wider brush than town streets
// because they run through open country where a tree on the verge is conspicuous.
for (const p of roadPaths) markRoad(p, 1);
for (const p of STREET_PATHS) markRoad(p, 1);
console.log(`road mask: ${ROAD_CELLS.size} cells at ${ROAD_CELL}m`);

// =================================================================
//  RIBBON DEVELOPMENT
//  Buildings crowd a road long before they amount to a town. Without this the world was
//  seven dense settlements with a hundred kilometres of empty tarmac between them, which
//  reads as a diorama rather than as a country.
//
//  Density is a falloff from the nearest town multiplied by a slow noise field: the
//  approaches to a city are almost continuous, out in the middle it is one farm in a
//  mile, and the noise means some stretches are a hamlet and the next is empty. An even
//  sprinkle would look like wallpaper.
//
//  Each house marks its own footprint into ROAD_CELLS, which does two jobs for free —
//  the scatter stops planting trees through the walls, and the next candidate along the
//  verge is rejected for being on an occupied cell, so they space themselves out.
// =================================================================
const SPRAWL_CELL = 140;
const SPRAWL_GRID = new Map();             // cell -> boxes, so cityHit stays cheap
{
  const lots = [], roofs = [];
  const townEdge = (x, z) => {
    let b = Infinity;
    for (const t of TOWNS) b = Math.min(b, Math.hypot(t.x - x, t.z - z) - t.half);
    return b;
  };
  const WALL = [0xe8e4dc, 0xd9cfba, 0xc9c3b4, 0xe4d7bc, 0xcfc6b8];
  const STEP = 52;
  let tried = 0;
  for (const path of roadPaths) {
    let dist = 0, nextAt = STEP * hash2i(path.length * 13, 3);
    for (let i = 0; i < path.length - 1; i++) {
      const [x0, z0] = path[i], [x1, z1] = path[i + 1];
      const segL = Math.hypot(x1 - x0, z1 - z0);
      if (segL < 1e-3) continue;
      const tx = (x1 - x0) / segL, tz = (z1 - z0) / segL;
      const nxp = -tz, nzp = tx;                        // the road's normal
      while (nextAt <= dist + segL) {
        const f = (nextAt - dist) / segL;
        const bx = x0 + (x1 - x0) * f, bz = z0 + (z1 - z0) * f;
        nextAt += STEP;
        const edge = townEdge(bx, bz);
        if (edge < 90) continue;                        // the settlement already built here
        let dens = 0.10 + 0.80 * clamp01(1 - (edge - 90) / 3500);
        dens *= 0.25 + vnoise(bx * 0.00115, bz * 0.00115) * 1.7;
        for (const side of [-1, 1]) {
          tried++;
          const hx = (bx * 0.37) | 0, hz = ((bz * 0.37) | 0) + side * 977;
          if (hash2i(hx, hz) > dens) continue;
          // clear of the road mask, not merely clear of the tarmac: markRoad brushes a
          // cell either side at 14 m, so anything set back less than about 21 m gets
          // rejected by its own verge and the whole roadside comes out half empty.
          const off = 27 + hash2i(hx + 7, hz - 7) * 20;
          const x = bx + nxp * side * off, z = bz + nzp * side * off;
          const y = terrainH(x, z, SMP);
          if (y < 3) continue;                          // not on the beach, never in the sea
          if (SMP.rw > 0.01 || SMP.cw > 0.01) continue; // never on a strip or a town pad
          if (onRoad(x, z)) continue;                   // never on the tarmac, never on a neighbour
          const e = 26;                                 // and not clinging to a cliff
          if (Math.hypot(terrainH(x + e, z) - y, terrainH(x, z + e) - y) / e > 0.16) continue;
          const r = hash2i(hx + 91, hz - 91);
          const big = r > 0.86;                         // the occasional barn or depot
          const w = big ? 13 + r * 12 : 7 + r * 6;
          const d = big ? 10 + r * 9 : 6 + r * 5;
          const h = big ? 6 + r * 5 : 4 + r * 3.2;
          const hdg = Math.atan2(tx, tz);               // square to the road it fronts
          lots.push({ x, y, z, w, d, h, hdg, col: WALL[(r * WALL.length) | 0] });
          if (!big) roofs.push({ x, y: y + h, z, w: w * 1.08, d: d * 1.08,
                                 h: 1.8 + r * 2.6, hdg });
          const b = { x, z, hw: w / 2, hd: d / 2, top: y + h,
                      sn: Math.sin(hdg), cs: Math.cos(hdg) };
          const key = Math.floor(x / SPRAWL_CELL) + ':' + Math.floor(z / SPRAWL_CELL);
          if (!SPRAWL_GRID.has(key)) SPRAWL_GRID.set(key, []);
          SPRAWL_GRID.get(key).push(b);
          const gx = Math.round(x / ROAD_CELL), gz = Math.round(z / ROAD_CELL);
          for (let a = -1; a <= 1; a++)
            for (let c = -1; c <= 1; c++) ROAD_CELLS.add(roadKey(gx + a, gz + c));
        }
      }
      dist += segL;
    }
  }
  const inst = (list, geo, colour) => {
    if (!list.length) return;
    const m = new THREE.InstancedMesh(geo,
      new THREE.MeshToonMaterial({ gradientMap: RAMP, map: WALL_GRAIN }), list.length);
    m.frustumCulled = false;
    const c = new THREE.Color();
    list.forEach((L, n) => {
      dummy.position.set(L.x, L.y + L.h / 2, L.z);
      dummy.rotation.set(0, L.hdg, 0);
      dummy.scale.set(L.w, L.h, L.d);
      dummy.updateMatrix();
      m.setMatrixAt(n, dummy.matrix);
      c.set(colour(L, n)); m.setColorAt(n, c);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    scene.add(m);
  };
  inst(lots, BOX(1, 1, 1), L => L.col);
  const ridge = BOX(1, 1, 1).toNonIndexed();
  const rpa = ridge.attributes.position;
  for (let i = 0; i < rpa.count; i++) if (rpa.getY(i) > 0) rpa.setX(i, 0);
  ridge.computeVertexNormals();
  const RC = [0x9c4b3a, 0x7d5a46, 0xb2604a, 0x6b6f76, 0x8a4a3c];
  inst(roofs, ridge, L => RC[(hash2i(L.x | 0, L.z | 0) * RC.length) | 0]);
  console.log(`sprawl: ${lots.length} roadside buildings of ${tried} sites tried, `
    + `${roofs.length} pitched roofs, ${SPRAWL_GRID.size} collision cells`);
}

// ---- the bridge itself -------------------------------------------------------
// Built after the network so the deck sits exactly where the road already runs.
if (BRIDGE) {
  const B = BRIDGE;
  const ang = Math.atan2(B.dx, B.dz);
  const sn = Math.sin(ang), cs = Math.cos(ang);
  const g = new THREE.Group();
  g.position.set(B.x0, 0, B.z0);
  g.rotation.y = ang;
  scene.add(g);
  const along = t => t;                                   // local +Z runs along the span

  // deck, in segments so it can follow the ramp profile
  const SEG = 34, n = Math.ceil(B.total / SEG);
  const deck = [], edge = [];
  for (let i = 0; i < n; i++) {
    const t0 = i * SEG, t1 = Math.min(B.total, (i + 1) * SEG);
    const y0 = B.yAt(B.x0 + B.dx * t0, B.z0 + B.dz * t0);
    const y1 = B.yAt(B.x0 + B.dx * t1, B.z0 + B.dz * t1);
    const ym = (y0 + y1) / 2, mid = (t0 + t1) / 2;
    const seg = baked(BOX(B.hw * 2 + 4, 2.2, t1 - t0), 0, ym, along(mid));
    deck.push(seg);
    for (const s2 of [-1, 1])                             // parapet
      edge.push(baked(BOX(1.2, 2.4, t1 - t0), s2 * (B.hw + 1.4), ym + 2.2, along(mid)));
  }
  g.add(new THREE.Mesh(merge(deck), toon(0x8f949c)));
  g.add(new THREE.Mesh(merge(edge), toon(0xd8d4cc)));

  // piers down to the water, and two towers with stays
  const piers = [];
  for (let t = B.ramp * 0.45; t < B.total; t += 128) {
    const wx = B.x0 + B.dx * t, wz = B.z0 + B.dz * t;
    const gy = terrainH(wx, wz), dy = B.yAt(wx, wz);
    if (dy === null) continue;
    const base = Math.max(gy, SEA_Y - 6);
    piers.push(baked(BOX(9, dy - base, 11), 0, (dy + base) / 2, along(t)));
  }
  g.add(new THREE.Mesh(merge(piers), toon(0xb9bcc2)));

  const towerT = [B.ramp + B.span * 0.22, B.ramp + B.span * 0.78];
  for (const t of towerT) {
    const dy = B.yAt(B.x0 + B.dx * t, B.z0 + B.dz * t);
    const top = dy + 54;
    for (const s2 of [-1, 1]) {
      const leg = new THREE.Mesh(BOX(4, top + 6, 5), toon(0xe4e0d8));
      leg.position.set(s2 * (B.hw + 3), (top + 6) / 2 - 6, along(t)); g.add(leg);
    }
    const cross = new THREE.Mesh(BOX(B.hw * 2 + 12, 3.4, 5), toon(0xe4e0d8));
    cross.position.set(0, top - 4, along(t)); g.add(cross);
    // stay cables fanning out to the deck
    for (let k = 1; k <= 6; k++) {
      const reach = k * 26;
      for (const s2 of [-1, 1]) for (const dir of [-1, 1]) {
        const tt = t + dir * reach;
        if (tt < 4 || tt > B.total - 4) continue;
        const dyy = B.yAt(B.x0 + B.dx * tt, B.z0 + B.dz * tt);
        if (dyy === null) continue;
        const len = Math.hypot(top - 8 - dyy, reach);
        const cab = new THREE.Mesh(BOX(0.5, len, 0.5), toon(0x6e737b));
        cab.position.set(s2 * (B.hw + 3), (top - 8 + dyy) / 2, along(t + dir * reach / 2));
        cab.rotation.x = dir * Math.atan2(reach, top - 8 - dyy);
        g.add(cab);
      }
    }
  }

  // Solid deck, open water underneath. This is a box and not a cylinder precisely so
  // that flying under it is a thing you can do.
  const midT = B.total / 2;
  LM_BOX.push({ x: B.x0 + B.dx * midT, z: B.z0 + B.dz * midT, sn, cs,
    hw: B.hw + 6, hd: B.total / 2, y0: B.deckY - 3.5, y1: B.deckY + 9 });
  for (const t of towerT) {
    const wx = B.x0 + B.dx * t, wz = B.z0 + B.dz * t;
    const dy = B.yAt(wx, wz);
    LM_BOX.push({ x: wx, z: wz, sn, cs, hw: B.hw + 6, hd: 4, y0: SEA_Y, y1: dy + 60 });
  }
  LANDMARKS.push({ name: 'THE SOUND BRIDGE', x: B.x0 + B.dx * midT, z: B.z0 + B.dz * midT, y: B.deckY });
  console.log(`bridge built: deck ${B.deckY | 0} m, ${B.total | 0} m end to end, `
    + `${(B.deckY - SEA_Y - 4) | 0} m of clearance underneath`);
}

// every street and every highway in the world, one mesh
if (allRoad.length) {
  const rm = new THREE.Mesh(merge(allRoad), paint(0x3b3f47));
  rm.frustumCulled = false;
  scene.add(rm);
}

// =================================================================
//  LANDMARKS
//  One-off structures, each sited by the thing that makes it what it is: the pyramid
//  wants desert, the colossus wants the highest peak it can find, the lighthouse wants
//  a headland. They are placed on a deterministic spiral outward from the home field,
//  so they are all inside a couple of minutes' flying and they are in the same place
//  every load — the whole point of a landmark being that you learn where it is.
//
//  Nothing here flattens the terrain: each one demands ground already flat enough and
//  then sinks its footing a little, which is cheaper than another site in the height
//  field and keeps them looking planted rather than parked.
// =================================================================

// Most landmarks are solid enough that one cylinder is the truth. The few you are meant
// to fly *through* declare their solids part by part instead, and the cylinder demotes to
// a broad phase — so the cost of the finer test is only paid inside the bounding radius.
// Parts live in the landmark group's own space, which is rotated about Y, so a world
// point gets rotated back before it is tested. y0/y1 are metres above the group's base.
//
// A box's vertical extent is deliberately NOT inflated by PLANE_R the way its horizontal
// one is: a wingspan is wide, an airframe is not tall, and inflating both would quietly
// shrink every gap by ten metres and make the limbo runs unflyable for no honest reason.
// A ring does inflate in every direction, since its clearance is radial — it costs a few
// metres of headroom at the crown, which is the safe way to be wrong.
const hbox = (lx, lz, hw, hd, y0, y1) => ({ lx, lz, hw, hd, y0, y1 });
// An arch ring: an annulus standing in the group's local X/Y plane, extruded +-hd along
// local Z. Exact for a voussoir arch, where a leg-and-lintel box would leave you flying
// through the haunches. r0 = 0 makes it a disc.
const hring = (lx, ly, lz, r0, r1, hd, y0) => ({ ring: 1, lx, ly, lz, r0, r1, hd, y0 });

const stone = toon(0xb9ae96), stone2 = toon(0x9a8f79), dark = toon(0x3a3f47),
      rust = toon(0x8d5a3a), white = toon(0xece7dc), sandst = toon(0xd8c08a);

function siteLandmark(want, cx, cz, minR, maxR) {
  let best = null;
  for (let r = minR; r <= maxR; r += 260) {
    for (let a = 0; a < 26; a++) {
      const ang = (a / 26) * 6.283185 + r * 0.0021;         // spiral so rings do not line up
      const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
      const y = terrainH(x, z, SMP);
      if (SMP.rw > 0.01 || SMP.cw > 0.01) continue;          // never on a strip or in a town
      const e = 60;
      const slope = Math.hypot(terrainH(x + e, z) - y, terrainH(x, z + e) - y) / e;
      const c = { x, z, y, slope, wAr: SMP.wAr, wMtn: SMP.wMtn, wPl: SMP.wPl, land: SMP.land, r };
      if (!want(c)) continue;
      if (LANDMARKS.some(l => Math.hypot(l.x - x, l.z - z) < 1500)) continue;
      if (TOWNS.some(t => Math.hypot(t.x - x, t.z - z) < t.half + 700)) continue;
      if (STRIPS.some(t => Math.hypot(t.x - x, t.z - z) < t.halfLen + 600)) continue;
      const score = r + c.slope * 9000;                      // near and flat wins
      if (!best || score < best.score) best = { c, score };
    }
    if (best) break;                                          // first ring that works
  }
  return best && best.c;
}

// Everywhere a landmark might reasonably anchor to. The first handful ladder outward
// from the home field so there is plenty to find on a first flight; the rest hang off
// towns and airfields all over the map, because forty of them stacked round one
// airstrip is a theme park, not a world.
const ANCHORS = TOWNS.concat(STRIPS);
// A global lattice, for when there are more landmarks than there are anchors to hang
// them off. The world is cut into GRID_N² cells and each landmark starts its search in
// a different one, stepping by a stride coprime with the cell count so the sequence
// visits every cell before repeating. That spreads a hundred of them evenly instead of
// piling them round the twelve inhabited places.
const GRID_N = 7;
const CELLW = (WORLD * 2) / GRID_N;
let cellN = 0;
function siteGlobal(want) {
  const total = GRID_N * GRID_N;
  for (let a = 0; a < total; a++) {
    const k = (cellN * 23 + a) % total;            // 23 is coprime with 49
    const ci = k % GRID_N, cj = (k / GRID_N) | 0;
    const c = siteLandmark(want, -WORLD + (ci + 0.5) * CELLW, -WORLD + (cj + 0.5) * CELLW,
      200, CELLW * 0.62);
    if (c) { cellN++; return c; }
  }
  cellN++;
  return null;
}

let lmN = 0, anchorN = 0;
// Which way is the sea from here? Averages the directions of the wet samples on a
// ring. A pier, a jetty or a marina pointing inland is worse than not having one.
function waterDir(x, z, r) {
  let wx = 0, wz = 0, n = 0;
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * 6.283185;
    const dx = Math.cos(a), dz = Math.sin(a);
    if (terrainH(x + dx * r, z + dz * r) < 0) { wx += dx; wz += dz; n++; }
  }
  return n ? Math.atan2(wx, wz) : null;
}
function place(name, want, build, hit, spread, faceWater) {
  let c = null;
  if (spread === 'global') {
    c = siteGlobal(want);
  } else if (spread) {
    // walk the anchors until one of them has ground this thing can live on
    for (let a = 0; a < ANCHORS.length && !c; a++) {
      const A = ANCHORS[(anchorN + a) % ANCHORS.length];
      c = siteLandmark(want, A.x, A.z, 1100, 6500);
    }
    anchorN++;
  } else {
    const HOMEP = STRIPS[0];
    // Each one starts its search a little further out than the last. The finder takes
    // the first ring that works, so without this they all settle at the minimum radius
    // and end up as a ring of monuments round the airfield at one distance.
    const minR = 1300 + (lmN++) * 420;
    c = siteLandmark(want, HOMEP.x, HOMEP.z, minR, minR + 7000);
  }
  if (!c) { console.warn(`landmark ${name}: no site found`); return; }
  const g = new THREE.Group();
  g.position.set(c.x, c.y, c.z);
  const wd = faceWater ? waterDir(c.x, c.z, faceWater) : null;
  const rot = wd !== null ? wd : hash2i(c.x | 0, c.z | 0) * 6.283185;
  g.rotation.y = rot;
  build(g, c);
  scene.add(g);
  // Keep the scatter out of whatever this landmark actually occupies. Measuring the built
  // group's own bounds means a 260 m speedway masks 260 m and an obelisk masks six, with
  // no per-landmark number to get wrong and nothing to keep in step when one is edited.
  {
    const bb = new THREE.Box3().setFromObject(g);
    if (isFinite(bb.min.x)) {
      markRect((bb.min.x + bb.max.x) / 2, (bb.min.z + bb.max.z) / 2,
        (bb.max.x - bb.min.x) / 2 + 7, (bb.max.z - bb.min.z) / 2 + 7);
      lmMasked++;
    }
  }
  LANDMARKS.push({ name, x: c.x, z: c.z, y: c.y, sn: Math.sin(rot), cs: Math.cos(rot) });
  if (hit) LM_HIT.push({
    x: c.x, z: c.z, y: c.y, r: hit[0], top: c.y + hit[1],
    sn: Math.sin(rot), cs: Math.cos(rot), parts: hit[2] || null,
  });
}

const flat = t => c => c.slope < t;
const desert = c => c.wAr > 0.45 && c.y > 12 && c.slope < 0.10;
const plains = c => c.wPl > 0.45 && c.y > 10 && c.slope < 0.07;

// 1 — the pyramid. Four-sided cone, turned so a face points at you, sunk into the sand.
place('THE GREAT PYRAMID', c => desert(c) && c.slope < 0.06, g => {
  const p = new THREE.Mesh(new THREE.ConeGeometry(150, 118, 4), sandst);
  p.position.y = 118 / 2 - 7; p.rotation.y = Math.PI / 4; g.add(p);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(16, 13, 4), toon(0xe8d9a8));
  cap.position.y = 111 - 7; cap.rotation.y = Math.PI / 4; g.add(cap);
  for (const s of [-1, 1]) {                                  // a small satellite each side
    const q = new THREE.Mesh(new THREE.ConeGeometry(38, 30, 4), sandst);
    q.position.set(s * 215, 15 - 4, 150); q.rotation.y = Math.PI / 4; g.add(q);
  }
}, [150, 118]);

// 2 — the colossus, on the highest ground it can reach
place('THE COLOSSUS', c => c.wMtn > 0.5 && c.y > 430 && c.slope < 0.30, g => {
  const S = 7.5;                                              // ~105 m tall
  const m = new THREE.Group(); m.scale.setScalar(S); g.add(m);
  const plinth = new THREE.Mesh(BOX(11, 1.6, 9), stone2); plinth.position.y = 0.8; m.add(plinth);
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(BOX(1.5, 5.4, 1.6), stone); leg.position.set(s * 1.5, 4.3, 0); m.add(leg);
    const arm = new THREE.Mesh(BOX(1.2, 5.0, 1.2), stone);
    arm.position.set(s * 3.3, 8.6, 0); arm.rotation.z = s * 0.22; m.add(arm);
  }
  const torso = new THREE.Mesh(BOX(4.6, 5.2, 2.2), stone); torso.position.y = 9.4; m.add(torso);
  const head = new THREE.Mesh(BOX(1.9, 2.1, 1.9), stone); head.position.y = 13.0; m.add(head);
  // one arm raised, holding something up — reads from miles away as a figure, not a rock
  const up = new THREE.Mesh(BOX(1.2, 5.4, 1.2), stone);
  up.position.set(3.9, 12.6, 0); up.rotation.z = 0.5; m.add(up);
  const torch = new THREE.Mesh(new THREE.ConeGeometry(1.3, 2.6, 8), toon(0xffd23b));
  torch.position.set(5.6, 15.6, 0); m.add(torch);
}, [60, 115]);

// 3 — the lighthouse, on a headland
place('BEACON POINT', c => c.y > 4 && c.y < 46 && c.land > 0.2 && c.slope < 0.16
  && waterFrac(c.x, c.z, 320, 10) > 0.25, g => {
  for (let i = 0; i < 7; i++) {                               // banded tower
    const t = new THREE.Mesh(new THREE.CylinderGeometry(3.4 - i * 0.22, 3.7 - i * 0.22, 7, 12),
      i % 2 ? toon(0xd8483a) : white);
    t.position.y = 3.5 + i * 7; g.add(t);
  }
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.0, 4.6, 12), toon(0x243049));
  lamp.position.y = 52; g.add(lamp);
  const cap2 = new THREE.Mesh(new THREE.ConeGeometry(3.6, 3.4, 12), dark); cap2.position.y = 56; g.add(cap2);
  const hut = new THREE.Mesh(BOX(11, 5, 8), white); hut.position.set(9, 2.5, 0); g.add(hut);
}, [8, 58]);

// 4 — the stone circle
place('THE RING', plains, g => {
  const parts = [];
  for (let i = 0; i < 15; i++) {
    const a = i / 15 * 6.283185;
    parts.push(baked(BOX(3.4, 8.5 + (i % 3) * 1.8, 2.0), Math.cos(a) * 42, 4.2, Math.sin(a) * 42, 0, -a, 0));
    if (i % 3 === 0)                                          // lintels on every third pair
      parts.push(baked(BOX(9, 1.6, 2.2), Math.cos(a + 0.2) * 42, 9.6, Math.sin(a + 0.2) * 42, 0, -a, 0));
  }
  parts.push(baked(BOX(7, 1.4, 3.4), 0, 0.7, 0));             // the altar
  g.add(new THREE.Mesh(merge(parts), stone2));
});

// 5 — the radio telescope
place('DEEP SKY ARRAY', c => c.y > 90 && c.slope < 0.14 && c.wMtn < 0.6, g => {
  const base = new THREE.Mesh(new THREE.CylinderGeometry(9, 12, 7, 12), toon(0xc9ccd2));
  base.position.y = 3.5; g.add(base);
  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(26, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.42),
    new THREE.MeshToonMaterial({ color: 0xe4e8ee, gradientMap: RAMP, side: THREE.DoubleSide }));
  dish.position.y = 30; dish.rotation.x = Math.PI * 0.78; g.add(dish);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 22, 8), dark);
  mast.position.set(0, 34, 12); mast.rotation.x = 0.5; g.add(mast);
  for (let i = 0; i < 3; i++) {                               // three little ones alongside
    const d2 = new THREE.Mesh(new THREE.SphereGeometry(8, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.42),
      new THREE.MeshToonMaterial({ color: 0xd8dce4, gradientMap: RAMP, side: THREE.DoubleSide }));
    d2.position.set(-70 + i * 62, 11, 74); d2.rotation.x = Math.PI * 0.78; g.add(d2);
    const p2 = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3, 8, 8), toon(0xc9ccd2));
    p2.position.set(-70 + i * 62, 4, 74); g.add(p2);
  }
}, [30, 46]);

// 6 — the wind farm, rotors turning
place('WINDROW RIDGE', c => c.y > 120 && c.y < 520 && c.slope < 0.20 && c.wMtn < 0.7, g => {
  for (let i = 0; i < 9; i++) {
    const t = new THREE.Group();
    t.position.set((i - 4) * 105, 0, ((i % 3) - 1) * 60);
    const tow = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.6, 62, 10), white);
    tow.position.y = 31; t.add(tow);
    const nac = new THREE.Mesh(BOX(3, 3, 7), white); nac.position.y = 63; t.add(nac);
    const rot = new THREE.Group(); rot.position.set(0, 63, 4);
    for (let b = 0; b < 3; b++) {
      const bl = new THREE.Mesh(BOX(1.5, 34, 0.6), white);
      bl.position.set(Math.sin(b / 3 * 6.283) * 17, Math.cos(b / 3 * 6.283) * 17, 0);
      bl.rotation.z = -b / 3 * 6.283; rot.add(bl);
    }
    t.add(rot); g.add(t);
    spinners.push({ o: rot, spd: 0.7 + hash2i(i, 3) * 0.6 });
  }
});

// 7 — the ruined temple
place('THE OLD TEMPLE', c => (c.wPl > 0.3 || c.wAr > 0.3) && c.y > 40 && c.slope < 0.09, g => {
  const parts = [];
  parts.push(baked(BOX(74, 3, 42), 0, 1.5, 0));               // stylobate
  for (let i = 0; i < 10; i++) for (const s of [-1, 1]) {
    const h = i === 4 || i === 7 ? 9 : 17;                    // a couple of broken drums
    parts.push(baked(new THREE.CylinderGeometry(2.2, 2.6, h, 10), -33 + i * 7.3, 3 + h / 2, s * 17));
  }
  for (const s of [-1, 1]) parts.push(baked(BOX(74, 3.4, 5), 0, 21.5, s * 17));
  parts.push(baked(BOX(30, 3.2, 38), -18, 21.6, 0));          // half the roof still on
  g.add(new THREE.Mesh(merge(parts), stone));
  for (let i = 0; i < 7; i++) {                               // fallen drums in the grass
    const d = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 6, 9), stone2);
    d.position.set(-30 + i * 11, 1.6, 30 + (i % 3) * 6);
    d.rotation.set(Math.PI / 2, i * 0.7, 0); g.add(d);
  }
});

// 8 — the wreck, half in the surf
place('THE WRECK OF THE MARGARET', c => c.y > 1 && c.y < 16 && c.slope < 0.13
  && waterFrac(c.x, c.z, 260, 10) > 0.3, g => {
  const hull = new THREE.Mesh(BOX(15, 13, 62), rust);
  hull.position.y = 4; hull.rotation.set(0.10, 0, 0.34); g.add(hull);
  const stern = new THREE.Mesh(BOX(14, 11, 16), toon(0x6b4a3a));
  stern.position.set(6, 5, -44); stern.rotation.set(-0.16, 0.3, 0.5); g.add(stern);
  for (const z of [-8, 14]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.1, 34, 8), toon(0x7a5a44));
    mast.position.set(-2, 16, z); mast.rotation.z = 0.42; g.add(mast);
  }
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.4, 11, 10), dark);
  funnel.position.set(1, 15, -18); funnel.rotation.z = 0.34; g.add(funnel);
}, [34, 26]);

// 9 — the farm
place('HOLLOWAY GRANGE', plains, g => {
  for (let i = 0; i < 5; i++) {
    const s2 = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 26, 12), toon(0xd9d3c4));
    s2.position.set(i * 13 - 26, 13, 0); g.add(s2);
    const cap3 = new THREE.Mesh(new THREE.ConeGeometry(6, 5, 12), toon(0x8d5f45));
    cap3.position.set(i * 13 - 26, 28, 0); g.add(cap3);
  }
  const barn = new THREE.Mesh(BOX(34, 12, 20), toon(0x9c4b3a)); barn.position.set(0, 6, 38); g.add(barn);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 34, 12, 1, false, 0, Math.PI)
    .rotateZ(-Math.PI / 2), toon(0x6b4a2f));
  roof.rotation.y = Math.PI / 2; roof.position.set(0, 12, 38); g.add(roof);
});

// 10 — the obelisk
place('THE OBELISK', c => plains(c) || desert(c), g => {
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(46, 46, 1.2, 24), toon(0xc8c2b2));
  plaza.position.y = 0.6; g.add(plaza);
  const base = new THREE.Mesh(BOX(14, 6, 14), stone2); base.position.y = 4; g.add(base);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 5.2, 58, 4), stone);
  shaft.position.y = 36; shaft.rotation.y = Math.PI / 4; g.add(shaft);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(4.2, 9, 4), toon(0xffd23b));
  tip.position.y = 69.5; tip.rotation.y = Math.PI / 4; g.add(tip);
}, [16, 74]);

// 11 — the airliner that did not make it
place('FLIGHT 19', desert, g => {
  const fore = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.6, 34, 14).rotateX(Math.PI / 2), white);
  fore.position.set(0, 3.4, 16); fore.rotation.z = 0.16; g.add(fore);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(4.2, 9, 14).rotateX(Math.PI / 2), white);
  nose.position.set(0, 3.6, 37); g.add(nose);
  const aft = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 4.2, 26, 14).rotateX(Math.PI / 2), white);
  aft.position.set(7, 2.8, -18); aft.rotation.set(0.12, 0.42, 0.5); g.add(aft);
  const fin = new THREE.Mesh(BOX(1, 16, 12), toon(0xd8483a));
  fin.position.set(11, 10, -30); fin.rotation.set(0, 0.42, 0.5); g.add(fin);
  const wing = new THREE.Mesh(BOX(58, 1.6, 12), white);
  wing.position.set(-6, 2, 8); wing.rotation.set(0, 0.1, 0.08); g.add(wing);
  const wing2 = new THREE.Mesh(BOX(26, 1.5, 10), white);
  wing2.position.set(34, 1.4, -26); wing2.rotation.set(0, 1.1, 0.3); g.add(wing2);
  for (const s of [-1, 1]) {
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 8, 10).rotateX(Math.PI / 2), toon(0x8f99a6));
    eng.position.set(s * 17 - 6, 1.4, 12); g.add(eng);
  }
});

// 12 — the observatory
place('STARFALL OBSERVATORY', c => c.y > 330 && c.slope < 0.22, g => {
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(13, 14, 15, 16), white);
  drum.position.y = 7.5; g.add(drum);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(13, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2),
    toon(0xdfe4ea));
  dome.position.y = 15; g.add(dome);
  const slit = new THREE.Mesh(BOX(3.4, 15, 14), toon(0x243049));
  slit.position.set(0, 20, 5); slit.rotation.x = 0.35; g.add(slit);
  const wing3 = new THREE.Mesh(BOX(26, 7, 12), toon(0xc9ccd2)); wing3.position.set(24, 3.5, 0); g.add(wing3);
}, [16, 30]);

// 13 — the arch. The one everybody tries to fly through, so the solids are the two legs
// and the ring of stone itself, not the forty-metre disc that used to swallow the gap.
const A_R = 34, A_TH = 11, A_RAD = 13, A_D = 15, A_LEG = A_TH + 6;
place('THE STONE ARCH', c => desert(c) || (c.wMtn > 0.4 && c.slope < 0.2), g => {
  const parts = [];
  for (let i = 0; i <= 14; i++) {                             // voussoirs round a half circle
    const a = (i / 14) * Math.PI;
    parts.push(baked(BOX(A_TH, A_RAD, A_D), Math.cos(a) * A_R, Math.sin(a) * A_R, 0, 0, 0, -a + Math.PI / 2));
  }
  for (const s of [-1, 1]) parts.push(baked(BOX(A_LEG, 16, 19), s * A_R, 8, 0));
  g.add(new THREE.Mesh(merge(parts), toon(0xc08f52)));
}, [40, 50, [
  hring(0, 0, 0, A_R - A_RAD / 2, A_R + A_RAD / 2, A_D / 2, 0),
  hbox(-A_R, 0, A_LEG / 2, 9.5, 0, 16),
  hbox(A_R, 0, A_LEG / 2, 9.5, 0, 16),
]]);

// =================================================================
//  …AND THIRTY MORE, SPREAD OVER THE WHOLE WORLD
//  Same machinery, but anchored round the towns and outfields rather than the home
//  strip, so the map has something to find wherever you happen to be. Every one is a
//  silhouette first — the test for all of these is whether you know what it is from a
//  thousand feet without being told.
// =================================================================
const brick = toon(0x9c5a48), lead = toon(0x71767e), glassy = toon(0x2f4a6a),
      copper = toon(0x4e9c8a), canvasM = toon(0xe4dcc8), grass2 = toon(0x4f8f42);
const P = (name, want, build, hit, faceWater) => place(name, want, build, hit, true, faceWater);
const G = (name, want, build, hit, faceWater) => place(name, want, build, hit, 'global', faceWater);
const mountain = c => c.wMtn > 0.42 && c.y > 260;
const coastal = c => c.y > 2 && c.y < 34 && c.slope < 0.14 && waterFrac(c.x, c.z, 300, 12) > 0.35;
const openSea = c => c.y < -8 && waterFrac(c.x, c.z, 600, 12) > 0.9;
const forest = c => c.wPl > 0.4 && c.y > 30 && c.y < 400 && c.slope < 0.22
  && forestF(c.x, c.z) > 0.56;

// ---- desert ----
P('THE SPHINX', desert, g => {
  const body = new THREE.Mesh(BOX(22, 16, 62), sandst); body.position.y = 8; g.add(body);
  const head = new THREE.Mesh(BOX(15, 18, 14), sandst); head.position.set(0, 22, 24); g.add(head);
  const hd = new THREE.Mesh(BOX(20, 6, 17), toon(0xc9a86a)); hd.position.set(0, 27, 23); g.add(hd);
  for (const s2 of [-1, 1]) {
    const paw = new THREE.Mesh(BOX(7, 7, 26), sandst); paw.position.set(s2 * 7, 3.5, 44); g.add(paw);
  }
}, [34, 32]);

P('OASIS CARAVANSERAI', desert, g => {
  const w = [];
  for (const [dx, dz, l, ang] of [[0, -34, 68, 0], [0, 34, 68, 0], [-34, 0, 68, Math.PI / 2], [34, 0, 68, Math.PI / 2]])
    w.push(baked(BOX(l, 9, 3), dx, 4.5, dz, 0, ang, 0));
  for (const [cx, cz] of [[-34, -34], [34, -34], [-34, 34], [34, 34]])
    w.push(baked(new THREE.CylinderGeometry(4, 4.6, 14, 10), cx, 7, cz));
  g.add(new THREE.Mesh(merge(w), sandst));
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(13, 13, 0.6, 18), toon(0x3f8fc4));
  pool.position.y = 0.4; g.add(pool);
  for (let i = 0; i < 9; i++) {                       // date palms round the water
    const a = i / 9 * 6.283, r = 18 + (i % 3) * 4;
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 11, 6), toon(0x8a6a44));
    tr.position.set(Math.cos(a) * r, 5.5, Math.sin(a) * r);
    tr.rotation.z = (i % 2 ? 1 : -1) * 0.12; g.add(tr);
    for (let f = 0; f < 5; f++) {
      const fr = new THREE.Mesh(BOX(9, 0.4, 2.4), toon(0x4f8f42));
      fr.position.set(Math.cos(a) * r + Math.cos(f / 5 * 6.283) * 4, 11.5, Math.sin(a) * r + Math.sin(f / 5 * 6.283) * 4);
      fr.rotation.y = f / 5 * 6.283; fr.rotation.z = 0.3; g.add(fr);
    }
  }
});

P('SOLARIS ARRAY', desert, g => {
  const tow = new THREE.Mesh(new THREE.CylinderGeometry(4, 7, 88, 12), white);
  tow.position.y = 44; g.add(tow);
  const rec = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 12, 12), toon(0xffd23b));
  rec.position.y = 92; g.add(rec);
  const mir = [];
  for (let ring = 1; ring <= 4; ring++) {
    const n = 10 + ring * 6, r = 40 + ring * 32;
    for (let i = 0; i < n; i++) {
      const a = i / n * 6.283 + ring * 0.2;
      mir.push(baked(BOX(7, 0.4, 5), Math.cos(a) * r, 4, Math.sin(a) * r, 0.5, -a, 0));
      mir.push(baked(BOX(0.6, 8, 0.6), Math.cos(a) * r, 2, Math.sin(a) * r));
    }
  }
  g.add(new THREE.Mesh(merge(mir), toon(0xbcd4e4)));
}, [12, 96]);

P('THE ZIGGURAT', desert, g => {
  for (let i = 0; i < 5; i++) {
    const w = 108 - i * 19, h = 11;
    const t = new THREE.Mesh(BOX(w, h, w), toon(i % 2 ? 0xc9a86a : 0xd8c08a));
    t.position.y = 5 - 4 + i * h; g.add(t);
  }
  const shrine = new THREE.Mesh(BOX(16, 12, 16), toon(0x9c5a48)); shrine.position.y = 57; g.add(shrine);
  const stair = new THREE.Mesh(BOX(13, 3, 62), toon(0xc9a86a));
  stair.position.set(0, 26, 46); stair.rotation.x = -0.72; g.add(stair);
}, [58, 64]);

P('PAD 39', c => desert(c) || plains(c), g => {
  const pad = new THREE.Mesh(BOX(66, 2, 66), toon(0x8f949c)); pad.position.y = 1; g.add(pad);
  const rk = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 62, 16), white);
  rk.position.y = 33; g.add(rk);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(4.4, 13, 16), white); nose.position.y = 70; g.add(nose);
  for (const s2 of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 40, 12), toon(0xd8483a));
    b.position.set(s2 * 7, 22, 0); g.add(b);
    const bn = new THREE.Mesh(new THREE.ConeGeometry(2.6, 7, 12), toon(0xd8483a));
    bn.position.set(s2 * 7, 45.5, 0); g.add(bn);
  }
  const gan = [];
  for (const [gx, gz] of [[13, 13], [13, -13], [20, 0]]) gan.push(baked(BOX(2.4, 74, 2.4), gx, 37, gz));
  for (let i = 1; i < 7; i++) gan.push(baked(BOX(18, 1.6, 28), 16, i * 11, 0));
  g.add(new THREE.Mesh(merge(gan), toon(0xc24a2a)));
}, [30, 78]);

P('BONNEVILLE FLATS', c => desert(c) && c.slope < 0.04, g => {
  const flat = new THREE.Mesh(new THREE.CylinderGeometry(190, 190, 0.5, 28), toon(0xefeade));
  flat.position.y = 0.3; g.add(flat);
  const line = new THREE.Mesh(BOX(3, 0.06, 330), toon(0x2b2f38)); line.position.y = 0.6; g.add(line);
  const car = new THREE.Mesh(merge([baked(new THREE.CylinderGeometry(1.5, 1.2, 17, 10).rotateX(Math.PI / 2), 0, 1.6, 0),
    baked(new THREE.ConeGeometry(1.5, 5, 10).rotateX(-Math.PI / 2), 0, 1.6, 11),
    baked(BOX(7, 0.5, 3), 0, 2.4, -7)]), toon(0xd8483a));
  car.position.set(0, 0, -40); g.add(car);
  for (let i = 0; i < 4; i++) {
    const h = new THREE.Mesh(BOX(7, 4, 5), white); h.position.set(22, 2, -60 + i * 40); g.add(h);
  }
});

P('THE IMPACT CRATER', c => desert(c) && c.slope < 0.09, g => {
  const rim = [];
  for (let i = 0; i < 40; i++) {
    const a = i / 40 * 6.283, r = 150;
    rim.push(baked(BOX(26, 16 + (i % 4) * 5, 16), Math.cos(a) * r, 5, Math.sin(a) * r, 0, -a, 0.1));
  }
  g.add(new THREE.Mesh(merge(rim), toon(0xb08a5a)));
  const vc = new THREE.Mesh(BOX(20, 7, 13), white); vc.position.set(0, 3.5, 178); g.add(vc);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 6, 0, 6.283, 0, Math.PI / 2), white);
  dome.position.set(12, 7, 178); g.add(dome);
});

P('THE BONEYARD', desert, g => {
  for (let i = 0; i < 18; i++) {
    const rx = (i % 6) * 46 - 115, rz = ((i / 6) | 0) * 52 - 52;
    const f = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3, 30, 12).rotateX(Math.PI / 2), toon(0xd6d2c8));
    f.position.set(rx, 3, rz); g.add(f);
    const w = new THREE.Mesh(BOX(34, 1.2, 7), toon(0xd6d2c8)); w.position.set(rx, 2.6, rz); g.add(w);
    const t = new THREE.Mesh(BOX(0.9, 9, 6), toon(0x8f99a6)); t.position.set(rx, 7, rz - 13); g.add(t);
  }
});

// ---- mountain ----
P('CLIFFTOP MONASTERY', mountain, g => {
  const w = [];
  w.push(baked(BOX(46, 15, 30), 0, 7.5, 0));
  w.push(baked(BOX(20, 26, 18), -14, 13, 0));
  for (const s2 of [-1, 1]) w.push(baked(BOX(7, 34, 7), s2 * 19, 17, -10));
  g.add(new THREE.Mesh(merge(w), toon(0xd8d2c4)));
  const roof = new THREE.Mesh(BOX(50, 3, 34), toon(0x8d3a2f)); roof.position.y = 16; g.add(roof);
  const r2 = new THREE.Mesh(BOX(23, 3, 21), toon(0x8d3a2f)); r2.position.set(-14, 27, 0); g.add(r2);
  const stupa = new THREE.Mesh(new THREE.ConeGeometry(4, 12, 10), toon(0xffd23b));
  stupa.position.set(16, 22, 12); g.add(stupa);
}, [30, 36]);

P('WHITE PASS RESORT', c => c.wMtn > 0.35 && c.y > 300 && c.y < 700 && c.slope < 0.3, g => {
  for (let i = 0; i < 6; i++) {
    const ch = new THREE.Mesh(BOX(13, 7, 10), toon(0x8a6a4a));
    ch.position.set((i % 3) * 22 - 22, 3.5, ((i / 3) | 0) * 24 - 12); g.add(ch);
    const rf = new THREE.Mesh(new THREE.ConeGeometry(10, 6, 4), toon(0xe8e4dc));
    rf.position.set((i % 3) * 22 - 22, 10, ((i / 3) | 0) * 24 - 12); rf.rotation.y = Math.PI / 4; g.add(rf);
  }
  const lodge = new THREE.Mesh(BOX(34, 12, 18), toon(0x6b4a2f)); lodge.position.set(0, 6, -46); g.add(lodge);
  for (let i = 0; i < 7; i++) {                       // lift pylons marching up the hill
    const p2 = new THREE.Mesh(BOX(1.6, 16, 1.6), lead);
    p2.position.set(46, 8 + i * 2, -70 + i * 34); g.add(p2);
    const arm = new THREE.Mesh(BOX(9, 1, 1), lead); arm.position.set(46, 16 + i * 2, -70 + i * 34); g.add(arm);
  }
});

P('HIGH DAM', c => c.wMtn > 0.4 && c.y > 200 && c.slope > 0.12 && c.slope < 0.5, g => {
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(90, 90, 66, 28, 1, true, -0.7, 1.4),
    new THREE.MeshToonMaterial({ color: 0xcfd2d6, gradientMap: RAMP, side: THREE.DoubleSide }));
  wall.position.y = 20; g.add(wall);
  const crest = new THREE.Mesh(new THREE.CylinderGeometry(92, 92, 4, 28, 1, true, -0.7, 1.4),
    new THREE.MeshToonMaterial({ color: 0x9aa0a8, gradientMap: RAMP, side: THREE.DoubleSide }));
  crest.position.y = 54; g.add(crest);
  const house = new THREE.Mesh(BOX(24, 10, 14), toon(0xc9ccd2)); house.position.set(0, 5, -74); g.add(house);
}, [92, 58]);

P('THE SUMMIT CROSS', c => c.wMtn > 0.55 && c.y > 520, g => {
  const cairn = new THREE.Mesh(new THREE.ConeGeometry(7, 6, 9), stone2); cairn.position.y = 3; g.add(cairn);
  const up = new THREE.Mesh(BOX(1.8, 26, 1.8), toon(0x6b4a2f)); up.position.y = 18; g.add(up);
  const arm = new THREE.Mesh(BOX(12, 1.8, 1.8), toon(0x6b4a2f)); arm.position.y = 25; g.add(arm);
}, [10, 32]);

P('THE CARVED KINGS', c => c.wMtn > 0.5 && c.y > 380 && c.slope > 0.18, g => {
  const face = (dx) => {
    const f = new THREE.Group(); f.position.set(dx, 26, 0);
    f.add(new THREE.Mesh(BOX(19, 24, 12), stone));
    const br = new THREE.Mesh(BOX(20, 4, 3), stone2); br.position.set(0, 7, 6); f.add(br);
    for (const s2 of [-1, 1]) {
      const eye = new THREE.Mesh(BOX(4.4, 3.4, 2), stone2); eye.position.set(s2 * 4.6, 3, 6.4); f.add(eye);
    }
    const nose = new THREE.Mesh(BOX(4, 9, 5), stone); nose.position.set(0, -2, 7.5); f.add(nose);
    const mouth = new THREE.Mesh(BOX(9, 2, 2), stone2); mouth.position.set(0, -9, 6.4); f.add(mouth);
    return f;
  };
  for (const dx of [-33, -11, 11, 33]) g.add(face(dx));
  const cliff = new THREE.Mesh(BOX(104, 40, 10), stone2); cliff.position.set(0, 20, -8); g.add(cliff);
}, [56, 46]);

// ---- coast and sea ----
P('STILT VILLAGE', coastal, g => {
  for (let i = 0; i < 11; i++) {
    const hx = (i % 4) * 17 - 26, hz = ((i / 4) | 0) * 19 - 14;
    for (const [px, pz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
      const leg = new THREE.Mesh(BOX(0.8, 12, 0.8), toon(0x6b4a2f));
      leg.position.set(hx + px, 2, hz + pz); g.add(leg);
    }
    const hut = new THREE.Mesh(BOX(11, 5, 10), toon(0xc8b48a)); hut.position.set(hx, 10.5, hz); g.add(hut);
    const rf = new THREE.Mesh(new THREE.ConeGeometry(9, 4.5, 4), toon(0x8a6a44));
    rf.position.set(hx, 15, hz); rf.rotation.y = Math.PI / 4; g.add(rf);
  }
  const jetty = new THREE.Mesh(BOX(6, 1, 90), toon(0x7a5a44)); jetty.position.set(30, 9, 0); g.add(jetty);
}, null, 300);

P('PLATFORM SEVEN', openSea, g => {
  for (const [px, pz] of [[-17, -17], [17, -17], [-17, 17], [17, 17]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3, 46, 10), rust);
    leg.position.set(px, 20, pz); g.add(leg);
  }
  const deck = new THREE.Mesh(BOX(48, 4, 48), toon(0x8f949c)); deck.position.y = 44; g.add(deck);
  const block = new THREE.Mesh(BOX(20, 14, 24), toon(0xd8c84a)); block.position.set(-11, 53, 0); g.add(block);
  const derrick = [];
  for (const [px, pz] of [[8, -8], [24, -8], [8, 8], [24, 8]]) derrick.push(baked(BOX(1.6, 44, 1.6), px, 68, pz));
  for (let i = 1; i < 5; i++) derrick.push(baked(BOX(18, 1.2, 18), 16, 46 + i * 10, 0));
  g.add(new THREE.Mesh(merge(derrick), rust));
  const flare = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 26, 8), lead);
  flare.position.set(28, 59, 20); flare.rotation.z = -0.4; g.add(flare);
}, [30, 92]);

P('THE DROWNED KING', c => c.y > -14 && c.y < 3 && waterFrac(c.x, c.z, 260, 10) > 0.6, g => {
  const torso = new THREE.Mesh(BOX(11, 26, 7), stone2); torso.position.y = 15; torso.rotation.z = 0.22; g.add(torso);
  const head = new THREE.Mesh(BOX(6, 7, 6), stone2); head.position.set(-4, 31, 0); head.rotation.z = 0.22; g.add(head);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 3, 8), toon(0xffd23b));
  crown.position.set(-5, 35, 0); g.add(crown);
  const arm = new THREE.Mesh(BOX(3.4, 20, 3.4), stone2);
  arm.position.set(7, 26, 0); arm.rotation.z = -0.7; g.add(arm);
}, [12, 38]);

P('HARBOUR MARINA', coastal, g => {
  const quay = new THREE.Mesh(BOX(96, 3, 12), toon(0xb9b4a8)); quay.position.y = 1.5; g.add(quay);
  for (let i = 0; i < 5; i++) {
    const pon = new THREE.Mesh(BOX(4, 1.4, 46), toon(0xc8c2b2));
    pon.position.set(-40 + i * 20, 1, 30); g.add(pon);
    for (let b = 0; b < 4; b++) {
      const hull = new THREE.Mesh(merge([baked(BOX(3.4, 2.2, 11), 0, 0, 0),
        baked(new THREE.ConeGeometry(1.7, 4, 8).rotateX(-Math.PI / 2), 0, 0, 7)]), white);
      hull.position.set(-40 + i * 20 + (b % 2 ? 5 : -5), 1, 14 + ((b / 2) | 0) * 20); g.add(hull);
      const mast = new THREE.Mesh(BOX(0.4, 15, 0.4), white);
      mast.position.set(hull.position.x, 8, hull.position.z); g.add(mast);
    }
  }
  const cap = new THREE.Mesh(BOX(14, 8, 10), toon(0xd8483a)); cap.position.set(-52, 4, 0); g.add(cap);
}, null, 320);

P('SEA FORT', coastal, g => {
  const base = new THREE.Mesh(new THREE.CylinderGeometry(26, 30, 13, 16), stone2);
  base.position.y = 5; g.add(base);
  const keep = new THREE.Mesh(new THREE.CylinderGeometry(18, 20, 17, 16), stone);
  keep.position.y = 20; g.add(keep);
  const batt = [];
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * 6.283;
    batt.push(baked(BOX(4.6, 4, 3), Math.cos(a) * 19, 30, Math.sin(a) * 19, 0, -a, 0));
  }
  g.add(new THREE.Mesh(merge(batt), stone));
  const mast = new THREE.Mesh(BOX(0.6, 16, 0.6), lead); mast.position.y = 38; g.add(mast);
}, [30, 40]);

// The deck runs 135 m out to sea and the wheel sits at the far end, so the old r=26
// cylinder round the group origin covered the shore end and nothing else — the deck and
// the wheel were both flown straight through. The bounds now reach the end of the pier
// and the solids inside it are real: deck, hall, two rows of piles, and the wheel as a
// disc, because twelve spokes crossing the hub make the hoop a wall, not a hoop.
const PIER_HIT = [
  hbox(0, 60, 10, 75, 6, 8),                          // deck
  hbox(0, 34, 8.5, 13, 8, 17),                        // amusement hall
  hring(0, 34, 96, 0, 25.1, 1.7, 8.9),                // the wheel, spokes and all
];
for (let i = 0; i < 10; i++) for (const s2 of [-1, 1]) PIER_HIT.push(hbox(s2 * 8, i * 15, 0.6, 0.6, -8, 8));
for (const s2 of [-1, 1]) PIER_HIT.push(hbox(s2 * 12, 96, 1, 1, 4, 34));
P('PIER AMUSEMENTS', coastal, g => {
  const deck = new THREE.Mesh(BOX(20, 2, 150), toon(0xc8b48a)); deck.position.set(0, 7, 60); g.add(deck);
  for (let i = 0; i < 10; i++) for (const s2 of [-1, 1]) {
    const pile = new THREE.Mesh(BOX(1.2, 16, 1.2), toon(0x6b4a2f));
    pile.position.set(s2 * 8, 0, i * 15); g.add(pile);
  }
  const wheel = new THREE.Group(); wheel.position.set(0, 34, 96);
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(24, 1.1, 6, 28), toon(0xd8483a)));
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * 6.283;
    const sp = new THREE.Mesh(BOX(0.6, 48, 0.6), lead); sp.rotation.z = a; wheel.add(sp);
    const car = new THREE.Mesh(BOX(4, 4, 3.4), toon([0xffd23b, 0x3f8fc4, 0x4f9440][i % 3]));
    car.position.set(Math.cos(a) * 24, Math.sin(a) * 24, 0); wheel.add(car);
  }
  g.add(wheel); spinners.push({ o: wheel, spd: 0.12 });
  for (const s2 of [-1, 1]) {
    const leg = new THREE.Mesh(BOX(2, 30, 2), lead); leg.position.set(s2 * 12, 19, 96); g.add(leg);
  }
  const hall = new THREE.Mesh(BOX(17, 9, 26), toon(0xe8e4dc)); hall.position.set(0, 12.5, 34); g.add(hall);
}, [140, 60, PIER_HIT], 340);

P('THE LEVIATHAN', c => c.y > 1 && c.y < 12 && waterFrac(c.x, c.z, 240, 10) > 0.3, g => {
  const spine = [];
  for (let i = 0; i < 26; i++) {
    const t = i / 25, w = Math.sin(t * Math.PI) * 9 + 1.4;
    spine.push(baked(BOX(1.6, 2.2, 3.4), 0, 6 + Math.sin(t * Math.PI) * 3, -46 + i * 3.7));
    if (i > 3 && i < 20) for (const s2 of [-1, 1])
      spine.push(baked(BOX(0.9, w, 0.9), s2 * w * 0.5, 6 - w * 0.3 + Math.sin(t * Math.PI) * 3, -46 + i * 3.7, s2 * 0.3, 0, 0));
  }
  g.add(new THREE.Mesh(merge(spine), toon(0xe4dfd2)));
  const skull = new THREE.Mesh(BOX(7, 6, 20), toon(0xe4dfd2)); skull.position.set(0, 5, 55); g.add(skull);
  const jaw = new THREE.Mesh(BOX(6, 2, 18), toon(0xd8d2c4)); jaw.position.set(0, 1.5, 54); jaw.rotation.x = 0.16; g.add(jaw);
}, null, 260);

// ---- plains, farmland and the works of man ----
P('ST AGNES CATHEDRAL', plains, g => {
  const nave = new THREE.Mesh(BOX(26, 26, 74), toon(0xd8d2c4)); nave.position.y = 13; g.add(nave);
  const tran = new THREE.Mesh(BOX(56, 20, 20), toon(0xd8d2c4)); tran.position.set(0, 10, -8); g.add(tran);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 74, 12, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), toon(0x5a7a8a));
  roof.rotation.y = Math.PI / 2; roof.position.y = 26; g.add(roof);
  for (const s2 of [-1, 1]) {
    const tw = new THREE.Mesh(BOX(13, 52, 13), toon(0xd8d2c4)); tw.position.set(s2 * 8, 26, 34); g.add(tw);
    const sp = new THREE.Mesh(new THREE.ConeGeometry(9.5, 34, 4), toon(0x5a7a8a));
    sp.position.set(s2 * 8, 69, 34); sp.rotation.y = Math.PI / 4; g.add(sp);
  }
  const rose = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 1, 14).rotateX(Math.PI / 2), toon(0x3f6fb0));
  rose.position.set(0, 26, 41); g.add(rose);
}, [40, 88]);

P('RAVENSKEEP CASTLE', c => plains(c) || (c.wMtn > 0.2 && c.y > 60 && c.slope < 0.2), g => {
  const w = [];
  for (const [dx, dz, l, ang] of [[0, -46, 92, 0], [0, 46, 92, 0], [-46, 0, 92, Math.PI / 2], [46, 0, 92, Math.PI / 2]])
    w.push(baked(BOX(l, 17, 5), dx, 8.5, dz, 0, ang, 0));
  g.add(new THREE.Mesh(merge(w), stone2));
  for (const [cx, cz] of [[-46, -46], [46, -46], [-46, 46], [46, 46]]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(8, 9, 30, 12), stone); t.position.set(cx, 15, cz); g.add(t);
    const c2 = new THREE.Mesh(new THREE.ConeGeometry(10, 13, 12), toon(0x5a4a6a)); c2.position.set(cx, 36, cz); g.add(c2);
  }
  const keep = new THREE.Mesh(BOX(34, 40, 30), stone); keep.position.y = 20; g.add(keep);
  const kr = new THREE.Mesh(new THREE.ConeGeometry(26, 16, 4), toon(0x5a4a6a));
  kr.position.y = 48; kr.rotation.y = Math.PI / 4; g.add(kr);
  const gate = new THREE.Mesh(BOX(15, 22, 9), stone); gate.position.set(0, 11, 46); g.add(gate);
}, [66, 56]);

P('THE SPEEDWAY', c => plains(c) && c.slope < 0.05, g => {
  const track = [];
  for (let i = 0; i < 56; i++) {
    const a = i / 56 * 6.283;
    const rx = 130, rz = 82;
    track.push(baked(BOX(17, 0.4, 17), Math.cos(a) * rx, 0.3, Math.sin(a) * rz, 0, -a, 0));
  }
  g.add(new THREE.Mesh(merge(track), toon(0x3b3f47)));
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(96, 96, 0.3, 26).scale(1, 1, 0.62), grass2);
  inner.position.y = 0.2; g.add(inner);
  const stand = new THREE.Mesh(BOX(120, 17, 22), toon(0xc9ccd2)); stand.position.set(0, 8.5, -122); g.add(stand);
  const roof2 = new THREE.Mesh(BOX(124, 2, 26), toon(0x8f949c)); roof2.position.set(0, 18, -124); g.add(roof2);
  for (let i = 0; i < 5; i++) {
    const l = new THREE.Mesh(BOX(1.4, 30, 1.4), lead); l.position.set(-80 + i * 40, 15, 108); g.add(l);
    const lb = new THREE.Mesh(BOX(9, 3, 2), toon(0xffd23b)); lb.position.set(-80 + i * 40, 31, 108); g.add(lb);
  }
});

P('LABYRINTH HALL', plains, g => {
  const hall = new THREE.Mesh(BOX(52, 15, 26), toon(0xd6c6a8)); hall.position.y = 7.5; g.add(hall);
  const rf = new THREE.Mesh(BOX(56, 3, 30), toon(0x6b4a2f)); rf.position.y = 16; g.add(rf);
  for (const s2 of [-1, 1]) {
    const w2 = new THREE.Mesh(BOX(15, 19, 20), toon(0xd6c6a8)); w2.position.set(s2 * 30, 9.5, 0); g.add(w2);
  }
  const hedge = [];                                   // a proper maze grid, seeded
  for (let i = -7; i <= 7; i++) for (let j = 0; j <= 13; j++) {
    if (hash2i(i * 71 + 3, j * 131 + 7) > 0.55) continue;
    hedge.push(baked(BOX(11, 4, 1.6), i * 11, 2, 40 + j * 11));
    if (hash2i(i * 17, j * 53) > 0.5) hedge.push(baked(BOX(1.6, 4, 11), i * 11 + 5.5, 2, 40 + j * 11 + 5.5));
  }
  g.add(new THREE.Mesh(merge(hedge), toon(0x3f7d3a)));
});

P('BALLOON MEADOW', plains, g => {
  for (let i = 0; i < 8; i++) {
    const bx = (i % 4) * 46 - 69, bz = ((i / 4) | 0) * 52 - 26;
    const h = 26 + hash2i(i, 9) * 22;
    const env = new THREE.Mesh(new THREE.SphereGeometry(13, 14, 10),
      toon([0xd8483a, 0xffd23b, 0x3f8fc4, 0x4f9440, 0xb84f8a][i % 5]));
    env.scale.set(1, 1.25, 1); env.position.set(bx, h, bz); g.add(env);
    const neck = new THREE.Mesh(new THREE.ConeGeometry(6, 9, 10), canvasM);
    neck.position.set(bx, h - 15, bz); neck.rotation.x = Math.PI; g.add(neck);
    const bask = new THREE.Mesh(BOX(4.4, 4, 4.4), toon(0x8a6a44)); bask.position.set(bx, h - 21, bz); g.add(bask);
    for (const [ox, oz] of [[-2, -2], [2, 2]]) {
      const rope = new THREE.Mesh(BOX(0.2, h - 23, 0.2), lead);
      rope.position.set(bx + ox, (h - 23) / 2, bz + oz); rope.rotation.z = ox * 0.03; g.add(rope);
    }
  }
});

P('THE CROP CIRCLES', c => plains(c) && c.slope < 0.05, g => {
  const rings = [];
  const add = (cx, cz, r) => {
    for (let i = 0; i < 34; i++) {
      const a = i / 34 * 6.283;
      rings.push(baked(BOX(r * 0.2, 0.3, 5), cx + Math.cos(a) * r, 0.2, cz + Math.sin(a) * r, 0, -a, 0));
    }
  };
  add(0, 0, 58); add(0, 0, 30); add(74, 40, 22); add(-66, -34, 17); add(50, -58, 13);
  g.add(new THREE.Mesh(merge(rings), toon(0xc9b47a)));
});

// Eleven piers carrying ten arches and a deck. It was a single 300 m solid disc, which
// made the most obviously flyable thing in the world a wall; now the arches are open and
// only the masonry is hard. Nineteen metres between piers, so it stays a dare.
const AQ_HIT = [hbox(0, 0, 143, 6, 47.5, 52.5), hbox(0, 0, 143, 2.5, 52.5, 55.5)];
for (let i = 0; i < 11; i++) {
  const x = i * 26 - 130;
  AQ_HIT.push(hbox(x, 0, 3.5, 4.5, 0, 34));
  if (i < 10) AQ_HIT.push(hring(x + 13, 34, 0, 13 - 2.2, 13 + 2.2, 4, 34));
}
P('THE AQUEDUCT', c => plains(c) || desert(c), g => {
  const parts = [];
  for (let i = 0; i < 11; i++) {
    const x = i * 26 - 130;
    parts.push(baked(BOX(7, 34, 9), x, 17, 0));
    if (i < 10) {                                     // the arch between each pier
      for (let k = 0; k <= 9; k++) {
        const a = (k / 9) * Math.PI;
        parts.push(baked(BOX(5, 4.4, 8), x + 13 - Math.cos(a) * 13, 34 + Math.sin(a) * 13, 0, 0, 0, -a + Math.PI / 2));
      }
    }
  }
  parts.push(baked(BOX(286, 5, 12), 0, 50, 0));
  parts.push(baked(BOX(286, 3, 5), 0, 54, 0));
  g.add(new THREE.Mesh(merge(parts), toon(0xc8bfa8)));
}, [150, 56, AQ_HIT]);

P('THE WINDMILLS', plains, g => {
  for (let i = 0; i < 5; i++) {
    const mx = i * 44 - 88;
    const tw = new THREE.Mesh(new THREE.CylinderGeometry(5, 8, 22, 10), toon(0xe4dcc8));
    tw.position.set(mx, 11, 0); g.add(tw);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(6.4, 7, 10), toon(0x6b4a2f));
    cap.position.set(mx, 25, 0); g.add(cap);
    const sail = new THREE.Group(); sail.position.set(mx, 24, 7);
    for (let b = 0; b < 4; b++) {
      const bl = new THREE.Mesh(BOX(2.6, 21, 0.5), canvasM);
      bl.position.set(Math.sin(b / 4 * 6.283) * 11, Math.cos(b / 4 * 6.283) * 11, 0);
      bl.rotation.z = -b / 4 * 6.283; sail.add(bl);
    }
    g.add(sail); spinners.push({ o: sail, spd: 0.5 + hash2i(i, 11) * 0.4 });
  }
});

P('COOLING TOWERS', plains, g => {
  for (let i = 0; i < 3; i++) {
    const tx = i * 62 - 62;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(21, 30, 62, 20, 1, true),
      new THREE.MeshToonMaterial({ color: 0xd2d6dc, gradientMap: RAMP, side: THREE.DoubleSide }));
    t.position.set(tx, 31, 0); g.add(t);
    const steam = new THREE.Mesh(new THREE.SphereGeometry(18, 10, 7), toon(0xf2f4f8));
    steam.position.set(tx, 70, 0); steam.scale.set(1, 0.55, 1); g.add(steam);
  }
  const hall = new THREE.Mesh(BOX(120, 26, 34), toon(0xb9bfc8)); hall.position.set(0, 13, 62); g.add(hall);
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(5, 6.4, 78, 12), toon(0xd8483a));
  stack.position.set(70, 39, 62); g.add(stack);
}, [80, 74]);

P('THE AMPHITHEATRE', c => plains(c) || desert(c), g => {
  const parts = [];
  for (let ring = 0; ring < 4; ring++) {
    const r = 46 + ring * 9, h = 9 + ring * 7;
    for (let i = 0; i < 40; i++) {
      const a = i / 40 * 6.283;
      parts.push(baked(BOX(9, h, 9), Math.cos(a) * r, h / 2, Math.sin(a) * r, 0, -a, 0));
    }
  }
  for (let i = 0; i < 40; i += 2) {                   // arcade openings on the outer face
    const a = i / 40 * 6.283, r = 73;
    parts.push(baked(BOX(5, 12, 5), Math.cos(a) * r, 6, Math.sin(a) * r, 0, -a, 0));
  }
  g.add(new THREE.Mesh(merge(parts), toon(0xd0c4a8)));
  const floor2 = new THREE.Mesh(new THREE.CylinderGeometry(42, 42, 0.6, 26), toon(0xc9a86a));
  floor2.position.y = 0.4; g.add(floor2);
}, [78, 40]);

P('GREAT NORTHERN STATION', plains, g => {
  const shed = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 96, 14, 1, false, 0, Math.PI).rotateZ(Math.PI / 2),
    new THREE.MeshToonMaterial({ color: 0x8fa4b4, gradientMap: RAMP, side: THREE.DoubleSide }));
  shed.rotation.y = Math.PI / 2; shed.position.y = 12; g.add(shed);
  const front = new THREE.Mesh(BOX(46, 22, 12), brick); front.position.set(0, 11, -50); g.add(front);
  const clock = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 1.4, 14).rotateX(Math.PI / 2), white);
  clock.position.set(0, 26, -55); g.add(clock);
  const twr = new THREE.Mesh(BOX(13, 40, 13), brick); twr.position.set(0, 20, -50); g.add(twr);
  for (let i = 0; i < 2; i++) {
    const rail = new THREE.Mesh(BOX(3, 0.4, 190), lead); rail.position.set(i * 12 - 6, 0.4, 40); g.add(rail);
  }
  const loco = new THREE.Mesh(merge([baked(new THREE.CylinderGeometry(3.4, 3.4, 17, 12).rotateX(Math.PI / 2), 0, 4, 0),
    baked(BOX(7, 8, 8), 0, 6, -10), baked(new THREE.CylinderGeometry(1.4, 2, 6, 10), 0, 9, 6)]), toon(0x2b2f38));
  loco.position.set(-6, 0, 20); g.add(loco);
}, [40, 46]);

P('THE FIRE LOOKOUT', forest, g => {
  const legs = [];
  for (const [px, pz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) legs.push(baked(BOX(1, 26, 1), px, 13, pz));
  for (let i = 1; i < 4; i++) { legs.push(baked(BOX(12, 0.7, 1), 0, i * 7, 5)); legs.push(baked(BOX(1, 0.7, 12), 5, i * 7, 0)); }
  g.add(new THREE.Mesh(merge(legs), toon(0x8a6a44)));
  const cab = new THREE.Mesh(BOX(13, 7, 13), toon(0xc8b48a)); cab.position.y = 29; g.add(cab);
  const rf = new THREE.Mesh(new THREE.ConeGeometry(11, 4, 4), toon(0x6b4a2f));
  rf.position.y = 34; rf.rotation.y = Math.PI / 4; g.add(rf);
  const rail = new THREE.Mesh(BOX(17, 0.6, 17), toon(0x8a6a44)); rail.position.y = 26; g.add(rail);
});

P('THE SAWMILL', forest, g => {
  const shed = new THREE.Mesh(BOX(40, 13, 22), toon(0x8a5a3a)); shed.position.y = 6.5; g.add(shed);
  const rf = new THREE.Mesh(BOX(44, 2, 26), toon(0x5a4a3a)); rf.position.y = 14; g.add(rf);
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.6, 22, 10), toon(0x40444c));
  stack.position.set(14, 24, 0); g.add(stack);
  const logs = [];
  for (let i = 0; i < 22; i++) {
    const r = 1.5, row = (i / 6) | 0;
    logs.push(baked(new THREE.CylinderGeometry(r, r, 15, 8).rotateZ(Math.PI / 2),
      -30 + (i % 6) * 3.4, 1.6 + row * 2.8, 26 + row * 1.4));
  }
  g.add(new THREE.Mesh(merge(logs), toon(0x9c7a52)));
  const pond = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 0.5, 16), toon(0x3f6f8f));
  pond.position.set(-34, 0.3, -22); g.add(pond);
});

P('THE MEGALITH AVENUE', c => plains(c) || (c.wAr > 0.3 && c.slope < 0.08), g => {
  const parts = [];
  for (let i = 0; i < 22; i++) for (const s2 of [-1, 1]) {
    const h = 9 + (i % 4) * 2.4;
    parts.push(baked(BOX(3.4, h, 2.4), s2 * 13, h / 2, -140 + i * 13));
  }
  parts.push(baked(BOX(13, 3.4, 4), 0, 12, 140));
  for (const s2 of [-1, 1]) parts.push(baked(BOX(4.4, 13, 4.4), s2 * 5, 6.5, 140));
  g.add(new THREE.Mesh(merge(parts), stone2));
});

P('THE GOLDEN PAGODA', c => plains(c) || forest(c), g => {
  for (let i = 0; i < 6; i++) {
    const w = 26 - i * 3.6;
    const body = new THREE.Mesh(BOX(w, 7, w), toon(0xb8483a)); body.position.y = 4 + i * 10; g.add(body);
    const eave = new THREE.Mesh(new THREE.ConeGeometry(w * 0.95, 5, 4), toon(0xffd23b));
    eave.position.y = 10 + i * 10; eave.rotation.y = Math.PI / 4; g.add(eave);
  }
  const spire = new THREE.Mesh(new THREE.ConeGeometry(2.4, 17, 8), toon(0xffd23b));
  spire.position.y = 70; g.add(spire);
}, [18, 76]);

P('THE QUARRY', c => (c.wMtn > 0.3 || c.wPl > 0.4) && c.y > 60 && c.slope < 0.25, g => {
  for (let i = 0; i < 5; i++) {                       // stepped benches cut into the hill
    const t = new THREE.Mesh(new THREE.CylinderGeometry(70 - i * 12, 70 - i * 12, 8, 18), toon(0xc4c0b4));
    t.position.y = -4 - i * 7; g.add(t);
  }
  const belt = new THREE.Mesh(BOX(5, 2, 60), lead); belt.position.set(0, 6, 62); belt.rotation.x = 0.32; g.add(belt);
  const hop = new THREE.Mesh(new THREE.ConeGeometry(9, 13, 8), toon(0xd8483a));
  hop.position.set(0, 14, 92); hop.rotation.x = Math.PI; g.add(hop);
  for (let i = 0; i < 3; i++) {
    const tr = new THREE.Mesh(BOX(5, 3.4, 9), toon(0xd8c84a)); tr.position.set(-28 + i * 22, 2, 80); g.add(tr);
  }
});


// =================================================================
//  …AND FORTY-NINE MORE, ON A LATTICE OVER THE WHOLE WORLD
//  These use the global grid rather than the settlement anchors, so they reach the
//  empty quarters. Same rule as everything else: a silhouette you can name from a
//  thousand feet without being told.
// =================================================================
const tealM = toon(0x3f8f9c), pale = toon(0xe8e4dc), moss = toon(0x5f8f4a),
      slate = toon(0x5a6068), ochre = toon(0xc08f52), inkM = toon(0x2b2f38);

// ---- coast and sea ----
G('THE SEA STACKS', c => c.y > -8 && c.y < 20 && waterFrac(c.x, c.z, 300, 12) > 0.55, g => {
  for (let i = 0; i < 6; i++) {
    const a = i * 1.9, r = 30 + (i % 3) * 34, h = 34 + (i % 4) * 22;
    const st = new THREE.Mesh(new THREE.CylinderGeometry(7 - (i % 3), 12 - (i % 3), h, 7),
      i % 2 ? stone : stone2);
    st.position.set(Math.cos(a) * r, h / 2 - 6, Math.sin(a) * r); g.add(st);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(8 - (i % 3), 7 - (i % 3), 3, 7), moss);
    cap.position.set(Math.cos(a) * r, h - 6, Math.sin(a) * r); g.add(cap);
  }
});

G('THE BREAKWATER', coastal, g => {
  const arm = [];
  for (let i = 0; i < 34; i++) {
    const a = -0.9 + i * 0.055, r = 150;
    arm.push(baked(BOX(15, 11, 15), Math.cos(a) * r, 3, Math.sin(a) * r, 0, -a, 0));
  }
  g.add(new THREE.Mesh(merge(arm), toon(0x9aa0a8)));
  const lt = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 17, 10), toon(0xd8483a));
  lt.position.set(Math.cos(0.97) * 150, 16, Math.sin(0.97) * 150); g.add(lt);
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 4, 10), toon(0xffd23b));
  lamp.position.set(Math.cos(0.97) * 150, 26, Math.sin(0.97) * 150); g.add(lamp);
}, null, 340);

G('SUBMARINE PENS', coastal, g => {
  const blk = [];
  for (let i = 0; i < 4; i++) blk.push(baked(BOX(15, 20, 74), i * 21 - 32, 8, 0));
  blk.push(baked(BOX(96, 9, 82), 0, 22, -4));
  g.add(new THREE.Mesh(merge(blk), toon(0x8f9298)));
  for (let i = 0; i < 3; i++) {
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 44, 12).rotateX(Math.PI / 2), inkM);
    hull.position.set(i * 21 - 21, 1, 26); g.add(hull);
    const con = new THREE.Mesh(BOX(3, 7, 11), inkM); con.position.set(i * 21 - 21, 5, 22); g.add(con);
  }
}, [56, 32], 320);

G('SHIPBREAKERS YARD', coastal, g => {
  for (let i = 0; i < 4; i++) {
    const hull = new THREE.Mesh(BOX(17, 15, 74 - i * 14), i % 2 ? rust : toon(0x7a5a4a));
    hull.position.set(i * 30 - 45, 5, i * 12); hull.rotation.set(0.08, i * 0.22, 0.2 - i * 0.1); g.add(hull);
  }
  const crane = new THREE.Mesh(BOX(3, 46, 3), toon(0xd8c84a)); crane.position.set(56, 23, -30); g.add(crane);
  const jib = new THREE.Mesh(BOX(56, 2.4, 3), toon(0xd8c84a));
  jib.position.set(34, 44, -30); jib.rotation.z = 0.16; g.add(jib);
  const pile = new THREE.Mesh(BOX(30, 9, 22), toon(0x8a5a3a)); pile.position.set(-60, 4.5, -34); g.add(pile);
}, null, 300);

G('THE TIDAL MILL', coastal, g => {
  const mill = new THREE.Mesh(BOX(22, 15, 17), toon(0xd6c6a8)); mill.position.y = 7.5; g.add(mill);
  const rf = new THREE.Mesh(new THREE.ConeGeometry(17, 9, 4), toon(0x8d3a2f));
  rf.position.y = 19; rf.rotation.y = Math.PI / 4; g.add(rf);
  const wheel = new THREE.Group(); wheel.position.set(14, 6, 0);
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(8, 0.7, 6, 18), toon(0x6b4a2f)));
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * 6.283;
    const pad = new THREE.Mesh(BOX(1.4, 3.4, 5), toon(0x6b4a2f));
    pad.position.set(Math.cos(a) * 7, Math.sin(a) * 7, 0); pad.rotation.z = a; wheel.add(pad);
  }
  wheel.rotation.y = Math.PI / 2; g.add(wheel); spinners.push({ o: wheel, spd: 0.5 });
  const dam = new THREE.Mesh(BOX(70, 5, 5), stone2); dam.position.set(0, 2, 22); g.add(dam);
}, null, 300);

G('COASTGUARD STATION', coastal, g => {
  const house = new THREE.Mesh(BOX(20, 9, 13), white); house.position.y = 4.5; g.add(house);
  const rf = new THREE.Mesh(BOX(23, 2, 16), toon(0xd8483a)); rf.position.y = 10; g.add(rf);
  const slip = new THREE.Mesh(BOX(11, 1, 56), toon(0xc8c2b2));
  slip.position.set(0, 1, 36); slip.rotation.x = 0.09; g.add(slip);
  const mast = new THREE.Mesh(BOX(0.7, 26, 0.7), lead); mast.position.set(13, 13, -6); g.add(mast);
  const boat = new THREE.Mesh(BOX(4.4, 3, 13), toon(0xff7a2b)); boat.position.set(0, 3, 18); g.add(boat);
}, null, 300);

G('CONTAINER TERMINAL', coastal, g => {
  const quay = new THREE.Mesh(BOX(190, 4, 30), toon(0xb9b4a8)); quay.position.y = 2; g.add(quay);
  const cols = [0xd8483a, 0x3f8fc4, 0x4f9440, 0xffd23b, 0xc9ccd2, 0xb84f8a];
  for (let i = 0; i < 78; i++) {
    const bx = (i % 13) * 13 - 78, bz = -30 - ((i / 13) | 0) * 7, st = 1 + (i * 7 % 4);
    for (let k = 0; k < st; k++) {
      const box2 = new THREE.Mesh(BOX(12, 3, 6), toon(cols[(i + k) % 6]));
      box2.position.set(bx, 1.6 + k * 3.1, bz); g.add(box2);
    }
  }
  for (let i = 0; i < 3; i++) {
    const cx = i * 62 - 62;
    for (const s2 of [-1, 1]) {
      const leg = new THREE.Mesh(BOX(3, 44, 3), toon(0x3f8fc4)); leg.position.set(cx + s2 * 13, 22, 0); g.add(leg);
    }
    const beam = new THREE.Mesh(BOX(9, 4, 84), toon(0x3f8fc4)); beam.position.set(cx, 46, 14); g.add(beam);
  }
}, null, 320);

G('THE FLOATING MARKET', c => c.y > -6 && c.y < 4 && waterFrac(c.x, c.z, 200, 10) > 0.5, g => {
  const cols = [0xd8483a, 0xffd23b, 0x4f9440, 0x3f8fc4, 0xe8e4dc];
  for (let i = 0; i < 22; i++) {
    const a = (i * 2.4) % 6.283, r = 12 + (i % 5) * 11;
    const hull = new THREE.Mesh(BOX(3.4, 1.6, 12), toon(0x8a6a44));
    hull.position.set(Math.cos(a) * r, 0.6, Math.sin(a) * r); hull.rotation.y = a; g.add(hull);
    const awn = new THREE.Mesh(BOX(4.4, 0.4, 7), toon(cols[i % 5]));
    awn.position.set(Math.cos(a) * r, 3, Math.sin(a) * r); awn.rotation.y = a; g.add(awn);
  }
});

G('THE OYSTER BEDS', c => c.y > -7 && c.y < 2 && waterFrac(c.x, c.z, 220, 10) > 0.6, g => {
  const racks = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 5; j++)
    racks.push(baked(BOX(46, 0.8, 2.4), 0, 1.6, i * 9 - 50 + (j % 2) * 3, 0, 0, 0));
  for (let i = 0; i < 12; i++) for (let k = -2; k <= 2; k++)
    racks.push(baked(BOX(0.7, 4, 0.7), k * 20, 0.5, i * 9 - 50));
  g.add(new THREE.Mesh(merge(racks), toon(0x6b5a44)));
  const hut = new THREE.Mesh(BOX(9, 5, 7), toon(0xc8b48a)); hut.position.set(34, 5, -54); g.add(hut);
});

// ---- desert ----
// desert() itself demands slope < 0.10, so "desert AND steep" could never match and
// this was the one landmark of the fifty that never got built. Tombs want a cliff, so
// take the arid weight directly and ask for the slope the façade needs.
G('THE ROCK-CUT TOMBS', c => c.wAr > 0.38 && c.y > 20 && c.slope > 0.10 && c.slope < 0.5, g => {
  const cliff = new THREE.Mesh(BOX(120, 46, 15), toon(0xc08f52)); cliff.position.set(0, 20, -9); g.add(cliff);
  for (let i = 0; i < 3; i++) {
    const fx = i * 40 - 40;
    for (const s2 of [-1, 1]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.6, 20, 10), sandst);
      col.position.set(fx + s2 * 7, 10, 0); g.add(col);
    }
    const ped = new THREE.Mesh(BOX(24, 4.4, 6), sandst); ped.position.set(fx, 22, 0); g.add(ped);
    const gable = new THREE.Mesh(new THREE.ConeGeometry(14, 8, 4), sandst);
    gable.position.set(fx, 28, 0); gable.rotation.y = Math.PI / 4; g.add(gable);
    const door = new THREE.Mesh(BOX(6, 12, 3), inkM); door.position.set(fx, 6, -2); g.add(door);
  }
}, [64, 40]);

G('THE SALT WORKS', c => desert(c) && c.slope < 0.05, g => {
  const cols = [0xe8e2d2, 0xd8b0a0, 0xc9d8c0, 0xe0c8a0, 0xbfd0d8];
  for (let i = 0; i < 16; i++) {
    const px = (i % 4) * 64 - 96, pz = ((i / 4) | 0) * 64 - 96;
    const pan = new THREE.Mesh(BOX(58, 0.6, 58), toon(cols[i % 5]));
    pan.position.set(px, 0.4, pz); g.add(pan);
    const wall = new THREE.Mesh(BOX(60, 1.6, 2), toon(0xb9ac94));
    wall.position.set(px, 0.8, pz + 30); g.add(wall);
  }
  for (let i = 0; i < 5; i++) {
    const heap = new THREE.Mesh(new THREE.ConeGeometry(9, 13, 9), white);
    heap.position.set(i * 22 - 44, 6, 150); g.add(heap);
  }
  const shed = new THREE.Mesh(BOX(26, 8, 15), toon(0xb9ac94)); shed.position.set(0, 4, 176); g.add(shed);
});

G('THE BURIED ARMY', c => desert(c) || plains(c), g => {
  const pit = new THREE.Mesh(BOX(120, 8, 66), toon(0x9c7a52)); pit.position.y = -3.4; g.add(pit);
  const men = [];
  for (let r = 0; r < 6; r++) for (let i = 0; i < 22; i++) {
    const mx = i * 5 - 52, mz = r * 10 - 25;
    men.push(baked(BOX(1.7, 4.4, 1.2), mx, 2.2, mz));
    men.push(baked(new THREE.SphereGeometry(0.8, 6, 4), mx, 4.9, mz));
  }
  g.add(new THREE.Mesh(merge(men), toon(0xb08a5a)));
  const roof = new THREE.Mesh(BOX(130, 2, 76), toon(0xd6d2c4)); roof.position.y = 17; g.add(roof);
  for (const [cx, cz] of [[-60, -34], [60, -34], [-60, 34], [60, 34]]) {
    const col = new THREE.Mesh(BOX(3, 17, 3), toon(0xd6d2c4)); col.position.set(cx, 8.5, cz); g.add(col);
  }
}, [70, 20]);

G('THE MIRAGE HOTEL', desert, g => {
  const blk = new THREE.Mesh(BOX(46, 26, 20), toon(0xe0d4b8)); blk.position.y = 13; g.add(blk);
  for (let i = 1; i < 4; i++) {
    const band = new THREE.Mesh(BOX(48, 1.4, 22), toon(0xc8b48a)); band.position.y = i * 7; g.add(band);
  }
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 34, 14), toon(0xe0d4b8));
  tower.position.set(0, 17, 0); g.add(tower);
  const crown = new THREE.Mesh(new THREE.ConeGeometry(11, 10, 14), toon(0xd8483a));
  crown.position.y = 39; g.add(crown);
  const sign = new THREE.Mesh(BOX(22, 7, 1), toon(0xffd23b)); sign.position.set(0, 32, 11); g.add(sign);
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(13, 13, 0.6, 16), toon(0x3f8fc4));
  pool.position.set(0, 0.4, 30); g.add(pool);
}, [26, 46]);

G('THE DRIVE-IN', c => desert(c) || plains(c), g => {
  const screen = new THREE.Mesh(BOX(52, 26, 2), white); screen.position.set(0, 13, -40); g.add(screen);
  const frame = new THREE.Mesh(BOX(56, 3, 3), toon(0x8f949c)); frame.position.set(0, 27, -40); g.add(frame);
  for (const s2 of [-1, 1]) {
    const leg = new THREE.Mesh(BOX(3, 28, 3), toon(0x8f949c)); leg.position.set(s2 * 24, 14, -42); g.add(leg);
  }
  const posts = [];
  for (let r = 0; r < 5; r++) for (let i = 0; i < 12; i++)
    posts.push(baked(BOX(0.5, 2.4, 0.5), i * 8 - 44, 1.2, r * 15 + 4));
  g.add(new THREE.Mesh(merge(posts), lead));
  const kiosk = new THREE.Mesh(BOX(13, 6, 9), toon(0xd8483a)); kiosk.position.set(0, 3, 74); g.add(kiosk);
});

G('LAST CHANCE GAS', c => desert(c) || plains(c), g => {
  const shop = new THREE.Mesh(BOX(20, 7, 13), toon(0xe8e4dc)); shop.position.y = 3.5; g.add(shop);
  const canopy = new THREE.Mesh(BOX(30, 1.6, 17), toon(0xd8483a)); canopy.position.set(0, 9, 22); g.add(canopy);
  for (const [cx, cz] of [[-12, 15], [12, 15], [-12, 29], [12, 29]]) {
    const col = new THREE.Mesh(BOX(1.4, 9, 1.4), lead); col.position.set(cx, 4.5, cz); g.add(col);
  }
  for (const px of [-5, 5]) {
    const pump = new THREE.Mesh(BOX(2.4, 3.4, 1.6), toon(0xffd23b)); pump.position.set(px, 1.7, 22); g.add(pump);
  }
  const sign = new THREE.Mesh(BOX(9, 13, 1), toon(0xffd23b)); sign.position.set(-20, 17, 22); g.add(sign);
  const pole = new THREE.Mesh(BOX(1.4, 24, 1.4), lead); pole.position.set(-20, 12, 22); g.add(pole);
});

G('THE GHOST TOWN', desert, g => {
  for (let i = 0; i < 9; i++) {
    const side = i % 2 ? 1 : -1, n = (i / 2) | 0;
    const bx = side * 16, bz = n * 22 - 44;
    const w = new THREE.Mesh(BOX(15, 7 + (i % 3) * 2, 13), toon(0x9c8464));
    w.position.set(bx, 3.5 + (i % 3), bz); w.rotation.z = (i % 3 - 1) * 0.03; g.add(w);
    const face = new THREE.Mesh(BOX(16, 4, 1), toon(0xb09c78));
    face.position.set(bx - side * 6.5, 9 + (i % 3) * 2, bz); face.rotation.y = Math.PI / 2; g.add(face);
  }
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 9, 12), toon(0x7a5a44));
  tank.position.set(-36, 22, 10); g.add(tank);
  for (const [cx, cz] of [[-40, 6], [-32, 6], [-40, 14], [-32, 14]]) {
    const leg = new THREE.Mesh(BOX(1, 18, 1), toon(0x7a5a44)); leg.position.set(cx, 9, cz); g.add(leg);
  }
});

G('THE UFO SITE', desert, g => {
  const scar = new THREE.Mesh(new THREE.CylinderGeometry(40, 34, 3, 20), toon(0x8a7350));
  scar.position.y = -0.6; g.add(scar);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(17, 11, 4, 20), toon(0xc9ccd2));
  disc.position.set(4, 3, 0); disc.rotation.z = 0.3; g.add(disc);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(7, 14, 7, 0, 6.283, 0, Math.PI / 2), glassy);
  dome.position.set(4, 5, 0); dome.rotation.z = 0.3; g.add(dome);
  const fence = [];
  for (let i = 0; i < 30; i++) {
    const a = i / 30 * 6.283;
    fence.push(baked(BOX(0.4, 4, 0.4), Math.cos(a) * 52, 2, Math.sin(a) * 52));
  }
  g.add(new THREE.Mesh(merge(fence), lead));
  for (let i = 0; i < 3; i++) {
    const tent = new THREE.Mesh(new THREE.ConeGeometry(6, 6, 4), toon(0x4f7d4a));
    tent.position.set(-56 + i * 13, 3, 56); tent.rotation.y = Math.PI / 4; g.add(tent);
  }
}, [20, 12]);

// ---- mountain ----
G('THE FUNICULAR', c => mountain(c) && c.slope > 0.16, g => {
  const rail = [];
  for (let i = 0; i < 26; i++) rail.push(baked(BOX(7, 1.4, 9), 0, i * 5.4, i * 13 - 160));
  g.add(new THREE.Mesh(merge(rail), toon(0x6b4a2f)));
  const lower = new THREE.Mesh(BOX(15, 8, 15), toon(0xd6c6a8)); lower.position.set(0, 4, -170); g.add(lower);
  const upper = new THREE.Mesh(BOX(15, 8, 15), toon(0xd6c6a8)); upper.position.set(0, 143, 172); g.add(upper);
  const car = new THREE.Mesh(BOX(6, 5, 12), toon(0xd8483a));
  car.position.set(0, 56, -30); car.rotation.x = -0.39; g.add(car);
});

G('THE CABLE CAR', c => mountain(c) && c.y > 340, g => {
  for (const s2 of [-1, 1]) {
    const twr = [];
    for (const [px, pz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]])
      twr.push(baked(BOX(1.6, 40, 1.6), px, 20, pz + s2 * 150));
    twr.push(baked(BOX(15, 2.4, 15), 0, 40, s2 * 150));
    g.add(new THREE.Mesh(merge(twr), lead));
    const st = new THREE.Mesh(BOX(17, 9, 13), toon(0xd6d2c4)); st.position.set(0, 4.5, s2 * 162); g.add(st);
  }
  for (const off of [-4, 4]) {
    const cab = new THREE.Mesh(BOX(0.3, 0.3, 300), lead); cab.position.set(off, 40, 0); g.add(cab);
  }
  const car = new THREE.Mesh(BOX(6, 6, 9), toon(0xd8483a)); car.position.set(0, 34, 40); g.add(car);
  const hang = new THREE.Mesh(BOX(0.6, 6, 0.6), lead); hang.position.set(0, 38, 40); g.add(hang);
});

G('THE MINE HEADFRAME', c => (c.wMtn > 0.3 || c.y > 150) && c.slope < 0.28, g => {
  const fr = [];
  for (const [px, pz] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) fr.push(baked(BOX(1.6, 40, 1.6), px, 20, pz));
  for (let i = 1; i < 5; i++) fr.push(baked(BOX(16, 1, 16), 0, i * 9, 0));
  fr.push(baked(BOX(4, 1.6, 34), 0, 40, 14, 0.6, 0, 0));
  g.add(new THREE.Mesh(merge(fr), rust));
  const wheel = new THREE.Group(); wheel.position.set(0, 41, 0);
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(7, 0.9, 6, 18), lead));
  for (let i = 0; i < 6; i++) {
    const sp = new THREE.Mesh(BOX(0.6, 14, 0.6), lead); sp.rotation.z = i / 6 * 6.283; wheel.add(sp);
  }
  wheel.rotation.y = Math.PI / 2; g.add(wheel); spinners.push({ o: wheel, spd: 1.1 });
  const shed = new THREE.Mesh(BOX(26, 11, 17), toon(0x8a5a3a)); shed.position.set(26, 5.5, 0); g.add(shed);
  const heap = new THREE.Mesh(new THREE.ConeGeometry(30, 22, 12), toon(0x6b6152));
  heap.position.set(-52, 9, 26); g.add(heap);
}, [16, 46]);

G('THE SKI JUMP', c => c.wMtn > 0.35 && c.y > 320 && c.slope > 0.14, g => {
  const ramp = [];
  for (let i = 0; i < 22; i++) {
    const t = i / 21;
    ramp.push(baked(BOX(11, 2.4, 8), 0, 68 - t * t * 62, i * 7 - 74));
  }
  g.add(new THREE.Mesh(merge(ramp), white));
  const tower = [];
  for (const [px, pz] of [[-6, -78], [6, -78], [-6, -66], [6, -66]])
    tower.push(baked(BOX(1.6, 74, 1.6), px, 37, pz));
  g.add(new THREE.Mesh(merge(tower), lead));
  const out = new THREE.Mesh(BOX(30, 1.4, 90), white); out.position.set(0, 2, 110); out.rotation.x = -0.2; g.add(out);
  for (let i = 0; i < 4; i++) {
    const st = new THREE.Mesh(BOX(4, 7, 34), toon(0xc9ccd2)); st.position.set(26, 4 + i, 90 + i * 4); g.add(st);
  }
}, [14, 76]);

G('GLACIER CAMP', c => c.wMtn > 0.5 && c.y > 560, g => {
  for (let i = 0; i < 5; i++) {
    const hut = new THREE.Mesh(BOX(9, 5, 7), toon([0xd8483a, 0xffd23b, 0x3f8fc4][i % 3]));
    hut.position.set((i % 3) * 15 - 15, 2.5, ((i / 3) | 0) * 15); g.add(hut);
    const rf = new THREE.Mesh(new THREE.ConeGeometry(7.4, 3.4, 4), white);
    rf.position.set((i % 3) * 15 - 15, 6.4, ((i / 3) | 0) * 15); rf.rotation.y = Math.PI / 4; g.add(rf);
  }
  const dome = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 6, 0, 6.283, 0, Math.PI / 2), white);
  dome.position.set(22, 0, -14); g.add(dome);
  const mast = new THREE.Mesh(BOX(0.6, 20, 0.6), lead); mast.position.set(-24, 10, -12); g.add(mast);
  const flag = new THREE.Mesh(BOX(6, 3.4, 0.3), toon(0xd8483a)); flag.position.set(-21, 18, -12); g.add(flag);
});

G('THE HERMITS TOWER', c => mountain(c) && c.slope > 0.2, g => {
  const t = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 7, 34, 12), stone2);
  t.position.y = 17; g.add(t);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(7.4, 9, 12), toon(0x5a4a6a)); cap.position.y = 38; g.add(cap);
  for (let i = 0; i < 3; i++) {
    const w = new THREE.Mesh(BOX(1.4, 3.4, 1.4), inkM);
    w.position.set(Math.cos(i * 2.1) * 5.6, 12 + i * 8, Math.sin(i * 2.1) * 5.6); g.add(w);
  }
  const wall = [];
  for (let i = 0; i < 22; i++) {
    const a = i / 22 * 6.283;
    wall.push(baked(BOX(5, 5, 3), Math.cos(a) * 20, 2.5, Math.sin(a) * 20, 0, -a, 0));
  }
  g.add(new THREE.Mesh(merge(wall), stone));
}, [10, 44]);

G('THE GORGE BRIDGE', c => c.wMtn > 0.4 && c.y > 240 && c.slope > 0.2, g => {
  const deck = new THREE.Mesh(BOX(4.4, 0.7, 130), toon(0x8a6a44)); deck.position.y = 3; g.add(deck);
  for (const s2 of [-1, 1]) {
    const rope = new THREE.Mesh(BOX(0.3, 0.3, 132), inkM); rope.position.set(s2 * 2.4, 6, 0); g.add(rope);
    const tw = new THREE.Mesh(BOX(1.4, 15, 1.4), toon(0x6b4a2f)); tw.position.set(s2 * 3.4, 7, -64); g.add(tw);
    const tw2 = new THREE.Mesh(BOX(1.4, 15, 1.4), toon(0x6b4a2f)); tw2.position.set(s2 * 3.4, 7, 64); g.add(tw2);
  }
  for (let i = 0; i < 18; i++) {
    const h = new THREE.Mesh(BOX(0.2, 3, 0.2), inkM); h.position.set(2.4, 4.5, i * 7.4 - 63); g.add(h);
    const h2 = new THREE.Mesh(BOX(0.2, 3, 0.2), inkM); h2.position.set(-2.4, 4.5, i * 7.4 - 63); g.add(h2);
  }
});

G('THE HOT SPRINGS', c => c.y > 120 && c.slope < 0.2 && (c.wMtn > 0.2 || c.wPl > 0.4), g => {
  const cols = [0x4fc4c8, 0x7fd8b0, 0xd8c84a, 0xe8a04a];
  for (let i = 0; i < 7; i++) {
    const a = i * 1.6, r = 16 + (i % 4) * 15;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(11 - (i % 3) * 2, 13 - (i % 3) * 2, 3, 16), toon(0xe4dcc8));
    rim.position.set(Math.cos(a) * r, 0.6, Math.sin(a) * r); g.add(rim);
    const pool = new THREE.Mesh(new THREE.CylinderGeometry(9 - (i % 3) * 2, 9 - (i % 3) * 2, 0.6, 16), toon(cols[i % 4]));
    pool.position.set(Math.cos(a) * r, 2, Math.sin(a) * r); g.add(pool);
    const steam = new THREE.Mesh(new THREE.SphereGeometry(7 - (i % 3), 8, 6), toon(0xf2f4f8));
    steam.position.set(Math.cos(a) * r, 8, Math.sin(a) * r); steam.scale.set(1, 0.5, 1); g.add(steam);
  }
});

G('AVALANCHE GALLERY', c => c.wMtn > 0.45 && c.y > 300 && c.slope > 0.18, g => {
  const parts = [];
  for (let i = 0; i < 14; i++) {
    const z = i * 13 - 84;
    parts.push(baked(BOX(2.4, 9, 2.4), -7, 4.5, z));
    parts.push(baked(BOX(2.4, 13, 2.4), 8, 6.5, z));
  }
  parts.push(baked(BOX(22, 2, 184), 0, 11, 0, 0.12, 0, 0));
  g.add(new THREE.Mesh(merge(parts), toon(0xb9bcc2)));
  const road = new THREE.Mesh(BOX(13, 0.4, 184), toon(0x3b3f47)); road.position.y = 0.4; g.add(road);
}, [22, 14]);

// ---- forest ----
G('THE TREETOP WALK', forest, g => {
  const parts = [];
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * 6.283, r = 44;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    parts.push(baked(BOX(2.4, 26, 2.4), x, 13, z));
    const a2 = (i + 1) / 12 * 6.283;
    const x2 = Math.cos(a2) * r, z2 = Math.sin(a2) * r;
    const mx = (x + x2) / 2, mz = (z + z2) / 2;
    const L = Math.hypot(x2 - x, z2 - z);
    parts.push(baked(BOX(2.6, 0.6, L), mx, 24, mz, 0, -Math.atan2(x2 - x, z2 - z), 0));
  }
  g.add(new THREE.Mesh(merge(parts), toon(0x8a6a44)));
  const tow = new THREE.Mesh(new THREE.CylinderGeometry(4, 6, 40, 8), toon(0x8a6a44));
  tow.position.y = 20; g.add(tow);
  const plat = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 1, 10), toon(0x8a6a44));
  plat.position.y = 40; g.add(plat);
});

G('THE TRESTLE', c => forest(c) && c.slope > 0.10, g => {
  const parts = [];
  for (let i = 0; i < 15; i++) {
    const z = i * 13 - 91, h = 12 + Math.sin(i / 14 * Math.PI) * 26;
    for (const s2 of [-1, 1]) {
      parts.push(baked(BOX(1.4, h, 1.4), s2 * 5, h / 2, z));
      parts.push(baked(BOX(1.1, 1.1, 12), s2 * 5, h * 0.5, z, 0, 0, 0));
    }
    parts.push(baked(BOX(12, 1, 1.4), 0, h * 0.55, z));
  }
  parts.push(baked(BOX(11, 1.6, 196), 0, 34, 0));
  g.add(new THREE.Mesh(merge(parts), toon(0x6b4a2f)));
  for (const s2 of [-1, 1]) {
    const rail = new THREE.Mesh(BOX(0.7, 0.5, 196), lead); rail.position.set(s2 * 2.4, 35.2, 0); g.add(rail);
  }
}, [14, 38]);

G('THE HUNTING LODGE', forest, g => {
  const body = new THREE.Mesh(BOX(26, 11, 17), toon(0x6b4a2f)); body.position.y = 5.5; g.add(body);
  const rf = new THREE.Mesh(new THREE.ConeGeometry(20, 11, 4), toon(0x4a3a2a));
  rf.position.y = 16; rf.rotation.y = Math.PI / 4; g.add(rf);
  const chim = new THREE.Mesh(BOX(3.4, 13, 3.4), stone2); chim.position.set(9, 15, 0); g.add(chim);
  const porch = new THREE.Mesh(BOX(26, 0.7, 7), toon(0x8a6a44)); porch.position.set(0, 1, 12); g.add(porch);
  for (const px of [-11, 0, 11]) {
    const post = new THREE.Mesh(BOX(1, 6, 1), toon(0x8a6a44)); post.position.set(px, 4, 15); g.add(post);
  }
  const antler = new THREE.Mesh(BOX(6, 4, 0.4), toon(0xd6c6a8)); antler.position.set(0, 12, 8.8); g.add(antler);
});

G('THE STAVE CHURCH', c => forest(c) || plains(c), g => {
  for (let i = 0; i < 5; i++) {
    const w = 22 - i * 4;
    const tier = new THREE.Mesh(new THREE.ConeGeometry(w, 8, 4), toon(0x3a2f26));
    tier.position.y = 9 + i * 6.4; tier.rotation.y = Math.PI / 4; g.add(tier);
  }
  const body = new THREE.Mesh(BOX(20, 11, 20), toon(0x4a3a2a)); body.position.y = 5.5; g.add(body);
  const spire = new THREE.Mesh(new THREE.ConeGeometry(2.4, 13, 6), toon(0x3a2f26)); spire.position.y = 44; g.add(spire);
  const amb = new THREE.Mesh(BOX(30, 5, 30), toon(0x4a3a2a)); amb.position.y = 2.5; g.add(amb);
  const rf2 = new THREE.Mesh(new THREE.ConeGeometry(24, 6, 4), toon(0x3a2f26));
  rf2.position.y = 7.4; rf2.rotation.y = Math.PI / 4; g.add(rf2);
}, [18, 50]);

G('THE REDWOODS', forest, g => {
  for (let i = 0; i < 13; i++) {
    const a = i * 2.0, r = (i % 4) * 17 + 9;
    const h = 66 + (i % 5) * 16;
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 5.4, h, 9), toon(0x7a4a34));
    tr.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r); g.add(tr);
    for (let k = 0; k < 3; k++) {
      const can = new THREE.Mesh(new THREE.ConeGeometry(11 - k * 2.4, 20, 8), toon(0x2f6b2a));
      can.position.set(Math.cos(a) * r, h * 0.62 + k * 13, Math.sin(a) * r); g.add(can);
    }
  }
});

G('CHARCOAL CAMP', forest, g => {
  for (let i = 0; i < 4; i++) {
    const a = i * 1.6, r = 17;
    const mound = new THREE.Mesh(new THREE.ConeGeometry(7.4, 7, 12), toon(0x3a3226));
    mound.position.set(Math.cos(a) * r, 3.4, Math.sin(a) * r); g.add(mound);
    const smoke = new THREE.Mesh(new THREE.SphereGeometry(4, 8, 6), toon(0xd8d4cc));
    smoke.position.set(Math.cos(a) * r, 11, Math.sin(a) * r); smoke.scale.set(1, 0.6, 1); g.add(smoke);
  }
  const hut = new THREE.Mesh(new THREE.ConeGeometry(6, 8, 7), toon(0x6b5a3a)); hut.position.set(0, 4, -22); g.add(hut);
  const logs = [];
  for (let i = 0; i < 10; i++)
    logs.push(baked(new THREE.CylinderGeometry(1, 1, 9, 7).rotateZ(Math.PI / 2), 22, 1 + ((i / 4) | 0) * 2, (i % 4) * 2.4 - 4));
  g.add(new THREE.Mesh(merge(logs), toon(0x9c7a52)));
});

// ---- plains and farmland ----
G('VINEYARD TERRACES', c => plains(c) && c.slope > 0.05 && c.slope < 0.22, g => {
  const rows = [];
  for (let t = 0; t < 7; t++) {
    for (let i = 0; i < 9; i++) {
      rows.push(baked(BOX(90, 1.7, 0.6), 0, t * 5 + 1, t * 24 + i * 3.4 - 100));
    }
    rows.push(baked(BOX(94, 3.4, 2.4), 0, t * 5 - 1, t * 24 - 104));
  }
  g.add(new THREE.Mesh(merge(rows), moss));
  const house = new THREE.Mesh(BOX(17, 8, 13), toon(0xe0d4b8)); house.position.set(56, 4, -110); g.add(house);
  const rf = new THREE.Mesh(new THREE.ConeGeometry(13, 5, 4), toon(0xb8604a));
  rf.position.set(56, 10, -110); rf.rotation.y = Math.PI / 4; g.add(rf);
});

G('THE HORSE STUD', plains, g => {
  const f = [];
  for (const [cx, cz, w, d] of [[-60, 0, 100, 70], [60, 0, 100, 70], [0, 90, 200, 60]]) {
    for (let i = 0; i <= w; i += 10) {
      f.push(baked(BOX(1, 3.4, 1), cx - w / 2 + i, 1.7, cz - d / 2));
      f.push(baked(BOX(1, 3.4, 1), cx - w / 2 + i, 1.7, cz + d / 2));
    }
    f.push(baked(BOX(w, 0.5, 0.5), cx, 2.6, cz - d / 2));
    f.push(baked(BOX(w, 0.5, 0.5), cx, 2.6, cz + d / 2));
  }
  g.add(new THREE.Mesh(merge(f), white));
  const barn = new THREE.Mesh(BOX(40, 11, 20), toon(0x9c4b3a)); barn.position.set(0, 5.5, -60); g.add(barn);
  const rf = new THREE.Mesh(new THREE.CylinderGeometry(13, 13, 40, 12, 1, false, 0, Math.PI).rotateZ(-Math.PI / 2), toon(0x6b4a2f));
  rf.rotation.y = Math.PI / 2; rf.position.set(0, 11, -60); g.add(rf);
});

G('THE FLOWER FIELDS', c => plains(c) && c.slope < 0.06, g => {
  const cols = [0xd8483a, 0xffd23b, 0xe86ab0, 0xe8e4dc, 0x9c6ad8, 0xff8a3a];
  const strips = [];
  for (let i = 0; i < 14; i++) strips.push(baked(BOX(180, 0.5, 13), 0, 0.4, i * 15 - 100));
  const meshes = strips.map((geo, i) => new THREE.Mesh(geo, toon(cols[i % 6])));
  for (const m2 of meshes) g.add(m2);
  const shed = new THREE.Mesh(BOX(20, 7, 13), toon(0xd6c6a8)); shed.position.set(105, 3.5, -60); g.add(shed);
});

G('THE ORCHARD', plains, g => {
  const trees = [];
  for (let i = 0; i < 11; i++) for (let j = 0; j < 9; j++) {
    const tx = i * 15 - 75, tz = j * 15 - 60;
    trees.push(baked(new THREE.CylinderGeometry(0.7, 1, 4, 6), tx, 2, tz));
  }
  g.add(new THREE.Mesh(merge(trees), toon(0x6f5033)));
  const tops = [];
  for (let i = 0; i < 11; i++) for (let j = 0; j < 9; j++)
    tops.push(baked(new THREE.IcosahedronGeometry(4.4, 0), i * 15 - 75, 6.4, j * 15 - 60));
  g.add(new THREE.Mesh(merge(tops), toon(0x4f9440)));
  const press = new THREE.Mesh(BOX(17, 9, 13), toon(0xd6c6a8)); press.position.set(0, 4.5, 80); g.add(press);
  const rf = new THREE.Mesh(new THREE.ConeGeometry(13, 5, 4), toon(0x8d5f45));
  rf.position.set(0, 11, 80); rf.rotation.y = Math.PI / 4; g.add(rf);
});

G('GRAIN ELEVATOR ROW', plains, g => {
  for (let i = 0; i < 8; i++) {
    const el = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 40, 14), toon(0xd9d3c4));
    el.position.set(i * 13 - 46, 20, 0); g.add(el);
  }
  const head = new THREE.Mesh(BOX(110, 11, 15), toon(0xb9b0a0)); head.position.y = 45; g.add(head);
  const leg = new THREE.Mesh(BOX(6, 62, 6), toon(0xb9b0a0)); leg.position.set(-56, 31, 0); g.add(leg);
  const rail = new THREE.Mesh(BOX(130, 0.5, 3), lead); rail.position.set(0, 0.4, 22); g.add(rail);
}, [58, 56]);

G('THE VILLAGE GREEN', plains, g => {
  const green = new THREE.Mesh(new THREE.CylinderGeometry(52, 52, 0.5, 22), grass2);
  green.position.y = 0.4; g.add(green);
  const pav = new THREE.Mesh(BOX(17, 5, 9), white); pav.position.set(0, 2.5, -46); g.add(pav);
  const rf = new THREE.Mesh(BOX(20, 1.4, 12), toon(0x6b4a2f)); rf.position.set(0, 5.6, -46); g.add(rf);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 3, 10), toon(0xe8e4dc));
  band.position.set(0, 1.6, 0); g.add(band);
  const bcap = new THREE.Mesh(new THREE.ConeGeometry(7.4, 4, 10), toon(0x4f7d8a));
  bcap.position.set(0, 5, 0); g.add(bcap);
  for (let i = 0; i < 7; i++) {
    const a = i / 7 * 6.283;
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, 5, 6), toon(0x6f5033));
    tr.position.set(Math.cos(a) * 44, 2.5, Math.sin(a) * 44); g.add(tr);
    const cn = new THREE.Mesh(new THREE.IcosahedronGeometry(5.4, 0), toon(0x4e8f3a));
    cn.position.set(Math.cos(a) * 44, 8, Math.sin(a) * 44); g.add(cn);
  }
});

G('THE ROMAN VILLA', c => plains(c) || desert(c), g => {
  const w = [];
  for (const [dx, dz, l, ang] of [[0, -26, 62, 0], [0, 26, 62, 0], [-31, 0, 52, Math.PI / 2], [31, 0, 52, Math.PI / 2]])
    w.push(baked(BOX(l, 7, 3.4), dx, 3.5, dz, 0, ang, 0));
  g.add(new THREE.Mesh(merge(w), toon(0xe0d4b8)));
  const rf = [];
  for (const [dx, dz, l, ang] of [[0, -26, 66, 0], [0, 26, 66, 0], [-31, 0, 56, Math.PI / 2], [31, 0, 56, Math.PI / 2]])
    rf.push(baked(BOX(l, 1.4, 9), dx, 7.6, dz, 0, ang, 0));
  g.add(new THREE.Mesh(merge(rf), toon(0xb8604a)));
  const cols = [];
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * 6.283;
    cols.push(baked(new THREE.CylinderGeometry(0.9, 1, 6, 8), Math.cos(a) * 19, 3, Math.sin(a) * 15));
  }
  g.add(new THREE.Mesh(merge(cols), pale));
  const pool = new THREE.Mesh(BOX(22, 0.6, 11), toon(0x3f8fc4)); pool.position.y = 0.5; g.add(pool);
});

G('THE CEMETERY', c => plains(c) || forest(c), g => {
  const st = [];
  for (let i = 0; i < 13; i++) for (let j = 0; j < 9; j++) {
    if (hash2i(i * 31, j * 17) > 0.85) continue;
    st.push(baked(BOX(1.7, 3 + (i % 3) * 0.9, 0.6), i * 7 - 42, 1.6, j * 7 - 28));
  }
  g.add(new THREE.Mesh(merge(st), stone2));
  const chap = new THREE.Mesh(BOX(13, 9, 20), stone); chap.position.set(0, 4.5, -50); g.add(chap);
  const spire = new THREE.Mesh(new THREE.ConeGeometry(5.4, 17, 4), toon(0x5a6068));
  spire.position.set(0, 17, -50); spire.rotation.y = Math.PI / 4; g.add(spire);
  const maus = new THREE.Mesh(BOX(9, 8, 9), stone); maus.position.set(40, 4, 20); g.add(maus);
  const wall = [];
  for (const [dx, dz, l, ang] of [[0, -60, 120, 0], [0, 44, 120, 0], [-60, -8, 104, Math.PI / 2], [60, -8, 104, Math.PI / 2]])
    wall.push(baked(BOX(l, 3.4, 1.4), dx, 1.7, dz, 0, ang, 0));
  g.add(new THREE.Mesh(merge(wall), stone2));
});

// ---- industry ----
G('THE REFINERY', c => plains(c) || desert(c) || coastal(c), g => {
  for (let i = 0; i < 7; i++) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 13, 16), toon(0xd6d8dc));
    t.position.set((i % 4) * 40 - 60, 6.5, ((i / 4) | 0) * 44 - 22); g.add(t);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(15.4, 15.4, 1, 16), toon(0xb9bcc2));
    lid.position.set((i % 4) * 40 - 60, 13.4, ((i / 4) | 0) * 44 - 22); g.add(lid);
  }
  for (let i = 0; i < 5; i++) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4, 40 + i * 9, 12), toon(0xc9ccd2));
    col.position.set(i * 15 - 30, 20 + i * 4.5, 74); g.add(col);
  }
  const flare = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.6, 66, 10), rust);
  flare.position.set(72, 33, 74); g.add(flare);
  const fl = new THREE.Mesh(new THREE.ConeGeometry(4.4, 13, 8), toon(0xff7a2b));
  fl.position.set(72, 72, 74); g.add(fl);
}, [70, 78]);

G('THE POWER LINE MARCH', c => c.slope < 0.3 && c.y > 20, g => {
  for (let i = 0; i < 7; i++) {
    const pz = i * 90 - 270, base = new THREE.Group();
    base.position.set(0, 0, pz); g.add(base);
    const parts = [];
    for (const [px, pzz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]])
      parts.push(baked(BOX(1.1, 52, 1.1), px * (1 - 0.5), 26, pzz * (1 - 0.5)));
    for (let k = 1; k < 5; k++) parts.push(baked(BOX(11, 0.9, 11), 0, k * 11, 0));
    parts.push(baked(BOX(34, 1.4, 2.4), 0, 44, 0));
    parts.push(baked(BOX(26, 1.4, 2.4), 0, 52, 0));
    base.add(new THREE.Mesh(merge(parts), lead));
    if (i < 6) for (const off of [-17, -13, 13, 17]) {
      const w = new THREE.Mesh(BOX(0.3, 0.3, 90), inkM);
      w.position.set(off, off > 0 ? 43 : 43, 45); base.add(w);
    }
  }
}, [12, 56]);

G('WATER TREATMENT WORKS', c => plains(c) && c.slope < 0.08, g => {
  for (let i = 0; i < 6; i++) {
    const cx = (i % 3) * 52 - 52, cz = ((i / 3) | 0) * 52 - 26;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 5, 20), toon(0xc9ccd2));
    rim.position.set(cx, 2.4, cz); g.add(rim);
    const water = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 0.6, 20), toon(0x4a7a8a));
    water.position.set(cx, 4.4, cz); g.add(water);
    const arm = new THREE.Mesh(BOX(42, 1, 1.6), toon(0x8f949c)); arm.position.set(cx, 6.4, cz); g.add(arm);
  }
  const shed = new THREE.Mesh(BOX(30, 9, 17), toon(0xd6d8dc)); shed.position.set(0, 4.5, 60); g.add(shed);
});

G('THE SCRAPYARD', c => plains(c) || desert(c), g => {
  const cols = [0xd8483a, 0x3f8fc4, 0xd9a72c, 0x8a8f98, 0x4b8f52];
  for (let i = 0; i < 40; i++) {
    const sx = (i % 8) * 11 - 44, sz = ((i / 8) | 0) * 13 - 26, st = i % 4;
    for (let k = 0; k <= st; k++) {
      const car = new THREE.Mesh(BOX(4.4, 1.7, 9), toon(cols[(i + k) % 5]));
      car.position.set(sx, 1 + k * 1.8, sz); car.rotation.y = hash2i(i, k) * 0.4; g.add(car);
    }
  }
  const crane = new THREE.Mesh(BOX(4, 26, 4), toon(0xd8c84a)); crane.position.set(56, 13, 0); g.add(crane);
  const jib = new THREE.Mesh(BOX(40, 2, 2.4), toon(0xd8c84a)); jib.position.set(38, 26, 0); g.add(jib);
  const mag = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 2, 12), inkM); mag.position.set(20, 17, 0); g.add(mag);
});

G('THE CEMENT WORKS', c => (plains(c) || desert(c)) && c.slope < 0.12, g => {
  const kiln = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 90, 14).rotateZ(Math.PI / 2 - 0.09), toon(0x9aa0a8));
  kiln.position.set(0, 22, 0); g.add(kiln);
  for (let i = 0; i < 4; i++) {
    const si = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 44, 14), toon(0xd6d2c4));
    si.position.set(i * 21 - 31, 22, -50); g.add(si);
  }
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(4, 5.4, 70, 12), toon(0xc9ccd2));
  stack.position.set(56, 35, -20); g.add(stack);
  const heap = new THREE.Mesh(new THREE.ConeGeometry(22, 17, 12), toon(0xb9b0a0));
  heap.position.set(-56, 7, 40); g.add(heap);
}, [56, 70]);

// ---- civic ----
G('THE STADIUM', c => plains(c) && c.slope < 0.06, g => {
  const bowl = [];
  for (let i = 0; i < 44; i++) {
    const a = i / 44 * 6.283;
    const rx = 92, rz = 74;
    bowl.push(baked(BOX(17, 26, 15), Math.cos(a) * rx, 13, Math.sin(a) * rz, 0, -a, 0));
  }
  g.add(new THREE.Mesh(merge(bowl), toon(0xc9ccd2)));
  const roof = [];
  for (let i = 0; i < 44; i++) {
    const a = i / 44 * 6.283;
    roof.push(baked(BOX(24, 1.6, 15), Math.cos(a) * 96, 27, Math.sin(a) * 78, 0, -a, 0));
  }
  g.add(new THREE.Mesh(merge(roof), toon(0xe8e4dc)));
  const pitch = new THREE.Mesh(new THREE.CylinderGeometry(66, 66, 0.5, 26).scale(1, 1, 0.78), grass2);
  pitch.position.y = 0.4; g.add(pitch);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * 6.283 + 0.79;
    const l = new THREE.Mesh(BOX(2, 40, 2), lead);
    l.position.set(Math.cos(a) * 104, 20, Math.sin(a) * 86); g.add(l);
    const lb = new THREE.Mesh(BOX(13, 5, 2), toon(0xffd23b));
    lb.position.set(Math.cos(a) * 104, 42, Math.sin(a) * 86); g.add(lb);
  }
}, [100, 44]);

G('THE UNIVERSITY', c => plains(c), g => {
  const w = [];
  for (const [dx, dz, l, ang] of [[0, -46, 110, 0], [0, 46, 110, 0], [-55, 0, 92, Math.PI / 2], [55, 0, 92, Math.PI / 2]])
    w.push(baked(BOX(l, 17, 15), dx, 8.5, dz, 0, ang, 0));
  g.add(new THREE.Mesh(merge(w), toon(0xd8c8a8)));
  const rf = [];
  for (const [dx, dz, l, ang] of [[0, -46, 114, 0], [0, 46, 114, 0], [-55, 0, 96, Math.PI / 2], [55, 0, 96, Math.PI / 2]])
    rf.push(baked(BOX(l, 2, 19), dx, 18, dz, 0, ang, 0));
  g.add(new THREE.Mesh(merge(rf), toon(0x5a6068)));
  const tower = new THREE.Mesh(BOX(17, 44, 17), toon(0xd8c8a8)); tower.position.set(0, 22, -46); g.add(tower);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(13, 15, 4), toon(0x5a6068));
  cap.position.set(0, 51, -46); cap.rotation.y = Math.PI / 4; g.add(cap);
  const lawn = new THREE.Mesh(BOX(90, 0.4, 74), grass2); lawn.position.y = 0.3; g.add(lawn);
}, [70, 60]);

G('THE PRISON', c => plains(c) || desert(c), g => {
  const w = [];
  for (const [dx, dz, l, ang] of [[0, -62, 150, 0], [0, 62, 150, 0], [-75, 0, 124, Math.PI / 2], [75, 0, 124, Math.PI / 2]])
    w.push(baked(BOX(l, 13, 4.4), dx, 6.5, dz, 0, ang, 0));
  g.add(new THREE.Mesh(merge(w), toon(0xa8a49c)));
  for (const [cx, cz] of [[-75, -62], [75, -62], [-75, 62], [75, 62]]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 5, 20, 10), toon(0xa8a49c));
    t.position.set(cx, 10, cz); g.add(t);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(6.4, 5, 10), inkM); cap.position.set(cx, 22, cz); g.add(cap);
  }
  for (let i = 0; i < 3; i++) {
    const blk = new THREE.Mesh(BOX(90, 15, 20), toon(0xb9b4ac)); blk.position.set(0, 7.5, i * 34 - 34); g.add(blk);
  }
  const yard = new THREE.Mesh(BOX(140, 0.4, 30), toon(0x8f8f88)); yard.position.set(0, 0.3, 48); g.add(yard);
}, [86, 24]);

G('THE GRAND MOSQUE', c => desert(c) || plains(c), g => {
  const base = new THREE.Mesh(BOX(56, 15, 56), toon(0xe4dcc8)); base.position.y = 7.5; g.add(base);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(20, 20, 12, 0, 6.283, 0, Math.PI / 2), toon(0x3f8f9c));
  dome.position.y = 15; g.add(dome);
  const finial = new THREE.Mesh(new THREE.ConeGeometry(2.4, 9, 8), toon(0xffd23b)); finial.position.y = 38; g.add(finial);
  for (const [cx, cz] of [[-30, -30], [30, -30], [-30, 30], [30, 30]]) {
    const d2 = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 7, 0, 6.283, 0, Math.PI / 2), toon(0x3f8f9c));
    d2.position.set(cx, 15, cz); g.add(d2);
  }
  for (const [cx, cz] of [[-38, -38], [38, 38]]) {
    const m2 = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.4, 56, 12), toon(0xe4dcc8));
    m2.position.set(cx, 28, cz); g.add(m2);
    const bal = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.4, 2.4, 12), toon(0xd8c8a8));
    bal.position.set(cx, 46, cz); g.add(bal);
    const top = new THREE.Mesh(new THREE.ConeGeometry(4.4, 11, 12), toon(0x3f8f9c));
    top.position.set(cx, 61, cz); g.add(top);
  }
  const court = new THREE.Mesh(BOX(96, 0.6, 96), toon(0xd8d2c4)); court.position.y = 0.4; g.add(court);
}, [40, 68]);

// =================================================================
//  PERSISTENCE
//  Four things now want to survive a reload. One helper, so a blocked or corrupt
//  localStorage is a shrug in one place rather than a try/catch at every call site.
// =================================================================
const store = {
  get(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} },
};

// =================================================================
//  CHALLENGES — things to fly *at* rather than merely over
//  Three kinds, all built on one geometric test: has the aeroplane just crossed a plane
//  in some object's local frame while inside a window in that plane? A limbo is one such
//  window under a piece of architecture, a race gate is one between two pylons, and both
//  reduce to the same six lines. Everything is sited from geometry that already exists.
// =================================================================
const CH_KEY = 'flightsim.challenges.v1';
const chRec = store.get(CH_KEY, { limbo: {}, race: {}, drop: 0, ghost: {} });
chRec.limbo = chRec.limbo || {}; chRec.race = chRec.race || {}; chRec.ghost = chRec.ghost || {};

// A crossing window in some object's local frame. `test(lx, ly)` says whether the
// aeroplane is inside the opening; the crossing itself is the sign flip of lz.
function makeGate(x, y, z, sn, cs, test, depth) {
  return { x, y, z, sn, cs, test, depth: depth || 70, prev: null };
}
// Returns true on the frame the aeroplane passes through the window.
function gateCrossed(G, px, py, pz) {
  const dx = px - G.x, dz = pz - G.z;
  const lx = dx * G.cs - dz * G.sn, lz = dx * G.sn + dz * G.cs, ly = py - G.y;
  const was = G.prev;
  G.prev = lz;
  if (was === null || Math.abs(lz) > G.depth || Math.abs(was) > G.depth) return false;
  if ((lz < 0) === (was < 0)) return false;            // did not cross the plane
  return G.test(lx, ly);
}

// ---- limbo runs -------------------------------------------------------------
// Openings under architecture that is already there. The arch's inner semicircle, each
// of the aqueduct's ten bays, and the whole length of the bridge deck.
const LIMBOS = [];
{
  const lm = n => LANDMARKS.find(l => l.name === n);
  const arch = lm('THE STONE ARCH');
  if (arch) LIMBOS.push({ name: 'THE STONE ARCH', bays: [makeGate(arch.x, arch.y, arch.z,
    arch.sn, arch.cs, (lx, ly) => ly > 1.5 && Math.hypot(lx, ly) < 25, 40)] });
  const aq = lm('THE AQUEDUCT');
  if (aq) {
    const bays = [];
    for (let i = 0; i < 10; i++) {
      const cx = i * 26 - 130 + 13;
      bays.push(makeGate(aq.x, aq.y, aq.z, aq.sn, aq.cs,
        (lx, ly) => ly > 1.5 && ly < 32 && Math.abs(lx - cx) < 7.5, 34));
    }
    LIMBOS.push({ name: 'THE AQUEDUCT', bays });
  }
  if (typeof BRIDGE !== 'undefined' && BRIDGE) {
    // the bridge runs along its own +X, so its crossing plane is the perpendicular one
    const mx = BRIDGE.x0 + BRIDGE.dx * BRIDGE.total / 2;
    const mz = BRIDGE.z0 + BRIDGE.dz * BRIDGE.total / 2;
    LIMBOS.push({ name: 'THE SOUND BRIDGE', bays: [makeGate(mx, 0, mz,
      -BRIDGE.dx, BRIDGE.dz,      // gate faces across the span, so you cross under it
      (lx, ly) => ly > 2 && ly < BRIDGE.deckY - 6 && Math.abs(lx) < BRIDGE.span * 0.42, 90)] });
  }
}

// ---- drop zones -------------------------------------------------------------
// The eject was only ever a failure state. A bullseye turns it into something you aim at.
const DROPS = [];
{
  const rings = [[26, 0xd8483a], [17, 0xf2efe7], [9, 0xd8483a], [3.4, 0xffd23b]];
  let tried = 0;
  for (let n = 0; n < 5 && tried < 900; n++) {
    let put = null;
    for (let i = 0; i < 300 && !put; i++, tried++) {
      const a = hash2i(n * 613 + i * 37, 5) * 6.283185;
      const r = 2400 + hash2i(n * 71 + i, 11) * 13000;
      const x = HOME.x + Math.cos(a) * r, z = HOME.z + Math.sin(a) * r;
      // Inside the world, with room to spare. This was unclamped, and since HOME is not
      // at the origin a 13 km radius put bullseyes as far out as z = 26 km — outside a
      // world that stops at 20. updatePilot clamps the parachutist to the world, so those
      // targets were not merely off-map, they were arithmetically impossible to hit.
      if (Math.abs(x) > WORLD - 1200 || Math.abs(z) > WORLD - 1200) continue;
      const y = terrainH(x, z, SMP);
      if (y < 12 || SMP.rw > 0.01 || SMP.cw > 0.01) continue;
      const e = 40;
      if (Math.hypot(terrainH(x + e, z) - y, terrainH(x, z + e) - y) / e > 0.07) continue;
      if (DROPS.some(d => Math.hypot(d.x - x, d.z - z) < 3000)) continue;
      put = { x, y, z };
    }
    if (!put) continue;
    const g = new THREE.Group();
    g.position.set(put.x, put.y + 0.35, put.z);
    rings.forEach(([rad, col], ri) => {                 // stacked so the smaller reads on top
      const d = new THREE.Mesh(new THREE.CircleGeometry(rad, 30).rotateX(-Math.PI / 2), toon(col));
      d.position.y = ri * 0.03;
      g.add(d);
    });
    scene.add(g);
    DROPS.push(put);
  }
  console.log(`drop zones: ${DROPS.length} bullseyes placed of 5 wanted`);
}

// ---- pylon races ------------------------------------------------------------
// Gates are two pylons and a banner: unmistakable from a distance, and unmistakably
// passed or missed. A gate is only laid where the aeroplane could actually fly through
// it — clear of the ground and clear of anything cityHit calls solid — and any that
// cannot be made safe is dropped and counted rather than left as a trap.
const RACES = [];
const raceGroup = new THREE.Group(); scene.add(raceGroup);
{
  const PYL = toon(0xff7a2b), BAN = toon(0xffd23b);
  function buildGate(x, y, z, hdg, half, height) {
    const g = new THREE.Group();
    g.position.set(x, y, z); g.rotation.y = hdg;
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.2, height, 8), PYL);
      p.position.set(s * half, height / 2, 0); g.add(p);
      for (let b = 0; b < 4; b++) {                     // banding, so it reads at range
        const r = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.75, height / 9, 8), BAN);
        r.position.set(s * half, height * (0.14 + b * 0.22), 0); g.add(r);
      }
    }
    const top = new THREE.Mesh(BOX(half * 2, 3.4, 1.2), BAN);
    top.position.y = height; g.add(top);
    raceGroup.add(g);
    return g;
  }
  // Somewhere this gate can exist: lift it until it is clear of the ground and of the city.
  function safeGate(x, z, wantAgl, half) {
    const gy = terrainH(x, z);
    if (gy < 3) return null;                             // never over water
    for (let lift = wantAgl; lift <= wantAgl + 120; lift += 12) {
      const y = gy + lift;
      let clear = true;
      for (let s = -1; s <= 1 && clear; s++)             // both pylons and the middle
        if (cityHit(x + s * half * 0.7, y + 12, z)) clear = false;
      if (clear) return { x, y, z, gy };
    }
    return null;
  }
  function makeCourse(name, pts, half, height, wantAgl) {
    const gates = [];
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      const put = safeGate(x, z, wantAgl, half);
      if (!put) continue;
      const nxt = pts[Math.min(i + 1, pts.length - 1)];
      const prv = pts[Math.max(i - 1, 0)];
      const hdg = Math.atan2(nxt[0] - prv[0], nxt[1] - prv[1]);   // square to the course
      buildGate(put.x, put.y, put.z, hdg, half, height);
      gates.push(makeGate(put.x, put.y + height * 0.42, put.z,
        Math.sin(hdg), Math.cos(hdg),
        (lx, ly) => Math.abs(lx) < half && Math.abs(ly) < height * 0.46, 90));
    }
    if (gates.length >= 4) RACES.push({ name, gates, next: 0, t: 0, running: false });
    console.log(`race ${name}: ${gates.length} gates of ${pts.length} sites`);
  }

  // 1 — the turbine slalom: weaving the line of nine at WINDROW RIDGE
  const wr = LANDMARKS.find(l => l.name === 'WINDROW RIDGE');
  if (wr) {
    const pts = [];
    for (let i = -5; i <= 5; i++) {
      const lx = i * 105, lz = (i % 2 ? 1 : -1) * 78;    // alternate sides = a slalom
      pts.push([wr.x + lx * wr.cs + lz * wr.sn, wr.z - lx * wr.sn + lz * wr.cs]);
    }
    makeCourse('WINDROW SLALOM', pts, 26, 54, 34);
  }
  // 2 — the city circuit: a lap of PORT MERIDIAN, in among the towers
  const city = TOWNS[0];
  if (city) {
    const pts = [];
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * 6.283185;
      const r = city.half * (0.62 + 0.22 * Math.sin(i * 2.1));
      pts.push([city.x + Math.cos(a) * r, city.z + Math.sin(a) * r]);
    }
    makeCourse('PORT MERIDIAN CIRCUIT', pts, 30, 60, 96);
  }
  // 3 — the canyon run: walk downhill from high ground and the valley finds itself
  {
    let bx = 0, bz = 0, by = -1;
    for (let i = 0; i < 900; i++) {                      // the highest ground we can find
      const a = hash2i(i * 97, 13) * 6.283185, r = 3000 + hash2i(i, 29) * 14000;
      const x = HOME.x + Math.cos(a) * r, z = HOME.z + Math.sin(a) * r;
      const y = terrainH(x, z);
      if (y > by) { by = y; bx = x; bz = z; }
    }
    const pts = [[bx, bz]];
    let cx = bx, cz = bz;
    for (let i = 0; i < 10; i++) {
      let best = null;                                   // steepest descent, smoothed
      for (let a = 0; a < 16; a++) {
        const ang = a / 16 * 6.283185;
        const nxp = cx + Math.cos(ang) * 420, nzp = cz + Math.sin(ang) * 420;
        const y = terrainH(nxp, nzp);
        if (!best || y < best.y) best = { x: nxp, z: nzp, y };
      }
      if (!best || best.y < 6) break;
      cx = best.x; cz = best.z; pts.push([cx, cz]);
    }
    makeCourse('THE CANYON RUN', pts, 30, 56, 44);
  }
}
console.log(`landmarks: ${lmMasked}/${LANDMARKS.length} masked out of the scatter, `
  + `road+landmark mask now ${ROAD_CELLS.size} cells`);
console.log(`landmarks: ${LANDMARKS.length} placed · `
  + LANDMARKS.map(l => `${l.name} ${(Math.hypot(l.x - STRIPS[0].x, l.z - STRIPS[0].z) / 1000).toFixed(1)}km`).join(', '));

// Did the aeroplane just fly into a building? The boxes are axis-aligned in each
// settlement's own local space, so the test is a bounding check, a rotation into that
// space, and a lookup in that place's block grid.
function cityHit(wx, wy, wz) {
  for (let n = 0; n < LM_BOX.length; n++) {
    const B = LM_BOX[n];
    if (wy < B.y0 || wy > B.y1) continue;
    const dx = wx - B.x, dz = wz - B.z;
    const lx = dx * B.cs - dz * B.sn, lz = dx * B.sn + dz * B.cs;
    if (Math.abs(lx) < B.hw + PLANE_R && Math.abs(lz) < B.hd + PLANE_R) return true;
  }
  for (let n = 0; n < LM_HIT.length; n++) {
    const L = LM_HIT[n];
    if (wy > L.top) continue;
    const dx = wx - L.x, dz = wz - L.z;
    if (dx * dx + dz * dz > (L.r + PLANE_R) ** 2) continue;
    if (!L.parts) return true;
    // inside the bounds of something with genuine openings — ask the solids themselves
    const lx = dx * L.cs - dz * L.sn, lz = dx * L.sn + dz * L.cs, ly = wy - L.y;
    for (let p = 0; p < L.parts.length; p++) {
      const b = L.parts[p];
      if (b.ring) {
        if (ly < b.y0 || Math.abs(lz - b.lz) > b.hd + PLANE_R) continue;
        const rr = Math.hypot(lx - b.lx, ly - b.ly);
        if (rr > b.r0 - PLANE_R && rr < b.r1 + PLANE_R) return true;
      } else if (ly >= b.y0 && ly <= b.y1
        && Math.abs(lx - b.lx) < b.hw + PLANE_R && Math.abs(lz - b.lz) < b.hd + PLANE_R) return true;
    }
  }
  for (let n = 0; n < TOWNS.length; n++) {
    const t = TOWNS[n];
    if (!t.boxes.length || wy > t.y + TOWN_MAX_TOP) continue;
    const dx = wx - t.x, dz = wz - t.z;
    if (dx * dx + dz * dz > (t.half * 1.05) ** 2) continue;
    const lx = dx * t.cs - dz * t.sn, lz = dx * t.sn + dz * t.cs;
    const bi = Math.floor(lx / t.blk), bj = Math.floor(lz / t.blk);
    for (let i = bi - 1; i <= bi + 1; i++) {
      for (let j = bj - 1; j <= bj + 1; j++) {
        const list = t.grid.get(i + ':' + j);
        if (!list) continue;
        for (const k of list) {
          const b = t.boxes[k];
          if (wy > b.top) continue;
          if (Math.abs(lx - b.lx) < b.hw + PLANE_R && Math.abs(lz - b.lz) < b.hd + PLANE_R) return true;
        }
      }
    }
  }
  // roadside buildings: their own grid, because they are scattered over a hundred
  // kilometres of verge rather than packed into seven pads. A cell is 140 m and the
  // widest of them is 25 m, so the ring of nine around you is always enough.
  const gi = Math.floor(wx / SPRAWL_CELL), gj = Math.floor(wz / SPRAWL_CELL);
  for (let i = gi - 1; i <= gi + 1; i++) {
    for (let j = gj - 1; j <= gj + 1; j++) {
      const list = SPRAWL_GRID.get(i + ':' + j);
      if (!list) continue;
      for (const b of list) {
        if (wy > b.top) continue;
        const dx = wx - b.x, dz = wz - b.z;
        const lx = dx * b.cs - dz * b.sn, lz = dx * b.sn + dz * b.cs;
        if (Math.abs(lx) < b.hw + PLANE_R && Math.abs(lz) < b.hd + PLANE_R) return true;
      }
    }
  }
  return false;
}

// =================================================================
//  THE AEROPLANE + THE FLIGHT MODEL
//  Both lifted from ~/driver. The tuning constants and every sign in updatePlane are
//  exactly as they were: the yaw and roll signs were gotten wrong twice over there and
//  fixed by looking at the screen, so they are not to be "tidied".
// =================================================================
const RAMP_GLASS = new THREE.MeshToonMaterial({ color: 0x243049, gradientMap: RAMP });
let planeSpeed = 0, planePitch = 0, planeRoll = 0, planeHeading = 0;
let edgeTurn = false;                  // flying the automatic turn back off the world edge
const EDGE_MARGIN = 1100;              // how far in from the wall the turn starts
const plane = new THREE.Group(); plane.rotation.order = 'YXZ'; scene.add(plane);
let planeShadow = null;
// flight tuning
const PLANE_MAX = 58, PLANE_ACCEL = 20, PLANE_DECEL = 24, PLANE_DRAG = 5, PLANE_BRAKE = 40,
      PLANE_TAKEOFF = 24, PITCH_RATE = 1.0, PITCH_MAX = 0.55, ROLL_MAX = 0.8, ROLL_RATE = 1.9,
      YAW_RATE = 0.75, GROUND_STEER = 1.5, STALL_FALL = 15, CRASH_VY = 18;
const CHUTE_FALL = 6;

// ---- energy ----------------------------------------------------------------
// The harvested model has no energy: speed answered only to the throttle, so a dive
// never gained you anything and a climb never cost you anything — you could hold full
// rate of climb to any altitude forever, and there was no ceiling.
//
// ENERGY is gravity acting along the flight path, in m/s per second at a vertical
// climb. Set it to 0 and the arithmetic below vanishes, giving back the exact tuned
// behaviour that was ported over — that is the point of it being a constant. 6.0 is
// about 60% of true gravity: enough that a dive builds real speed and a sustained
// climb bleeds off into a stall (so the aeroplane finds its own ceiling), without
// making the gentle powered cruise the model was tuned around feel like a fight.
//
// 14, not 9.81: the whole harvested model runs at roughly twice real-world
// accelerations (the throttle alone is 20 m/s²), and the pitch limit is only 31.5°.
// At true gravity a full-deflection dive gains 5.1 m/s² against 5.0 of drag and
// therefore never speeds up at all — measured. 14 keeps gravity in proportion to the
// rest of the model, so a dive is worth something.
const ENERGY = 14.0;
const PLANE_VNE = PLANE_MAX * 1.45;   // never-exceed: what a dive can build up to

function buildPlane() {
  const g = new THREE.Group();
  const body = toonRim(0xe8532f), white = toonRim(0xf2efe7), dark = toonRim(0x2b2f38);
  // fuselage + tail boom, one merged shell
  const shell = new THREE.Mesh(merge([baked(BOX(1.5, 1.4, 6.2), 0, 1.3, 0),
                                      baked(BOX(0.95, 0.95, 2.4), 0, 1.55, -3.7)]), body);
  g.add(shell);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.2, 16).rotateX(Math.PI / 2), body);
  nose.position.set(0, 1.3, 3.5); g.add(nose);
  const wing = new THREE.Mesh(BOX(10, 0.28, 1.9), white); wing.position.set(0, 1.02, 0.4); g.add(wing);
  const tail = new THREE.Mesh(BOX(3.8, 0.24, 1.1), white); tail.position.set(0, 1.85, -4.3); g.add(tail);
  const fin = new THREE.Mesh(BOX(0.26, 1.6, 1.5), white); fin.position.set(0, 2.55, -4.3); g.add(fin);
  const cock = new THREE.Mesh(BOX(1.15, 0.85, 1.7), RAMP_GLASS); cock.position.set(0, 2.02, 0.9);
  g.add(cock); g.userData.glass = cock;   // hidden from the inside — see updateCamera
  for (const wx of [-2.7, 2.7]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.3, 12).rotateZ(Math.PI / 2), dark);
    w.position.set(wx, 0.4, 0.6); g.add(w);
  }
  const tw = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.24, 10).rotateZ(Math.PI / 2), dark);
  tw.position.set(0, 0.3, -3.5); g.add(tw);
  const prop = new THREE.Group();
  prop.add(new THREE.Mesh(BOX(0.18, 3.1, 0.12), dark));
  prop.add(new THREE.Mesh(BOX(3.1, 0.18, 0.12), dark));
  prop.position.set(0, 1.3, 4.15); g.add(prop);
  g.userData.prop = prop;
  return g;
}
plane.add(buildPlane());
planeShadow = blobShadow(9);

// Parked on the chosen field's threshold facing down the strip, whichever way that strip
// ended up pointing: the spawn is derived from the sited field rather than assuming +Z.
// Which field that is can be picked from the menu, and a crash puts you back on the one
// you chose rather than always dragging you home to MERIDIAN.
let startField = 0;
const PLANE_SPAWN = { x: 0, z: 0, heading: 0 };
function setStartField(i) {
  startField = ((i % STRIPS.length) + STRIPS.length) % STRIPS.length;
  const S = STRIPS[startField];
  PLANE_SPAWN.x = S.x + (-S.halfLen + 70) * S.sn;
  PLANE_SPAWN.z = S.z + (-S.halfLen + 70) * S.cs;
  PLANE_SPAWN.heading = S.hdg;
  return S;
}
setStartField(0);

// =================================================================
//  THE PILOT
//  A minimal on-foot mode: a body that falls and a chute that slows it. Deliberately
//  no walking — this exists so that ejecting means something, not so there is a second
//  game underneath the first one.
// =================================================================
const pilot = new THREE.Group(); pilot.visible = false; scene.add(pilot);
{
  const skin = toonRim(0xf0c090), suit = toonRim(0x3f6ea8);
  const torso = new THREE.Mesh(BOX(0.7, 1.0, 0.45), suit); torso.position.y = 1.15; pilot.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), skin); head.position.y = 1.9; pilot.add(head);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(BOX(0.22, 0.8, 0.22), suit);
    arm.position.set(s * 0.52, 1.3, 0); arm.rotation.z = s * 0.9; pilot.add(arm);
    const leg = new THREE.Mesh(BOX(0.26, 0.9, 0.26), suit);
    leg.position.set(s * 0.2, 0.5, 0); pilot.add(leg);
  }
}
const chute = new THREE.Group(); chute.visible = false; pilot.add(chute);
{
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(2.7, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52),
    new THREE.MeshToonMaterial({ color: 0xe8532f, gradientMap: RAMP, side: THREE.DoubleSide }));
  canopy.position.y = 3.4; chute.add(canopy);
  const shroud = new THREE.Mesh(new THREE.ConeGeometry(2.5, 2.5, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x2b2f38, wireframe: true }));
  shroud.position.y = 2.05; shroud.rotation.x = Math.PI;   // base up at the canopy, apex at the pilot
  chute.add(shroud);
}
const pilotShadow = blobShadow(2.6);
const pilotVel = new THREE.Vector3();
let pilotDown = false, chuteReady = false, chuteOpen = false;

// =================================================================
//  PARTICLES — a small pool, only ever used for the crash
// =================================================================
const PMAX = 160;
const pGeo = new THREE.BoxGeometry(1, 1, 1);
// NOT vertexColors — the per-instance colour arrives through instanceColor, and
// three multiplies both into vColor. Turning vertexColors on as well makes the shader
// also read a `color` attribute the box geometry does not have, which comes through
// as zero and renders every particle black.
const pMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP });
const pMesh = new THREE.InstancedMesh(pGeo, pMat, PMAX);
pMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PMAX * 3), 3);
pMesh.frustumCulled = false; pMesh.count = 0; scene.add(pMesh);
const parts = [];
const _pc = new THREE.Color();
function emit(x, y, z, vx, vy, vz, color, size, life) {
  if (parts.length >= PMAX) return;
  parts.push({ x, y, z, vx, vy, vz, color, size, life, max: life });
}
function burst(x, y, z, color, n) {
  for (let i = 0; i < n; i++)
    emit(x, y, z, rnd(-11, 11), rnd(2, 15), rnd(-11, 11), color, rnd(0.3, 0.8), rnd(0.7, 1.7));
}
function updateParticles(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= dt;
    if (p.life <= 0) { parts.splice(i, 1); continue; }
    p.vy -= 22 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(p.x, p.y, p.z);
    dummy.scale.setScalar(p.size * clamp01(p.life / p.max * 2));
    dummy.updateMatrix();
    pMesh.setMatrixAt(i, dummy.matrix);
    pMesh.setColorAt(i, _pc.set(p.color));
  }
  pMesh.count = parts.length;
  pMesh.instanceMatrix.needsUpdate = true;
  if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;
}

// =================================================================
//  HUD + INPUT
// =================================================================
const elIAS = document.getElementById('ias'), elALT = document.getElementById('alt'),
      elTHR = document.querySelector('#thr i'), elHDG = document.getElementById('hdg'),
      elADI = document.getElementById('adiInner'), elToast = document.getElementById('toast'),
      elStamp = document.getElementById('stamp'), elLoader = document.getElementById('loader'),
      elNavName = document.getElementById('navName'), elNavSub = document.getElementById('navSub');
elStamp.textContent = __BUILD__;

let toastT = 0;
function toast(msg) { elToast.textContent = msg; elToast.classList.add('show'); toastT = 2.2; }

const keys = Object.create(null);
let paused = false, camIdx = 0, shake = 0;
let camYaw = 0, camPitch = -0.22, dragging = false, lastMX = 0, lastMY = 0, lastMouse = 0;

addEventListener('keydown', e => {
  initAudio();
  if (e.repeat) { keys[e.code] = true; return; }
  keys[e.code] = true;
  if (e.code === 'KeyP') { paused = !paused; toast(paused ? 'PAUSED' : 'FLY'); }
  if (e.code === 'KeyC') {
    camIdx = (camIdx + 1) % (CAM_DISTS.length + 1);
    if (camIdx === CAM_COCKPIT) { lookYaw = lookPitch = 0; toast('COCKPIT'); }
  }
  if (e.code === 'KeyM') toggleMap();
  if (e.code === 'KeyL') toggleBook();
  if (e.code === 'KeyN') { audioOn = !audioOn; toast(audioOn ? 'SOUND ON' : 'SOUND OFF'); }
  if (e.code === 'KeyR') pressR();
  // Space scrolls the page and Ctrl+key is a browser shortcut on some platforms;
  // both are flight controls here.
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('wheel', e => {
  if (!mapView) return;
  mapZoom = clamp(mapZoom * (e.deltaY > 0 ? 0.88 : 1.14), 0.35, 14);
}, { passive: true });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

const cv = renderer.domElement;
cv.addEventListener('pointerdown', e => { initAudio(); dragging = true; lastMX = e.clientX; lastMY = e.clientY; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointerup', e => { dragging = false; try { cv.releasePointerCapture(e.pointerId); } catch (_) {} });
cv.addEventListener('pointermove', e => {
  if (!dragging) return;
  if (mapView) {
    // grab-the-map panning: a pixel of drag moves a pixel of ground, whatever the zoom
    const upp = (1.108 * camera.position.y) / innerHeight;
    mapPanX -= (e.clientX - lastMX) * upp;
    mapPanZ -= (e.clientY - lastMY) * upp;
  } else if (mode === 'plane' && camIdx === CAM_COCKPIT) {
    lookYaw = clamp(lookYaw - (e.clientX - lastMX) * 0.005, -2.4, 2.4);
    lookPitch = clamp(lookPitch - (e.clientY - lastMY) * 0.004, -1.0, 0.9);
  } else {
    camYaw -= (e.clientX - lastMX) * 0.0044;
    camPitch = clamp(camPitch - (e.clientY - lastMY) * 0.0032, -0.9, 0.7);
  }
  lastMX = e.clientX; lastMY = e.clientY; lastMouse = performance.now();
});

// =================================================================
//  STATE
// =================================================================
let mode = 'plane';                       // 'plane' | 'fall'
let started = false;                      // false until START is clicked, see the menu
let menuOpen = true;                      // the menu is up: hold the world still
let openMenu = () => {};                  // wired once the menu exists, see the bottom
let autoFly = false;                      // the map's hands-off autopilot

function planeHome() {
  plane.position.set(PLANE_SPAWN.x, terrainH(PLANE_SPAWN.x, PLANE_SPAWN.z), PLANE_SPAWN.z);
  planeHeading = PLANE_SPAWN.heading; planeSpeed = 0; planePitch = 0; planeRoll = 0;
  plane.rotation.set(0, planeHeading, 0);
}
planeHome();
camYaw = planeHeading;
camera.position.set(plane.position.x, plane.position.y + 6, plane.position.z - 20);

function toPlane(msg) {
  mode = 'plane'; plane.visible = true; pilot.visible = false; chute.visible = false;
  chuteReady = chuteOpen = pilotDown = false;
  planeHome(); camYaw = planeHeading;
  if (msg) toast(msg);
}

function planeCrash(why) {
  const px = plane.position.x, py = plane.position.y + 0.6, pz = plane.position.z;
  burst(px, py, pz, 0xff7a2b, 34);             // fireball
  burst(px, py, pz, 0xffd23b, 22);             // sparks
  burst(px, py, pz, 0x40424a, 20);             // smoke
  shake = 2.6; sfxCrash();
  toPlane(why ? 'CRASH — ' + why : 'CRASH! back to the strip');
}

// Which field is this, if any? Used both to name a landing and to drive the HUD.
function stripAt(x, z) {
  for (const s of STRIPS) {
    const dx = x - s.x, dz = z - s.z;
    const lz = dx * s.sn + dz * s.cs, lx = dx * s.cs - dz * s.sn;
    if (Math.abs(lx) < s.hw + 12 && Math.abs(lz) < s.halfLen + 25) return s;
  }
  return null;
}
let wasFlying = false;

// =================================================================
//  LANDING SCORE AND LOGBOOK
//  Landing is the thing you do every single flight and the one thing you could not get
//  better at: onTouchdown had the sink rate in its hand and threw it away. Everything a
//  landing is judged on is already in scope at the moment of contact — where you touched
//  across the strip and down it, how hard, how level, and whether you were pointing along
//  the runway or merely crossing it.
//
//  The weights are the opinion: sink rate is a third of the mark because it is the one
//  that breaks aeroplanes, and the rest is airmanship. Each component is reported with
//  its own bar, so a bad score tells you which part to go and fix.
// =================================================================
const LOG_KEY = 'flightsim.landings.v1';
// The store used to be a bare {FIELD: score}. It now carries a history as well, so an
// old save is migrated into the new shape rather than thrown away — anyone who has been
// flying this for a week should not lose their bests to a refactor.
let logbook = store.get(LOG_KEY, null);
if (!logbook || !logbook.best) logbook = { best: logbook || {}, log: [] };
logbook.log = logbook.log || [];
const landingBest = logbook.best;
const LOG_MAX = 24;
const elScore = document.getElementById('score');
const elScGrade = document.getElementById('scGrade');
const elScNum = document.getElementById('scNum');
const elScField = document.getElementById('scField');
const elScRows = document.getElementById('scRows');
const elScBest = document.getElementById('scBest');
let scoreT = 0;
// 1 when you are at or better than `good`, 0 by the time you are at `bad`
const band = (v, good, bad) => clamp01((bad - v) / (bad - good));

function onTouchdown(vy) {
  const s = stripAt(plane.position.x, plane.position.z);
  const sink = -vy;
  if (!s) {                                  // a field landing is not marked, only noted
    toast(`DOWN OFF-FIELD — ${sink < 3 ? 'greased it' : sink < 7 ? 'not bad' : 'firm one'}`);
    return;
  }
  const dx = plane.position.x - s.x, dz = plane.position.z - s.z;
  const lz = dx * s.sn + dz * s.cs;          // along the strip
  const lx = dx * s.cs - dz * s.sn;          // across it
  // Which threshold did you come over? The one behind you. A strip has two, and landing
  // on the reciprocal is just as valid, so the distance is measured from whichever end
  // you actually crossed rather than from a nominal one.
  const dot = Math.sin(planeHeading) * s.sn + Math.cos(planeHeading) * s.cs;
  const along = dot >= 0 ? lz + s.halfLen : s.halfLen - lz;
  const runway = s.halfLen * 2;

  // Sink is scored against 11 m/s, not against CRASH_VY. Scaling to the 18 m/s write-off
  // put nine metres a second — a genuinely heavy arrival — at better than half marks, and
  // the whole interesting range (1 to 5) was squeezed into the top fifth of the scale.
  const cSink  = band(sink, 1.2, 11);
  const cLine  = band(Math.abs(lx), 2, s.hw);
  const cLevel = band(Math.abs(planeRoll), 0.04, 0.5);
  const cNose  = band(Math.abs(planePitch - 0.10), 0.05, 0.42); // a little nose-up is the flare
  const cAlign = band(1 - Math.abs(dot), 0.02, 0.35);           // down the runway, not across it
  const ideal = runway * 0.16;                                  // the touchdown zone
  const cZone = along < 0 ? 0 : band(Math.abs(along - ideal), runway * 0.06, runway * 0.55);

  // A weighted average alone cannot express a landing, because one serious fault gets
  // diluted by five things you did fine: floating two thirds of the way down the strip
  // still scored 82 while everything else was perfect. The weakest component therefore
  // caps the mark — do one thing badly enough and it is not a good landing whatever else
  // went right.
  const worst = Math.min(cSink, cLine, cZone, cLevel, cNose, cAlign);
  const avg = cSink * 0.34 + cLine * 0.18 + cZone * 0.18
            + cLevel * 0.12 + cNose * 0.09 + cAlign * 0.09;
  const score = Math.round(100 * avg * (0.55 + 0.45 * worst));
  const grade = score >= 92 ? 'TEXTBOOK' : score >= 80 ? 'GREASED IT'
              : score >= 64 ? 'GOOD LANDING' : score >= 45 ? 'FIRM ONE' : 'ARRIVED';

  // +lx is the pilot's left looking down the strip; land on the reciprocal and that flips
  const side = (lx * (dot >= 0 ? 1 : -1)) > 0 ? 'left' : 'right';
  const off = Math.abs(lx);
  const rows = [
    ['SINK', `${sink.toFixed(1)} m/s`, cSink],
    ['CENTRELINE', off < 1 ? 'on centre' : `${off.toFixed(0)} m ${side}`, cLine],
    ['TOUCHDOWN', `${Math.max(0, along) | 0} m in`, cZone],
    ['WINGS', `${Math.abs(planeRoll * R2D).toFixed(0)}°`, cLevel],
  ];
  elScRows.innerHTML = rows.map(([k, v, c]) =>
    `<i>${k}</i><s><em style="width:${(c * 100).toFixed(0)}%"></em></s><u>${v}</u>`).join('');
  elScGrade.textContent = grade;
  elScNum.textContent = score;
  elScField.textContent = s.name;

  const prev = landingBest[s.name] || 0;
  const isBest = score > prev;
  if (isBest) {
    landingBest[s.name] = score;
    bump(0.22, 660, 0.10, 'triangle');
    setTimeout(() => bump(0.22, 990, 0.16, 'triangle'), 90);
  }
  logbook.log.unshift({ f: s.name, s: score, g: grade, k: sink });
  if (logbook.log.length > LOG_MAX) logbook.log.length = LOG_MAX;
  store.set(LOG_KEY, logbook);
  elScBest.textContent = isBest ? `NEW BEST AT ${s.name}` : `BEST HERE ${prev}`;
  elScBest.style.color = isBest ? 'var(--sun)' : '';
  elScore.classList.add('show');
  scoreT = 5.5;
}

// bail out: leave the aircraft in mid-air and fall. The plane flies itself home to the
// strip; hit R again to pull the chute before you meet the ground.
function ejectPlane() {
  const fx = Math.sin(planeHeading), fz = Math.cos(planeHeading);
  const horiz = planeSpeed * Math.cos(planePitch);
  const gy = terrainH(plane.position.x, plane.position.z);
  mode = 'fall'; plane.visible = false; pilot.visible = true; chute.visible = false;
  pilot.position.set(plane.position.x, Math.max(plane.position.y, gy + 1) + 1.4, plane.position.z);
  pilot.rotation.set(0, planeHeading, 0);
  pilotVel.set(fx * horiz * 0.35, 6.5, fz * horiz * 0.35);   // flung up and forward out of the cockpit
  pilotDown = false; chuteReady = true; chuteOpen = false;
  planeHome();                                               // the empty aircraft returns to its stand
  shake = 0.8;
  toast('EJECT!  press R again to pull the chute');
}
function deployChute() {
  chuteOpen = true; chute.visible = true; sfxChute();
  if (pilotVel.y < -CHUTE_FALL) pilotVel.y = -CHUTE_FALL;    // the canopy bites at once
  toast('CHUTE OPEN — ride her down');
}
// R does the next sensible thing, which is the whole interface for the on-foot mode.
function pressR() {
  if (paused) return;
  if (mode === 'plane') { ejectPlane(); return; }
  if (pilotDown) { toPlane('BACK IN THE COCKPIT'); return; }
  if (chuteReady && !chuteOpen) deployChute();
}

// =================================================================
//  FLIGHT MODEL
//  Straight from ~/driver's updatePlane. What changed: surfaceY became terrainH, the
//  building colliders are gone, the town bounds became the world bounds, the water
//  test reads the height field instead of a river polygon, and the radar sync and
//  mission hook are deleted. Nothing else — in particular no sign, no constant and no
//  ordering in the control block has been touched.
// =================================================================
function updatePlane(dt) {
  const on = !paused;
  const gy = terrainH(plane.position.x, plane.position.z);
  const grounded = plane.position.y <= gy + 0.06;
  // With the map open you are not flying — so the aeroplane flies itself: throttle on,
  // no yaw, no pitch. The hands-off-under-power behaviour already levels the nose and
  // holds altitude, and roll decays to zero on its own, so "only W is held" IS straight
  // and level. Not on the ground, though: opening the map on the apron should not send
  // the aircraft trundling off down the runway.
  autoFly = mapView && !grounded && started;
  const K = c => on && (autoFly ? c === 'KeyW' : !!keys[c]);
  // once you're rolling fast enough to fly (or already airborne) the flight controls
  // take over; below that on the tarmac you're taxiing.
  const flying = !grounded || planeSpeed >= PLANE_TAKEOFF;

  // throttle: W up, S down — S bites hard on the ground so it doubles as a brake
  // Air thins with height, so there is less for the propeller to bite on. This is what
  // actually produces a ceiling: the throttle is 20 m/s², twice gravity, so on its own
  // the energy term below can never hold a climb back at any angle the pitch limit
  // allows — the first attempt at this climbed to 6.5 km and was still going.
  const rho = ENERGY > 0 ? clamp(1 - (plane.position.y - SEA_Y) / 3600, 0.05, 1) : 1;
  // The engine drives it to cruise and no further; only gravity gets you past that.
  // (With ENERGY 0 this is rho 1 and a plain clamp to PLANE_MAX — bit for bit the
  // harvested behaviour, which is the whole point of the constant.)
  if (K('KeyW')) {
    if (planeSpeed < PLANE_MAX) planeSpeed = Math.min(planeSpeed + PLANE_ACCEL * rho * dt, PLANE_MAX);
  }
  else if (K('KeyS')) planeSpeed -= (grounded ? PLANE_BRAKE : PLANE_DECEL) * dt;
  else planeSpeed -= PLANE_DRAG * dt;
  // energy: nose down and gravity pays you in speed, nose up and it charges you for
  // the altitude. Only in the air — on the ground the wheels carry the weight.
  if (ENERGY > 0 && flying) {
    planeSpeed -= ENERGY * Math.sin(planePitch) * dt;
    // past cruise the airframe fights back, so a dive settles at VNE instead of
    // running away to whatever height it was started from
    if (planeSpeed > PLANE_MAX) planeSpeed -= (planeSpeed - PLANE_MAX) * 0.35 * dt;
  }
  planeSpeed = clamp(planeSpeed, 0, ENERGY > 0 ? PLANE_VNE : PLANE_MAX);

  // ---- the world edge ----
  // The world stops at 20 km from the origin and the position clamp below used to simply
  // grind the aeroplane along that wall. Crossing the margin while still pointed outward
  // now flies a proper banked turn back inland, using the same roll-to-heading coupling
  // your own turns use, so it reads as flown rather than teleported. It lets go the
  // moment the nose is pointing back inside, which from the edge is about 180 degrees.
  //
  // The bank sign is derived, not chosen: heading increases with positive roll (see the
  // coupling below), so turning toward a target heading wants the sign of the shortest
  // signed difference to it.
  const wantH = Math.atan2(-plane.position.x, -plane.position.z);   // point at the middle
  const edgeD = ((wantH - planeHeading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const nearEdge = Math.abs(plane.position.x) > WORLD - EDGE_MARGIN
                || Math.abs(plane.position.z) > WORLD - EDGE_MARGIN;
  if (flying && nearEdge && !edgeTurn && Math.abs(edgeD) > 1.75) {
    edgeTurn = true; toast('WORLD EDGE — TURNING BACK');
  }
  if (edgeTurn && (!flying || Math.abs(edgeD) < 0.14)) edgeTurn = false;

  // yaw: A = turn left, D = turn right. Car-like on the ground (steering scales with
  // speed, none when stopped); a steady flat turn once flying.
  const yawIn = edgeTurn ? 0 : (K('KeyD') ? 1 : 0) - (K('KeyA') ? 1 : 0);
  if (flying) planeHeading -= yawIn * YAW_RATE * dt;
  else planeHeading -= yawIn * GROUND_STEER * clamp(planeSpeed / 12, 0, 1) * dt;

  // pitch: Space = nose up, Ctrl = nose down. Flat while taxiing. In the air, hands-off,
  // the nose SAGS — gently under power (holds near level) but hard toward a dive with the
  // throttle closed. So idling never hovers: cut the power and you descend, and you'll fly
  // it into the ground unless you throttle up and pull the nose back level.
  const pIn = (K('Space') ? 1 : 0) - (K('ControlLeft') || K('ControlRight') ? 1 : 0);
  if (!flying) {
    planePitch += (0 - planePitch) * Math.min(1, dt * 6);
  } else if (pIn) {
    planePitch += pIn * PITCH_RATE * dt;
  } else {
    const powered = K('KeyW');
    const sag = powered ? 0 : -PITCH_MAX * 0.85;             // throttle closed -> nose drops
    planePitch += (sag - planePitch) * Math.min(1, dt * (powered ? 0.9 : 1.6));
  }
  planePitch = clamp(planePitch, -PITCH_MAX, PITCH_MAX);

  // roll: Q = bank left, E = bank right — and the bank matches the way it turns, a
  // banked wing slipping the nose round the same direction it dips (Q left, E right).
  const rIn = edgeTurn ? 0 : (K('KeyQ') ? 1 : 0) - (K('KeyE') ? 1 : 0);
  if (flying) {
    // The edge turn holds a steady bank instead of taking stick input; the coupling on
    // the last line of this branch is what actually turns the aeroplane either way, so
    // an automatic turn and a hand-flown one are the same manoeuvre.
    if (edgeTurn) planeRoll += ((edgeD > 0 ? 1 : -1) * ROLL_MAX * 0.9 - planeRoll) * Math.min(1, dt * 2.2);
    else { planeRoll += rIn * ROLL_RATE * dt; if (!rIn) planeRoll += (0 - planeRoll) * Math.min(1, dt * 1.5); }
    planeHeading += planeRoll * 0.5 * dt;
  }
  else planeRoll += (0 - planeRoll) * Math.min(1, dt * 6);
  planeRoll = clamp(planeRoll, -ROLL_MAX, ROLL_MAX);

  const lift = clamp(planeSpeed / PLANE_TAKEOFF, 0, 1);
  // vertical: airspeed on the wing turns the nose angle into climb or dive; too slow and
  // the wing stops flying and you simply fall. No hover — level cruise only holds because
  // the nose stays level under power.
  let vy;
  if (!flying) vy = 0;
  else vy = planeSpeed * Math.sin(planePitch) * lift - STALL_FALL * (1 - lift);

  const fx = Math.sin(planeHeading), fz = Math.cos(planeHeading);
  const horiz = planeSpeed * Math.cos(planePitch);
  let nx = plane.position.x + fx * horiz * dt, nz = plane.position.z + fz * horiz * dt;
  const ny = plane.position.y + vy * dt;
  nx = clamp(nx, -WORLD, WORLD);
  nz = clamp(nz, -WORLD, WORLD);
  const gy2 = terrainH(nx, nz);
  plane.position.x = nx; plane.position.z = nz;
  // downtown is solid. This is the one place in the world you can hit something that
  // is not the ground, and it is what makes a low pass through the towers a decision.
  if (cityHit(nx, ny, nz) && planeSpeed > 10) { planeCrash('INTO THE BUILDING'); return; }
  if (ny <= gy2) {                                   // touching down
    // a safe landing is flat and slow: nose near level, wings level. Come in nose-down
    // (a dive) or dropping fast and you pile in.
    const steep = Math.abs(planePitch) > 0.3 || Math.abs(planeRoll) > 0.5;
    if ((-vy > CRASH_VY || steep) && planeSpeed > 8) { planeCrash(); return; }
    if (wasFlying && planeSpeed > 5) { onTouchdown(vy); sfxTouchdown(-vy); }
    wasFlying = false;
    plane.position.y = gy2; planePitch = 0;
  } else { plane.position.y = ny; wasFlying = true; }
  // ditching: the sea bed is simply terrain below sea level, so "in water" is a height
  // test rather than the river polygon it used to be
  if (gy2 < SEA_Y && plane.position.y < SEA_Y + 2.2) { planeCrash(); return; }

  plane.rotation.set(-planePitch, planeHeading, -planeRoll);
  const pr = plane.children[0] && plane.children[0].userData.prop;
  if (pr) pr.rotation.z += (6 + planeSpeed * 0.6) * dt;
  planeShadow.position.set(plane.position.x, gy2 + 0.09, plane.position.z);
  planeShadow.rotation.z = -planeHeading;
}

function updatePilot(dt) {
  const gy = terrainH(pilot.position.x, pilot.position.z);
  if (!pilotDown) {
    // terminal velocity under canopy is the whole difference between the two states
    pilotVel.y -= (chuteOpen ? 14 : 26) * dt;
    if (chuteOpen && pilotVel.y < -CHUTE_FALL) pilotVel.y = -CHUTE_FALL;
    const drag = chuteOpen ? 1.4 : 0.25;
    pilotVel.x -= pilotVel.x * Math.min(1, drag * dt);
    pilotVel.z -= pilotVel.z * Math.min(1, drag * dt);
    pilot.position.x = clamp(pilot.position.x + pilotVel.x * dt, -WORLD, WORLD);
    pilot.position.z = clamp(pilot.position.z + pilotVel.z * dt, -WORLD, WORLD);
    pilot.position.y += pilotVel.y * dt;
    if (pilot.position.y <= gy) {
      pilot.position.y = gy; pilotDown = true; chute.visible = false;
      if (gy < SEA_Y) toast('IN THE DRINK — R to fly again');
      else if (!chuteOpen) toast('…that hurt. R to fly again');
      else if (!scoreDropIfNear()) toast('DOWN SAFE — R to fly again');
    }
    pilot.rotation.y += dt * (chuteOpen ? 0.4 : 2.2);
  }
  pilotShadow.position.set(pilot.position.x, gy + 0.06, pilot.position.z);
}

// =================================================================
//  TRAFFIC — cars on the roads, people in the towns
//  Everything drives along the polylines the road and street builders already left
//  behind, so the traffic is on the network by construction rather than by collision
//  testing. Two instanced meshes for the whole world.
//
//  Only what is near enough to see is positioned each frame. The arc-length parameter
//  advances for every vehicle regardless — that is three floats of arithmetic — but the
//  terrain sample and the matrix write, which are the expensive parts, happen only
//  inside the cull radius. Traffic you cannot see costs almost nothing.
// =================================================================
function preparePath(pts) {
  const cum = new Float32Array(pts.length);
  for (let i = 1; i < pts.length; i++)
    cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return { pts, cum, len: cum[cum.length - 1] };
}
const _sp = { x: 0, z: 0, tx: 0, tz: 1 };
function samplePath(P, s) {
  const cum = P.cum;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const a = P.pts[lo], b = P.pts[hi];
  const seg = cum[hi] - cum[lo] || 1;
  const f = clamp01((s - cum[lo]) / seg);
  _sp.x = a[0] + (b[0] - a[0]) * f;
  _sp.z = a[1] + (b[1] - a[1]) * f;
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
  _sp.tx = dx / L; _sp.tz = dz / L;
}

const HIGHWAYS = roadPaths.filter(p => p.length > 1).map(preparePath);
const STREETS = STREET_PATHS.filter(p => p.length > 1).map(preparePath);
const DRIVEABLE = HIGHWAYS.concat(STREETS);

const CAR_CULL = 2600, PED_CULL = 700;
const CAR_COLS = [0xd8483a, 0x2f6fb8, 0xe8e4dc, 0x2b2f38, 0xd9a72c, 0x4b8f52, 0x8a8f98, 0xb84f8a];
const cars = [], peds = [];
let carMesh = null, pedMesh = null;

if (DRIVEABLE.length) {
  // one car per ~330 m of road, capped — enough that a road is never empty and never a
  // traffic jam, and few enough that the whole world's traffic is one draw call
  const totalLen = DRIVEABLE.reduce((a, p) => a + p.len, 0);
  const N = Math.min(420, Math.max(40, Math.round(totalLen / 330)));
  for (let i = 0; i < N; i++) {
    // pick a path with probability proportional to its length, deterministically
    let r = hash2i(i * 3571, 91) * totalLen, P = DRIVEABLE[0];
    for (const p of DRIVEABLE) { if (r <= p.len) { P = p; break; } r -= p.len; }
    const street = STREETS.includes(P);
    cars.push({ P, s: hash2i(i, 17) * P.len, dir: hash2i(i, 29) > 0.5 ? 1 : -1,
      spd: street ? 7 + hash2i(i, 31) * 5 : 17 + hash2i(i, 37) * 12,
      col: CAR_COLS[(hash2i(i, 41) * CAR_COLS.length) | 0],
      truck: !street && hash2i(i, 53) > 0.78 });
  }
  const body = merge([
    baked(BOX(1.9, 1.1, 4.3), 0, 0.55, 0),
    baked(BOX(1.7, 0.85, 2.1), 0, 1.4, -0.25),
  ]);
  carMesh = new THREE.InstancedMesh(body, new THREE.MeshToonMaterial({ gradientMap: RAMP }), cars.length);
  carMesh.frustumCulled = false; carMesh.count = 0;
  scene.add(carMesh);
}

if (STREETS.length) {
  const N = Math.min(360, STREETS.length * 5);
  for (let i = 0; i < N; i++) {
    const P = STREETS[(hash2i(i * 7717, 5) * STREETS.length) | 0];
    peds.push({ P, s: hash2i(i, 61) * P.len, dir: hash2i(i, 67) > 0.5 ? 1 : -1,
      spd: 1.1 + hash2i(i, 71) * 0.8, side: hash2i(i, 73) > 0.5 ? 1 : -1,
      col: [0x2f4a7a, 0x8a3a3a, 0x3a6a4a, 0x6a4a7a, 0xc8b48a, 0x40444c][(hash2i(i, 79) * 6) | 0],
      ph: hash2i(i, 83) * 6.28 });
  }
  const fig = merge([
    baked(BOX(0.46, 0.95, 0.3), 0, 0.95, 0),
    baked(new THREE.SphereGeometry(0.21, 6, 4), 0, 1.62, 0),
    baked(BOX(0.2, 0.75, 0.22), -0.13, 0.38, 0), baked(BOX(0.2, 0.75, 0.22), 0.13, 0.38, 0),
  ]);
  pedMesh = new THREE.InstancedMesh(fig, new THREE.MeshToonMaterial({ gradientMap: RAMP }), peds.length);
  pedMesh.frustumCulled = false; pedMesh.count = 0;
  scene.add(pedMesh);
}

const _tc = new THREE.Color();
function updateTraffic(dt, px, pz) {
  if (carMesh) {
    let n = 0;
    for (const c of cars) {
      c.s += c.spd * c.dir * dt;
      if (c.s > c.P.len) c.s -= c.P.len; else if (c.s < 0) c.s += c.P.len;
      // cheap reject on the path's own midpoint before touching the height field
      const p0 = c.P.pts[0];
      if ((p0[0] - px) ** 2 + (p0[1] - pz) ** 2 > (CAR_CULL + c.P.len) ** 2) continue;
      samplePath(c.P, c.s);
      if ((_sp.x - px) ** 2 + (_sp.z - pz) ** 2 > CAR_CULL * CAR_CULL) continue;
      // keep to one side of the centreline, so oncoming traffic passes properly
      const ox = -_sp.tz * 2.6 * c.dir, oz = _sp.tx * 2.6 * c.dir;
      const x = _sp.x + ox, z = _sp.z + oz;
      dummy.position.set(x, terrainH(x, z) + 0.35, z);
      dummy.rotation.set(0, Math.atan2(_sp.tx * c.dir, _sp.tz * c.dir), 0);
      dummy.scale.set(1, 1, c.truck ? 1.9 : 1);
      dummy.updateMatrix();
      carMesh.setMatrixAt(n, dummy.matrix);
      carMesh.setColorAt(n, _tc.set(c.col));
      if (++n >= cars.length) break;
    }
    carMesh.count = n;
    if (n) { carMesh.instanceMatrix.needsUpdate = true; if (carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true; }
  }
  if (pedMesh) {
    let n = 0;
    for (const p of peds) {
      p.s += p.spd * p.dir * dt;
      if (p.s > p.P.len) p.s -= p.P.len; else if (p.s < 0) p.s += p.P.len;
      const p0 = p.P.pts[0];
      if ((p0[0] - px) ** 2 + (p0[1] - pz) ** 2 > (PED_CULL + p.P.len) ** 2) continue;
      samplePath(p.P, p.s);
      if ((_sp.x - px) ** 2 + (_sp.z - pz) ** 2 > PED_CULL * PED_CULL) continue;
      const ox = -_sp.tz * 8.5 * p.side, oz = _sp.tx * 8.5 * p.side;   // on the pavement
      const x = _sp.x + ox, z = _sp.z + oz;
      const bob = Math.abs(Math.sin(p.ph + p.s * 1.7)) * 0.08;
      dummy.position.set(x, terrainH(x, z) + bob, z);
      // A low pass turns heads. Inside 180 m and under 160 m of air they stop walking the
      // way they were going and crane round at you, leaning back as you get closer — the
      // cheapest possible acknowledgement that the aeroplane is a thing in their world.
      const lookX = plane.position.x - x, lookZ = plane.position.z - z;
      const near = lookX * lookX + lookZ * lookZ < 180 * 180;
      const low = plane.position.y - terrainH(x, z) < 160;
      if (near && low && mode === 'plane') {
        dummy.rotation.set(0, Math.atan2(lookX, lookZ), 0);
        dummy.rotation.x = -0.34;                       // heads back
      } else {
        dummy.rotation.set(0, Math.atan2(_sp.tx * p.dir, _sp.tz * p.dir), 0);
      }
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      pedMesh.setMatrixAt(n, dummy.matrix);
      pedMesh.setColorAt(n, _tc.set(p.col));
      if (++n >= peds.length) break;
    }
    pedMesh.count = n;
    if (n) { pedMesh.instanceMatrix.needsUpdate = true; if (pedMesh.instanceColor) pedMesh.instanceColor.needsUpdate = true; }
  }
}
console.log(`traffic: ${cars.length} vehicles over ${HIGHWAYS.length} highways and ${STREETS.length} streets, ${peds.length} people`);
// =================================================================
//  OTHER TRAFFIC IN THE AIR
//  An empty sky is the fastest way to make forty kilometres feel like a diorama. These
//  are scenery with a flight path, not aircraft: nothing here collides with anything, so
//  you can fly straight through the airliner if you insist. Everything is analytic and
//  seeded, so the same aeroplane is in the same piece of sky on every load.
//
//  Headings are derived from the analytic velocity rather than stored, because a stored
//  heading and a computed position drift apart the moment either one is edited. Roll
//  comes off the turn rate through the same constant updatePlane uses (heading moves at
//  roll * 0.5), so a banked AI turn looks like a banked player turn.
// =================================================================
const airGroup = new THREE.Group(); scene.add(airGroup);
const flyers = [];
let airT = 0;

function buildAirliner() {
  const g = new THREE.Group();
  const body = toon(0xeceae4), trim = toon(0x2f6fb8), dark = toon(0x3a3f47);
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 32, 12).rotateX(Math.PI / 2), body));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.9, 4.6, 12).rotateX(Math.PI / 2), body);
  nose.position.z = 18.2; g.add(nose);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1.9, 6.5, 12).rotateX(-Math.PI / 2), body);
  cone.position.z = -19.2; g.add(cone);
  const wing = new THREE.Mesh(BOX(38, 0.75, 6.4), body); wing.position.set(0, -0.7, -1.5); g.add(wing);
  const tp = new THREE.Mesh(BOX(14, 0.6, 3.4), body); tp.position.set(0, 0.7, -15.4); g.add(tp);
  const fin = new THREE.Mesh(BOX(0.75, 7.6, 5.0), trim); fin.position.set(0, 4.5, -15.8); g.add(fin);
  for (const s of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 6.2, 10).rotateX(Math.PI / 2), dark);
    pod.position.set(s * 10.5, -2.3, 0.4); g.add(pod);
  }
  return g;
}

// One light-aircraft shell for both the crop duster and the glider — the glider just
// gets a much longer, thinner wing and no propeller, which is the whole difference at
// the distance you ever see them from.
function buildLight(col, span, glider) {
  const g = new THREE.Group();
  const body = toon(col), white = toon(0xf2efe7), dark = toon(0x2b2f38);
  g.add(new THREE.Mesh(merge([baked(BOX(1.5, 1.4, 6.2), 0, 0, 0),
                              baked(BOX(0.95, 0.95, 2.4), 0, 0.25, -3.7)]), body));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.2, 12).rotateX(Math.PI / 2), body);
  nose.position.z = 3.5; g.add(nose);
  const wing = new THREE.Mesh(BOX(span, 0.26, glider ? 1.25 : 1.9), white);
  wing.position.set(0, glider ? 0.5 : -0.3, 0.4); g.add(wing);
  const tail = new THREE.Mesh(BOX(3.8, 0.24, 1.1), white); tail.position.set(0, 0.55, -4.3); g.add(tail);
  const fin = new THREE.Mesh(BOX(0.26, 1.6, 1.5), white); fin.position.set(0, 1.25, -4.3); g.add(fin);
  if (!glider) {
    const prop = new THREE.Group();
    prop.add(new THREE.Mesh(BOX(0.18, 3.1, 0.12), dark));
    prop.add(new THREE.Mesh(BOX(3.1, 0.18, 0.12), dark));
    prop.position.z = 4.15; g.add(prop);
    spinners.push({ o: prop, spd: 22 });
  }
  return g;
}

function buildBalloon(colA, colB) {
  const g = new THREE.Group();
  const env = new THREE.Mesh(new THREE.SphereGeometry(8.5, 16, 12), toon(colA));
  env.scale.set(1, 1.2, 1); env.position.y = 13; g.add(env);
  const band = new THREE.Mesh(new THREE.TorusGeometry(8.4, 1.05, 6, 18).rotateX(Math.PI / 2), toon(colB));
  band.position.y = 13.4; g.add(band);
  const skirt = new THREE.Mesh(new THREE.ConeGeometry(4.6, 5.2, 12), toon(colB));
  skirt.position.y = 4.4; skirt.rotation.x = Math.PI; g.add(skirt);
  const basket = new THREE.Mesh(BOX(2.8, 2.4, 2.8), toon(0x8d5a3a));
  basket.position.y = 0.6; g.add(basket);
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const rope = new THREE.Mesh(BOX(0.16, 3.4, 0.16), toon(0x4a4038));
    rope.position.set(sx * 1.2, 3.2, sz * 1.2); g.add(rope);
  }
  return g;
}

// Somewhere worth working a field or circling: flat, dry land, away from the sea.
function farmSpot(seed) {
  for (let i = 0; i < 400; i++) {
    const a = hash2i(seed + i * 31, 7) * 6.283185, r = 1800 + hash2i(seed + i * 53, 11) * 12000;
    const x = HOME.x + Math.cos(a) * r, z = HOME.z + Math.sin(a) * r;
    const y = terrainH(x, z, SMP);
    if (y < 25 || SMP.rw > 0.01 || SMP.cw > 0.01) continue;
    const e = 90;
    if (Math.hypot(terrainH(x + e, z) - y, terrainH(x, z + e) - y) / e > 0.05) continue;
    return { x, z, y };
  }
  return { x: HOME.x, z: HOME.z, y: HOME.y };
}

{
  const add = (o, f) => { airGroup.add(o); f.o = o; flyers.push(f); return f; };
  // two airliners, high enough that they are a shape and a contrail's worth of interest
  for (let i = 0; i < 2; i++) {
    const a = hash2i(i * 977, 3) * 6.283185;
    add(buildAirliner(), { kind: 'liner', spd: 105 + i * 18,
      y: 2400 + hash2i(i, 5) * 900, dx: Math.sin(a), dz: Math.cos(a),
      ox: HOME.x + (hash2i(i, 9) - 0.5) * 9000, oz: HOME.z + (hash2i(i, 13) - 0.5) * 9000,
      s: hash2i(i, 17) * WORLD * 2 });
  }
  // two crop dusters working a field each: long passes, hard turns at the headland
  for (let i = 0; i < 2; i++) {
    const c = farmSpot(4400 + i * 700);
    const A = 620 + hash2i(i, 23) * 220, B = 130 + hash2i(i, 29) * 70;
    add(buildLight(i ? 0xd9a72c : 0x4b8f52, 10, false), { kind: 'duster', c, A, B,
      rot: hash2i(i, 31) * 3.14159, spd: 44 + hash2i(i, 37) * 12,
      per: A * 4 + 2 * Math.PI * B, s: hash2i(i, 41) * 2000,
      agl: 32 + hash2i(i, 43) * 14 });
  }
  // two gliders sharing a thermal — the one you can actually join. The radius is what a
  // glider would really turn (95-150 m at 25-33 m/s), which is what puts a proper 35°
  // of bank on them; a lazier 190 m circle looked like it was on rails.
  const th = farmSpot(9100);
  for (let i = 0; i < 2; i++) {
    add(buildLight(0xf2efe7, 18, true), { kind: 'glider', c: th,
      r: 95 + i * 55, w: 0.26 - i * 0.04, a0: i * 2.4,
      base: 620 + i * 240, bob: 130, bobW: 0.055 + i * 0.012 });
  }
  // four balloons drifting, one of them over BALLOON MEADOW where it belongs
  const meadow = LANDMARKS.find(l => l.name === 'BALLOON MEADOW');
  const BC = [[0xd8483a, 0xf2efe7], [0x3f8fc4, 0xffd23b], [0x4f9440, 0xf2efe7], [0xffd23b, 0xd8483a]];
  for (let i = 0; i < 4; i++) {
    const home = i === 0 && meadow ? meadow : farmSpot(2200 + i * 311);
    const a = hash2i(i * 71, 19) * 6.283185;
    add(buildBalloon(BC[i][0], BC[i][1]), { kind: 'balloon',
      ox: home.x, oz: home.z, dx: Math.sin(a), dz: Math.cos(a),
      spd: 2.2 + hash2i(i, 47) * 1.8, s: hash2i(i, 59) * 6000,
      base: 150 + hash2i(i, 61) * 210, bob: 26, bobW: 0.075 + hash2i(i, 67) * 0.03,
      spin: (hash2i(i, 71) - 0.5) * 0.16 });
  }
}

// Heading from the analytic velocity, bank from the actual turn: tan(bank) = v*omega/g,
// which is the real relationship rather than the player model's tuned one. It matters
// because it ties bank to how tight the circle is — a glider had an 11° lean until the
// thermal was tightened to a radius a glider would really use, and then it fell out at
// the 35° it should be, with no fudge factor.
const G_BANK = 9.81;
function aim(o, vx, vz, omega) {
  const v = Math.hypot(vx, vz);
  o.rotation.order = 'YXZ';
  o.rotation.set(0, Math.atan2(vx, vz), -clamp(Math.atan(v * omega / G_BANK), -1.05, 1.05));
}
// Everything that drifts stays inside the world; an airliner forty kilometres off the
// edge is just a dropped frame's worth of matrix maths nobody will ever see.
const wrapW = v => ((v + WORLD) % (WORLD * 2) + WORLD * 2) % (WORLD * 2) - WORLD;

function updateAirspace(dt) {
  airT += dt;
  for (const f of flyers) {
    const o = f.o;
    if (f.kind === 'liner') {
      f.s += f.spd * dt;
      o.position.set(wrapW(f.ox + f.dx * f.s), f.y, wrapW(f.oz + f.dz * f.s));
      aim(o, f.dx * f.spd, f.dz * f.spd, 0);
    } else if (f.kind === 'duster') {
      // A racetrack, not an ellipse: an ellipse walked at a constant parameter runs five
      // times faster down the straights than round the ends, which reads as an aeroplane
      // repeatedly stalling and accelerating. Walking arc length instead keeps the speed
      // honest and puts all the bank where it belongs, in the turns.
      f.s = (f.s + f.spd * dt) % f.per;
      const R = f.B, L = f.A * 2;
      let lx, lz, vx0, vz0, om;
      let s = f.s;
      if (s < L) { lx = -f.A + s; lz = -R; vx0 = 1; vz0 = 0; om = 0; }
      else if (s < L + Math.PI * R) {
        const a = (s - L) / R - Math.PI / 2;
        lx = f.A + Math.cos(a) * R; lz = Math.sin(a) * R;
        vx0 = -Math.sin(a); vz0 = Math.cos(a); om = f.spd / R;
      } else if (s < L * 2 + Math.PI * R) {
        const u = s - (L + Math.PI * R);
        lx = f.A - u; lz = R; vx0 = -1; vz0 = 0; om = 0;
      } else {
        const a = (s - (L * 2 + Math.PI * R)) / R + Math.PI / 2;
        lx = -f.A + Math.cos(a) * R; lz = Math.sin(a) * R;
        vx0 = -Math.sin(a); vz0 = Math.cos(a); om = f.spd / R;
      }
      const cr = Math.cos(f.rot), sr = Math.sin(f.rot);
      const x = f.c.x + lx * cr - lz * sr, z = f.c.z + lx * sr + lz * cr;
      const vx = (vx0 * cr - vz0 * sr) * f.spd, vz = (vx0 * sr + vz0 * cr) * f.spd;
      o.position.set(x, terrainH(x, z) + f.agl, z);
      aim(o, vx, vz, om);
    } else if (f.kind === 'glider') {
      const a = f.a0 + airT * f.w;
      const x = f.c.x + Math.cos(a) * f.r, z = f.c.z + Math.sin(a) * f.r;
      const vx = -Math.sin(a) * f.r * f.w, vz = Math.cos(a) * f.r * f.w;
      o.position.set(x, f.c.y + f.base + Math.sin(airT * f.bobW) * f.bob, z);
      aim(o, vx, vz, f.w);
    } else {
      f.s += f.spd * dt;
      const x = wrapW(f.ox + f.dx * f.s), z = wrapW(f.oz + f.dz * f.s);
      o.position.set(x, terrainH(x, z) + f.base + Math.sin(airT * f.bobW) * f.bob, z);
      o.rotation.set(0, airT * f.spin, 0);       // balloons point nowhere; they just turn
    }
  }
}
console.log(`airspace: ${flyers.filter(f => f.kind !== 'balloon').length} aircraft, `
  + `${flyers.filter(f => f.kind === 'balloon').length} balloons`);

// =================================================================
//  SOUND  (N to mute)
//  Synthesised, no assets — the whole point of a single self-contained file is that it
//  stays one file. The engine is two detuned sawtooths through a lowpass: the detune is
//  what gives a propeller its beat, and the filter opening with throttle is what makes
//  it sound like it is working rather than just getting louder. Wind is filtered noise
//  rising with airspeed, which is most of what selling speed actually takes.
//
//  Nothing is created until the first key or click, because a browser will not let an
//  AudioContext start before a gesture and a suspended one leaks warnings forever.
// =================================================================
let audioOn = true, AC = null, engGain, engFilt, osc1, osc2, windGain, master;

function initAudio() {
  // A context created outside a gesture starts suspended and stays that way, silently.
  // Cheap to re-check on every keypress, and it is the only way to be sure.
  if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  AC = new Ctx();
  master = AC.createGain(); master.gain.value = 0.55; master.connect(AC.destination);

  engFilt = AC.createBiquadFilter(); engFilt.type = 'lowpass'; engFilt.frequency.value = 400;
  engGain = AC.createGain(); engGain.gain.value = 0;
  osc1 = AC.createOscillator(); osc1.type = 'sawtooth'; osc1.frequency.value = 60;
  osc2 = AC.createOscillator(); osc2.type = 'sawtooth'; osc2.frequency.value = 60.7;
  osc1.connect(engFilt); osc2.connect(engFilt);
  engFilt.connect(engGain); engGain.connect(master);
  osc1.start(); osc2.start();

  // one second of white noise, looped, for the slipstream
  const buf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = AC.createBufferSource(); src.buffer = buf; src.loop = true;
  const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
  windGain = AC.createGain(); windGain.gain.value = 0;
  src.connect(bp); bp.connect(windGain); windGain.connect(master);
  src.start();
  if (AC.state === 'suspended') AC.resume();
  console.log(`audio: ${AC.state} @ ${AC.sampleRate} Hz`);
}

// a short filtered noise burst — every impact in the game is a flavour of this
function bump(vol, freq, dur, type) {
  if (!AC || !audioOn) return;
  const n = Math.floor(AC.sampleRate * dur);
  const buf = AC.createBuffer(1, n, AC.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
  const src = AC.createBufferSource(); src.buffer = buf;
  const f = AC.createBiquadFilter(); f.type = type || 'lowpass'; f.frequency.value = freq;
  const g = AC.createGain(); g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(master);
  src.start();
}
const sfxTouchdown = s => bump(clamp(s / 14, 0.15, 0.8), 240, 0.32);
const sfxCrash = () => { bump(0.95, 160, 1.1); bump(0.5, 2600, 0.55, 'highpass'); };
const sfxChute = () => bump(0.5, 700, 0.5, 'bandpass');

function updateAudio(dt) {
  if (!AC) return;
  const want = audioOn && !paused && mode === 'plane';
  const spd = planeSpeed / PLANE_MAX;
  // the engine note follows commanded power, not speed: it should pick up the instant
  // you open the throttle, not once the aeroplane has got round to accelerating
  const thr = want ? ((autoFly || keys['KeyW']) ? 1 : keys['KeyS'] ? 0.12 : 0.4) : 0;
  const tgt = AC.currentTime + 0.08;
  osc1.frequency.linearRampToValueAtTime(52 + thr * 78 + spd * 26, tgt);
  osc2.frequency.linearRampToValueAtTime(52.9 + thr * 78 + spd * 26, tgt);
  engFilt.frequency.linearRampToValueAtTime(320 + thr * 1500, tgt);
  engGain.gain.linearRampToValueAtTime(want ? 0.055 + thr * 0.075 : 0, tgt);
  // wind goes with the square of airspeed, the way it actually sounds from a cockpit
  windGain.gain.linearRampToValueAtTime(
    audioOn && !paused ? clamp(spd * spd * 0.32, 0, 0.34) : 0, tgt);
}

// =================================================================
//  THE MAP  (M)
//  A pull-back-and-look-down view of the whole world. It cannot use the streaming
//  terrain — that only ever exists within ~16 km of the aeroplane — so it gets its own
//  single coarse mesh of the entire 40 x 40 km, built once, the first time you ask for
//  it. That mesh is only ever visible in map view, and the chunked terrain is hidden
//  while it is, because the two sample the same height field and would z-fight.
// =================================================================
let mapView = false, mapZoom = 1, mapMesh = null, mapReady = false;
let mapPanX = 0, mapPanZ = 0;      // drag-to-scroll offset, relative to the aircraft
let pipHalo = null;
const mapMarks = new THREE.Group(); mapMarks.visible = false; scene.add(mapMarks);
const elMapLabels = document.getElementById('mapLabels');
// 52 m a cell over the whole 40 km. The old 176 was 227 m a cell, which stair-stepped
// every coastline and lost the roads entirely. Past this the limit stops being the mesh:
// at maximum zoom the camera is 2.3 km up and a cell is thirty screen pixels whatever
// you do, so the extra memory buys nothing you can see.
const MAP_RES = 768;
// What the first press of M gets if the fine one is not finished yet. Cheap enough
// (~90 ms) to build on the spot, which is exactly what the map used to cost.
const MAP_RES_COARSE = 176;
let playerPip = null;
let mapBuild = null, mapFineDone = false;

// The build is one pass of terrainH per vertex, and at this resolution that is 590k
// samples — about 1.2 s in a browser, which is a frozen aeroplane if it is spent in one
// frame. So it is split into rows and paid for a few milliseconds at a time, the same
// way the scatter is. Phases run in order because each one needs the whole of the last:
// the normals read the row above and below, and the index needs every vertex to exist.
function mapState(res) {
  const n = res + 1;
  return {
    res, n, step: (WORLD * 2) / res, phase: 0, row: 0,
    pos: new Float32Array(n * n * 3), nor: new Float32Array(n * n * 3),
    col: new Float32Array(n * n * 3), HH: new Float32Array(n * n),
    idx: new Uint32Array(res * res * 6),
  };
}

const _mc3 = new THREE.Color();
// Phase 0 — heights, and the biome weights parked in the colour buffer until phase 1
// needs them. terrainH only hands back the weights through SMP, so they have to be
// taken as we go rather than sampled a second time.
function mapSampleRow(B, j) {
  const { n, step, HH, col } = B;
  for (let i = 0; i < n; i++) {
    const k = j * n + i, k3 = k * 3;
    HH[k] = terrainH(-WORLD + i * step, -WORLD + j * step, SMP);
    col[k3] = SMP.wAr; col[k3 + 1] = SMP.wMtn; col[k3 + 2] = SMP.cw;
  }
}
// Phase 1 — position, normal from the four neighbours, and the terrain palette.
function mapShadeRow(B, j) {
  const { n, step, HH, pos, nor, col } = B;
  for (let i = 0; i < n; i++) {
    const k = j * n + i, k3 = k * 3;
    const x = -WORLD + i * step, z = -WORLD + j * step, y = HH[k];
    const hl = HH[k - (i > 0 ? 1 : 0)], hr = HH[k + (i < n - 1 ? 1 : 0)];
    const hd = HH[k - (j > 0 ? n : 0)], hu = HH[k + (j < n - 1 ? n : 0)];
    let nx2 = hl - hr, ny2 = 2 * step, nz2 = hd - hu;
    const inv = 1 / Math.hypot(nx2, ny2, nz2);
    pos[k3] = x; pos[k3 + 1] = y; pos[k3 + 2] = z;
    nor[k3] = nx2 * inv; nor[k3 + 1] = ny2 * inv; nor[k3 + 2] = nz2 * inv;
    const wa = col[k3], wm = col[k3 + 1], cw = col[k3 + 2];
    terrainColor(y, ny2 * inv, y > 0 ? 1 : 0, 1 - wa - wm, wa, wm, 0, cw,
      vnoise(x * 0.021, z * 0.021), _mc3);
    col[k3] = _mc3.r; col[k3 + 1] = _mc3.g; col[k3 + 2] = _mc3.b;
  }
}
// Phase 2 — two triangles a cell.
function mapIndexRow(B, j) {
  const { n, res, idx } = B;
  let t = j * res * 6;
  for (let i = 0; i < res; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx[t++] = a; idx[t++] = c; idx[t++] = b; idx[t++] = b; idx[t++] = c; idx[t++] = d;
  }
}
function mapToMesh(B) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(B.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(B.nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(B.col, 3));
  g.setIndex(new THREE.BufferAttribute(B.idx, 1));
  const m = new THREE.Mesh(g, mapMat);
  m.visible = false; m.frustumCulled = false;
  scene.add(m);
  return m;
}

// Advance the fine map by whatever fits in the budget. Rows are ~1.5 ms each at this
// resolution, so the budget is a floor rather than a ceiling — one row always runs.
// With the map open there is nothing else drawing (the world is hidden), so it gets a
// much bigger slice and finishes in a second or so rather than trickling.
function pumpMapBuild(budgetMs) {
  if (!mapBuild || mapFineDone) return;
  const B = mapBuild, t0 = performance.now();
  do {
    if (B.phase === 0) mapSampleRow(B, B.row++);
    else if (B.phase === 1) mapShadeRow(B, B.row++);
    else mapIndexRow(B, B.row++);
    const done = B.phase === 2 ? B.res : B.n;
    if (B.row >= done) { B.phase++; B.row = 0; }
    if (B.phase > 2) {
      const fine = mapToMesh(B);
      if (mapMesh) { scene.remove(mapMesh); mapMesh.geometry.dispose(); }
      mapMesh = fine; mapMesh.visible = mapView;
      mapBuild = null; mapFineDone = true; mapReady = true;
      console.log(`map: ${B.res} x ${B.res}, ${((WORLD * 2) / B.res).toFixed(0)} m a cell`);
      if (mapView) toast('MAP SHARPENED');
      return;
    }
  } while (performance.now() - t0 < budgetMs);
}

function buildMapMarks() {
  // markers: a pin per place, plus an arrow for you. Scaled every frame so they stay
  // the same size on screen however far the view is pulled back.
  for (const p of PLACES) {
    const isTown = TOWNS.some(t => t.name === p.name);
    const pin = new THREE.Mesh(new THREE.ConeGeometry(p.kind === 'race' ? 1.5 : 1, 2.4, 5),
      new THREE.MeshBasicMaterial({
        color: p.kind === 'race' ? 0xffd23b : isTown ? 0xffffff : 0xff7a2b }));
    pin.position.set(p.x, terrainH(p.x, p.z) + 1.2, p.z);
    pin.userData.place = p;
    mapMarks.add(pin);
  }
  // An actual aeroplane silhouette, and a big one. A cone the same size as the town
  // pins is impossible to pick out of a dozen of them, and knowing where you are is
  // the entire job of the map.
  playerPip = new THREE.Mesh(merge([
    baked(BOX(0.9, 0.4, 7.0), 0, 0, 0),                    // fuselage
    baked(BOX(7.4, 0.4, 1.5), 0, 0, 0.6),                  // wings
    baked(BOX(3.0, 0.4, 1.0), 0, 0, -2.9),                 // tailplane
  ]), new THREE.MeshBasicMaterial({ color: 0xffd23b }));
  playerPip.renderOrder = 4;
  mapMarks.add(playerPip);
  // a dark disc under it so the yellow reads over snow and desert alike
  pipHalo = new THREE.Mesh(new THREE.CircleGeometry(6.2, 20).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: INK_COLOR, transparent: true, opacity: 0.55 }));
  pipHalo.renderOrder = 3;
  mapMarks.add(pipHalo);

  for (const p of PLACES) {
    const d = document.createElement('div');
    d.className = 'mapLbl'; d.textContent = p.name;
    elMapLabels.appendChild(d); p.el = d;
  }
}

// Kicked off as soon as the world exists, so by the time anyone thinks to press M the
// sharp map is usually already sitting there.
function startMapBuild() {
  mapBuild = mapState(MAP_RES);
  buildMapMarks();
}

// Everything in one go, for the coarse stand-in.
function buildMapMesh(res) {
  const B = mapState(res);
  for (let j = 0; j < B.n; j++) mapSampleRow(B, j);
  for (let j = 0; j < B.n; j++) mapShadeRow(B, j);
  for (let j = 0; j < res; j++) mapIndexRow(B, j);
  return mapToMesh(B);
}

function toggleMap() {
  if (!mapReady) {
    // The fine one is still coming. Draw the old coarse map now so M is never a wait,
    // and let the pump swap the sharp one in underneath you when it lands.
    toast('DRAWING THE MAP…');
    mapMesh = buildMapMesh(MAP_RES_COARSE);
    mapReady = true;
  }
  mapView = !mapView;
  mapPanX = mapPanZ = 0;                   // always open centred on the aircraft
  mapMesh.visible = mapView; mapMarks.visible = mapView;
  terrainGroup.visible = !mapView;
  for (const s of SPECIES) s.mesh.visible = !mapView;
  cloudMesh.visible = !mapView;
  airGroup.visible = !mapView;              // an airliner floating over the map is not a map
  raceGroup.visible = !mapView;
  trackGroup.visible = mapView;
  if (mapView) buildTrack();                // only the map ever looks at where you have been
  elMapLabels.style.display = mapView ? 'block' : 'none';
  camSettled = false;
}

const _proj = new THREE.Vector3();
function updateMapOverlay() {
  const H = camera.position.y;
  const s = H / 240;                       // keep pins a constant size on screen
  for (const m of mapMarks.children) {
    m.scale.setScalar(s);
    // a landmark you have not flown to is simply not on your map yet
    const p = m.userData.place;
    if (p && p.kind === 'mark') m.visible = found.has(p.name);
  }
  const sx = mode === 'plane' ? plane.position.x : pilot.position.x;
  const sz = mode === 'plane' ? plane.position.z : pilot.position.z;
  const gy = terrainH(sx, sz);
  const hdg = mode === 'plane' ? planeHeading : pilot.rotation.y;
  playerPip.scale.setScalar(s * 3.4);      // deliberately outsized against the pins
  playerPip.position.set(sx, gy + 9 * s, sz);
  playerPip.rotation.set(0, hdg, 0);
  pipHalo.scale.setScalar(s * 3.4);
  pipHalo.position.set(sx, gy + 7 * s, sz);
  for (const p of PLACES) {
    if (!p.el) continue;
    _proj.set(p.x, terrainH(p.x, p.z), p.z).project(camera);
    // Fields and towns are always named; the thirteen landmarks cluster tightly enough
    // that at full zoom-out their labels sit on top of each other, so they wait until
    // you have zoomed in far enough to read them.
    let vis = _proj.z < 1 && Math.abs(_proj.x) < 1.1 && Math.abs(_proj.y) < 1.1;
    if (p.kind === 'mark' && (mapZoom < 1.8 || !found.has(p.name))) vis = false;
    p.el.style.display = vis ? 'block' : 'none';
    if (!vis) continue;
    p.el.style.left = ((_proj.x * 0.5 + 0.5) * innerWidth) + 'px';
    p.el.style.top = ((-_proj.y * 0.5 + 0.5) * innerHeight - 22) + 'px';
  }
}

// =================================================================
//  THE RECORDS SCREEN
//  Everything that is kept between sessions, on one page. Without this the race times
//  and the limbo counts are real but invisible, which is the same as not existing.
// =================================================================
const elBook = document.getElementById('book');
let bookOpen = false;
function toggleBook() {
  bookOpen = !bookOpen;
  elBook.classList.toggle('show', bookOpen);
  if (!bookOpen) return;
  const rows = (list, empty) => list.length
    ? `<div class="r">${list.join('')}</div>`
    : `<div class="r dim"><span>${empty}</span><u></u></div>`;
  const fields = STRIPS.filter(s => landingBest[s.name])
    .sort((a, b) => landingBest[b.name] - landingBest[a.name])
    .map(s => `<span>${s.name}</span><u>${landingBest[s.name]}</u>`);
  const recent = logbook.log.map(l =>
    `<span>${l.f}</span><u>${l.g} · ${l.s} · ${l.k.toFixed(1)} m/s</u>`);
  const races = RACES.map(R => `<span>${R.name}</span><u>${
    chRec.race[R.name] ? fmtT(chRec.race[R.name]) : '—'}</u>`);
  const limbos = LIMBOS.map(L => `<span>${L.name}</span><u>${chRec.limbo[L.name] || 0}</u>`);
  elBook.innerHTML =
    `<h2>LOGBOOK</h2>`
    + `<h3>BEST LANDING BY FIELD</h3>${rows(fields, 'nothing landed yet')}`
    + `<h3>LAST ${Math.min(LOG_MAX, logbook.log.length)} LANDINGS</h3>${rows(recent, 'nothing landed yet')}`
    + `<h3>COURSE BEST</h3>${rows(races, 'no courses')}`
    + `<h3>FLOWN UNDER</h3>${rows(limbos, 'nothing to fly under')}`
    + `<h3>OTHER</h3><div class="r">`
      + `<span>LANDMARKS FOUND</span><u>${found.size} / ${LANDMARKS.length}</u>`
      + `<span>BEST DROP</span><u>${chRec.drop ? chRec.drop + ' pts' : '—'}</u>`
      + `<span>TRACK LOGGED</span><u>${((trackXZ.length >> 1) * TRACK_STEP / 1000).toFixed(0)} km</u>`
    + `</div><div class="hint">L to close</div>`;
}

// =================================================================
//  BIRDS
//  Clear the treetops and a wood empties itself in front of you. One instanced flock,
//  recycled: a burst claims however many of the pool are idle, so a second flush while
//  the first is still airborne simply gets a smaller flock rather than allocating.
//
//  The trigger is the forest field, not the trees — the scatter only plants what is
//  inside the cull radius, so asking "are there stems here" would fail at exactly the
//  moment you are moving fastest over the canopy.
// =================================================================
const BIRD_N = 90;
const birds = [];
let birdMesh = null, birdCool = 0;
{
  // a two-triangle V, which at any distance you will ever see one from is a bird
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [0, 0, 0.5, -1.7, 0.42, -0.5, 0, 0, -0.35,
     0, 0, 0.5, 0, 0, -0.35, 1.7, 0.42, -0.5], 3));
  g.computeVertexNormals();
  birdMesh = new THREE.InstancedMesh(g, new THREE.MeshToonMaterial({
    gradientMap: RAMP, color: 0x2b2f38, side: THREE.DoubleSide }), BIRD_N);
  birdMesh.frustumCulled = false; birdMesh.count = 0;
  scene.add(birdMesh);
  for (let i = 0; i < BIRD_N; i++)
    birds.push({ live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ph: 0, t: 0 });
}
function flushBirds(px, py, pz, hx, hz) {
  let n = 0;
  for (const b of birds) {
    if (b.live || n >= 14) continue;
    n++;
    const a = hash2i((px | 0) + n * 37, (pz | 0) + n * 11) * 6.283185;
    const r = 18 + hash2i(n * 13, (pz | 0)) * 55;
    b.x = px + Math.cos(a) * r; b.z = pz + Math.sin(a) * r;
    b.y = terrainH(b.x, b.z) + 10 + hash2i(n, 7) * 8;
    // away from the aeroplane and upward: they are leaving, not milling about
    const away = Math.atan2(b.x - px, b.z - pz) + (hash2i(n, 23) - 0.5) * 1.1;
    const sp = 13 + hash2i(n, 29) * 9;
    b.vx = Math.sin(away) * sp; b.vz = Math.cos(away) * sp;
    b.vy = 5 + hash2i(n, 31) * 5;
    b.ph = hash2i(n, 41) * 6.283185; b.t = 0; b.live = true;
  }
}
function updateBirds(dt, px, py, pz) {
  birdCool -= dt;
  if (mode === 'plane' && birdCool <= 0) {
    const gy = terrainH(px, pz);
    if (py - gy < 55 && forestF(px, pz) > 0.45) {
      flushBirds(px, py, pz);
      birdCool = 3.2;                      // one flock per wood, not one per frame
    }
  }
  let n = 0;
  for (const b of birds) {
    if (!b.live) continue;
    b.t += dt;
    if (b.t > 9) { b.live = false; continue; }
    b.vy -= 2.2 * dt;                      // level off into a glide
    if (b.vy < 1.2) b.vy = 1.2;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    dummy.position.set(b.x, b.y, b.z);
    dummy.rotation.set(0, Math.atan2(b.vx, b.vz), Math.sin(b.ph + b.t * 17) * 0.55);
    const s = 1 - Math.max(0, (b.t - 7) / 2);          // shrink out rather than pop out
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    birdMesh.setMatrixAt(n++, dummy.matrix);
  }
  birdMesh.count = n;
  if (n) birdMesh.instanceMatrix.needsUpdate = true;
}

// =================================================================
//  RUNNING THE CHALLENGES
//  One update per frame drives all three. A race is a state machine over its own gate
//  list; a limbo is a set of windows that only need counting; a drop zone is scored once,
//  when the pilot stops falling.
// =================================================================
const GHOST_HZ = 10;                       // fast enough to look like flying, small enough to keep
let ghostRec = null, ghostPlay = null, ghostT = 0;
const ghostPlane = buildPlane();
ghostPlane.visible = false;
ghostPlane.traverse(o => {                 // translucent, so it reads as a memory not a rival
  if (o.isMesh) {
    o.material = o.material.clone();
    o.material.transparent = true; o.material.opacity = 0.42; o.material.depthWrite = false;
  }
});
const ghostRig = new THREE.Group(); ghostRig.rotation.order = 'YXZ';
ghostRig.add(ghostPlane); scene.add(ghostRig);

const fmtT = t => `${(t / 60) | 0}:${(t % 60).toFixed(2).padStart(5, '0')}`;

function raceReset(R, why) {
  if (R.running && why) toast(`${R.name} — ${why}`);
  R.running = false; R.next = 0; R.t = 0;
  if (ghostRec && ghostRec.race === R) ghostRec = null;
  if (ghostPlay && ghostPlay.race === R) { ghostPlay = null; ghostRig.visible = false; }
}

function updateRaces(dt, px, py, pz) {
  for (const R of RACES) {
    if (R.running) {
      R.t += dt;
      R.since += dt;
      if (R.since > 45) { raceReset(R, 'LAPSED'); continue; }   // wandered off; quietly drop it
      if (ghostRec && ghostRec.race === R) {
        ghostRec.acc += dt;
        while (ghostRec.acc >= 1 / GHOST_HZ) {
          ghostRec.acc -= 1 / GHOST_HZ;
          ghostRec.s.push(Math.round(px), Math.round(py), Math.round(pz),
            Math.round(planeHeading * 100), Math.round(planeRoll * 100));
        }
      }
    }
    // Only the gate you are due next can be crossed, so cutting the course does nothing;
    // but gate 0 is always live, which is what lets you simply fly at it to start again.
    const want = R.running ? R.next : 0;
    if (!gateCrossed(R.gates[want], px, py, pz)) continue;
    if (!R.running) {
      R.running = true; R.t = 0; R.next = 1; R.since = 0;
      ghostRec = { race: R, s: [], acc: 0 };
      const best = chRec.race[R.name];
      if (best && chRec.ghost[R.name]) {
        ghostPlay = { race: R, s: chRec.ghost[R.name], t: 0 };
        ghostRig.visible = true;
      }
      toast(`${R.name} — GO${best ? `  ·  best ${fmtT(best)}` : ''}`);
      bump(0.25, 520, 0.09, 'square');
      continue;
    }
    R.next++; R.since = 0;
    if (R.next < R.gates.length) {
      bump(0.2, 700 + R.next * 30, 0.07, 'square');
      continue;
    }
    // finished
    const t = R.t, best = chRec.race[R.name];
    const isBest = !best || t < best;
    if (isBest) {
      chRec.race[R.name] = t;
      if (ghostRec && ghostRec.race === R) chRec.ghost[R.name] = ghostRec.s;
      store.set(CH_KEY, chRec);
    }
    toast(`${R.name} — ${fmtT(t)}${isBest ? '   NEW BEST' : `   best ${fmtT(best)}`}`);
    bump(0.3, 880, 0.22, 'triangle');
    raceReset(R, null);
  }
  // the ghost of your best run, flying it again beside you
  if (ghostPlay) {
    ghostPlay.t += dt;
    const s = ghostPlay.s, i = Math.floor(ghostPlay.t * GHOST_HZ);
    if ((i + 1) * 5 + 4 >= s.length) { ghostPlay = null; ghostRig.visible = false; }
    else {
      const a = i * 5, b = a + 5, f = ghostPlay.t * GHOST_HZ - i;
      ghostRig.position.set(s[a] + (s[b] - s[a]) * f, s[a + 1] + (s[b + 1] - s[a + 1]) * f,
                            s[a + 2] + (s[b + 2] - s[a + 2]) * f);
      ghostRig.rotation.set(0, s[a + 3] / 100, -s[a + 4] / 100);
    }
  }
}

function updateLimbos(px, py, pz) {
  for (const L of LIMBOS) {
    for (const G of L.bays) {
      if (!gateCrossed(G, px, py, pz)) continue;
      const n = (chRec.limbo[L.name] || 0) + 1;
      chRec.limbo[L.name] = n; store.set(CH_KEY, chRec);
      toast(`UNDER ${L.name}${n > 1 ? `  ·  ${n} times` : '  ·  first time'}`);
      bump(0.28, 300, 0.16, 'sawtooth');
      break;                               // one bay a frame; you cannot use two at once
    }
  }
}

// Scored where the pilot stops, not where the canopy opened. Returns false if you came
// down nowhere near a bullseye, so the ordinary "down safe" message still gets its turn.
function scoreDropIfNear() {
  if (!DROPS.length) return false;
  let bd = Infinity;
  for (const d of DROPS) {
    const s = Math.hypot(d.x - pilot.position.x, d.z - pilot.position.z);
    if (s < bd) bd = s;
  }
  if (bd > 120) return false;              // not aiming at anything, do not pretend
  const pts = bd < 3.4 ? 100 : bd < 9 ? 75 : bd < 17 ? 50 : bd < 26 ? 25 : 10;
  if (pts > (chRec.drop || 0)) { chRec.drop = pts; store.set(CH_KEY, chRec); }
  toast(`BULLSEYE — ${bd.toFixed(1)} m out  ·  ${pts} pts${pts === 100 ? '  DEAD CENTRE' : ''}`);
  bump(0.3, pts === 100 ? 990 : 620, 0.2, 'triangle');
  return true;
}

// =================================================================
//  THE FLOWN TRACK
//  Where you have actually been, drawn on the map. Sampled by distance rather than by
//  time, so an hour spent in the circuit costs four points and a transit costs one every
//  200 m. Quantised to whole metres because a track is a picture, not a survey.
// =================================================================
const TRACK_KEY = 'flightsim.track.v1';
const TRACK_STEP = 200, TRACK_MAX = 6000;
let trackXZ = store.get(TRACK_KEY, []);
if (trackXZ.length > TRACK_MAX * 2) trackXZ = trackXZ.slice(-TRACK_MAX * 2);
let trackDirty = false, trackSaveT = 0, trackLine = null;
const trackGroup = new THREE.Group(); trackGroup.visible = false; scene.add(trackGroup);
const trackPos = new Float32Array(TRACK_MAX * 18);   // six verts a segment, three floats each

function trackPush(x, z) {
  const n = trackXZ.length;
  if (n >= 2 && Math.hypot(x - trackXZ[n - 2], z - trackXZ[n - 1]) < TRACK_STEP) return;
  trackXZ.push(Math.round(x), Math.round(z));
  if (trackXZ.length > TRACK_MAX * 2) trackXZ.splice(0, 2);
  trackDirty = true;
}
// Rebuilt only when the map is opened — nothing looks at it the rest of the time.
//
// A ribbon, not a THREE.Line. WebGL draws a line one device pixel wide whatever you ask
// for, and the map camera sits 32 km up, so a line was rendering correctly and was still
// invisible — which defeats the entire purpose of being able to see where you have never
// been. TRACK_W is in metres and works out around three pixels at full zoom-out.
const TRACK_W = 110;
function buildTrack() {
  const n = Math.min(TRACK_MAX, trackXZ.length >> 1);
  let v = 0;
  for (let i = 0; i < n - 1; i++) {
    const x0 = trackXZ[i * 2], z0 = trackXZ[i * 2 + 1];
    const x1 = trackXZ[i * 2 + 2], z1 = trackXZ[i * 2 + 3];
    let tx = x1 - x0, tz = z1 - z0;
    const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    // a long jump means the log skipped (a reload, or the aeroplane was put somewhere) —
    // joining across it would draw a route that was never flown
    if (L > TRACK_STEP * 6) continue;
    const px = -tz * TRACK_W / 2, pz = tx * TRACK_W / 2;
    const y0 = terrainH(x0, z0) + 30, y1 = terrainH(x1, z1) + 30;
    const q = [x0 + px, y0, z0 + pz, x1 + px, y1, z1 + pz, x1 - px, y1, z1 - pz,
               x0 + px, y0, z0 + pz, x1 - px, y1, z1 - pz, x0 - px, y0, z0 - pz];
    for (let k = 0; k < 18; k++) trackPos[v++] = q[k];
  }
  if (!trackLine) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(trackPos, 3));
    trackLine = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xffd23b, transparent: true, opacity: 0.85, depthWrite: false,
      side: THREE.DoubleSide }));
    trackLine.frustumCulled = false; trackLine.renderOrder = 3;
    // Its own group, deliberately NOT mapMarks: updateMapOverlay rescales every child of
    // that group each frame to hold the pins at a constant size on screen, and this
    // ribbon's vertices are absolute world positions — scaling them by the camera height
    // threw the whole track several hundred kilometres off the map.
    trackGroup.add(trackLine);
  }
  trackLine.geometry.attributes.position.needsUpdate = true;
  trackLine.geometry.setDrawRange(0, v / 3);
  trackLine.visible = n > 1;
}

// =================================================================
//  CAMERA
//  The chase camera from ~/driver, with the town-only parts (room clamping, wall
//  sweeping) removed — out here there is nothing for the view to get stuck behind.
// =================================================================
const desired = new THREE.Vector3(), camTarget = new THREE.Vector3();
const CAM_DISTS = [17, 26, 11];
const CAM_COCKPIT = 3;                 // one past the chase distances
let lookYaw = 0, lookPitch = 0;        // first-person mouse look, relative to the airframe
let camSettled = false;

function updateCamera(dt, now) {
  const inPlane = mode === 'plane';
  const subject = inPlane ? plane.position : pilot.position;

  if (mapView) {
    // Straight down from a long way up. Distance fog would grey the whole world out,
    // and a 0.4 near plane leaves no depth precision at 16 km — the ground detail
    // z-fights into scribbles — so both are retuned for the duration.
    const H = clamp((WORLD * 1.6) / mapZoom, 900, WORLD * 4);
    scene.fog = null;
    camera.near = Math.max(60, H * 0.2);
    camera.far = Math.max(60000, H * 3);
    camera.fov += (58 - camera.fov) * Math.min(1, dt * 5);
    // Orientation is pinned, not derived. lookAt() from almost directly overhead is
    // degenerate: it works out screen-up from the tiny horizontal offset between camera
    // and target, and once panning made that offset swing about, the whole map rolled
    // with it — measured at 112 degrees. Straight down with a fixed up cannot rotate.
    // Position snaps rather than lerps so a drag tracks the pointer exactly.
    const mx = subject.x + mapPanX, mz = subject.z + mapPanZ;
    camera.position.set(mx, H, mz);
    camera.rotation.set(-Math.PI / 2, 0, 0);        // +X is screen-right, +Z screen-down
    camera.updateProjectionMatrix();
    camSettled = true;
    updateMapOverlay();
    return;
  }
  scene.fog = worldFog;
  if (camera.far !== 12000) { camera.far = 12000; camera.updateProjectionMatrix(); }

  // ---- first person, from the pilot's seat ----
  if (inPlane && camIdx === CAM_COCKPIT) {
    plane.updateMatrixWorld();
    camera.near = 0.12;
    // Seat height matters more than it sounds: the fuselage deck is at y=2.0, so an eye
    // at 2.05 sits *on* the cowling and it swallows half the screen. 2.42 is above the
    // canopy line — which is hidden from the inside anyway — and gives a view over the
    // nose with the prop and the wing roots still in frame.
    camera.position.set(0, 2.42, 1.7).applyMatrix4(plane.matrixWorld);
    camera.quaternion.setFromEuler(plane.rotation);
    // A camera looks down its own local -Z, but the aeroplane's nose is +Z. Copying the
    // airframe's rotation straight onto the camera therefore points it at the tail —
    // which is exactly what it did. Spin it half a turn to face the way we are going.
    camera.rotateY(Math.PI);
    // mouse look, added on top of wherever the aeroplane is pointing, easing back to
    // straight ahead when you let go — otherwise you land looking at your own wingtip
    if (now - lastMouse > 1400) {
      lookYaw += (0 - lookYaw) * Math.min(1, dt * 3);
      lookPitch += (0 - lookPitch) * Math.min(1, dt * 3);
    }
    camera.rotateY(lookYaw); camera.rotateX(lookPitch);
    camera.fov += (68 + planeSpeed / PLANE_MAX * 8 - camera.fov) * Math.min(1, dt * 4);
    camera.updateProjectionMatrix();
    camSettled = false;          // so the chase cam snaps in cleanly when you switch back
    return;
  }
  // High up, looking at ground hundreds of metres off, a 0.4 near plane leaves no
  // depth precision — and the ink pass is a depth-edge filter, so that shows up as
  // the outlines dissolving. Pull the near plane out with altitude; the chase cam
  // sits 17 m back so there is no risk of clipping the aircraft.
  // Height above GROUND, not above sea level. In the town this came from the ground
  // was y=0 everywhere, so absolute y was altitude and the distinction never came up.
  // Here the land reaches ~1000 m: flying low over a plateau would otherwise pin the
  // near plane at its 12 m cap and clip the nose off the aircraft 17 m ahead of it.
  const agl = inPlane ? plane.position.y - terrainH(plane.position.x, plane.position.z) : 0;
  const wantNear = inPlane ? clamp(agl * 0.06, 0.4, 12) : 0.4;
  if (camera.near !== wantNear) { camera.near = wantNear; camera.updateProjectionMatrix(); }

  const eye = inPlane ? 3.0 : 1.7;
  let dist = inPlane ? CAM_DISTS[camIdx] : 9;
  dist += inPlane ? planeSpeed / PLANE_MAX * 4 : 0;
  // swing back behind the aircraft when you stop steering the camera
  if (inPlane && now - lastMouse > 900) {
    let d = planeHeading - camYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    camYaw += d * (1 - Math.exp(-dt * 2.0));
  }
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  const dx = Math.sin(camYaw) * cp, dy = sp, dz = Math.cos(camYaw) * cp;
  desired.set(subject.x - dx * dist, subject.y + eye - dy * dist, subject.z - dz * dist);
  // never let the eye go under the ground, or the whole screen fills with dirt
  const camGround = terrainH(desired.x, desired.z) + 2.2;
  if (desired.y < camGround) desired.y = camGround;
  camera.position.lerp(desired, camSettled ? Math.min(1, dt * 9) : 1);
  camSettled = true;
  if (shake > 0) {
    shake = Math.max(0, shake - dt * 2.6);
    const s = shake * 0.55;
    camera.position.x += rnd(-s, s); camera.position.y += rnd(-s, s); camera.position.z += rnd(-s, s);
  }
  camTarget.set(subject.x + dx * 2, subject.y + eye + dy * 2, subject.z + dz * 2);
  camera.lookAt(camTarget);
  const targetFov = 60 + (inPlane ? planeSpeed / PLANE_MAX * 13 : 0);
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 4);
  camera.updateProjectionMatrix();
}

// =================================================================
//  INSTRUMENTS
// =================================================================
const R2D = 180 / Math.PI;
let thrShown = 0;
function updateHUD(dt) {
  const inPlane = mode === 'plane';
  elIAS.textContent = Math.round(planeSpeed * 1.94384);          // m/s -> knots
  const alt = (inPlane ? plane.position.y : pilot.position.y) - SEA_Y;
  elALT.textContent = Math.round(alt * 3.28084);                 // metres -> feet

  // The model has no throttle *state* — speed is the state — so the bar shows the
  // power the pilot is asking for, which is what the label means. Smoothed, or it
  // snaps between three values and looks broken.
  const want = !inPlane || paused ? 0 : (autoFly || keys['KeyW']) ? 1 : keys['KeyS'] ? 0 : 0.35;
  thrShown += (want - thrShown) * Math.min(1, dt * 7);
  elTHR.style.width = (thrShown * 100).toFixed(0) + '%';

  // +Z is north. Facing north the pilot's left hand points to +X, so +X is west and a
  // left turn (which increases planeHeading) has to walk the compass down.
  let brg = (-planeHeading * R2D) % 360; if (brg < 0) brg += 360;
  elHDG.textContent = 'HDG ' + String(Math.round(brg) % 360).padStart(3, '0');

  // The horizon moves opposite the aircraft: bank left and it rolls clockwise, pull
  // the nose up and it drops out of the porthole.
  elADI.style.transform = `rotate(${(planeRoll * R2D).toFixed(1)}deg) translateY(${(planePitch * R2D * 1.7).toFixed(1)}px)`;

  updateNav();
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) elToast.classList.remove('show'); }
  if (scoreT > 0) { scoreT -= dt; if (scoreT <= 0) elScore.classList.remove('show'); }
}

// Everywhere worth aiming at. The city counts: it is the one place in the world you
// can see from further away than you can see the field you took off from.
const PLACES = STRIPS.map(s => ({ name: s.name, x: s.x, z: s.z, kind: 'strip' }));
for (const t of TOWNS) PLACES.push({ name: t.name, x: t.x, z: t.z, kind: 'town' });
for (const l of LANDMARKS) PLACES.push({ name: l.name, x: l.x, z: l.z, kind: 'mark' });
// The start gate of each course, so a race is something you can find on the map and steer
// at with the NEAREST readout rather than something you have to already know about.
for (const R of RACES)
  PLACES.push({ name: R.name, x: R.gates[0].x, z: R.gates[0].z, kind: 'race' });

// =================================================================
//  THE DISCOVERY LOG
//  Forty-nine landmarks were already out there, already named and already on the map —
//  and nothing ever noticed you had been to one. Fly within range and it is logged,
//  counted and kept between sessions. The unfound ones are absent from the map rather
//  than greyed out, because a blank corner is the only thing that makes you go and look
//  at a blank corner.
// =================================================================
const DISCOVER_R = 420;                    // close enough that you have really seen it
const FOUND_KEY = 'flightsim.found.v1';
const found = new Set();
try { (JSON.parse(localStorage.getItem(FOUND_KEY)) || []).forEach(n => found.add(n)); }
catch (e) { /* corrupt or blocked storage just means starting fresh */ }
const elDiscN = document.getElementById('discN');
const elDiscT = document.getElementById('discT');
const elDiscBar = document.getElementById('discBar');
function paintDiscovery() {
  elDiscN.textContent = found.size;
  elDiscT.textContent = LANDMARKS.length;
  elDiscBar.style.width = (LANDMARKS.length ? found.size / LANDMARKS.length * 100 : 0) + '%';
}
paintDiscovery();

function checkDiscovery(px, pz) {
  const R2 = DISCOVER_R * DISCOVER_R;
  for (const l of LANDMARKS) {
    if (found.has(l.name)) continue;
    if ((l.x - px) ** 2 + (l.z - pz) ** 2 > R2) continue;
    found.add(l.name);
    try { localStorage.setItem(FOUND_KEY, JSON.stringify([...found])); } catch (e) {}
    paintDiscovery();
    const done = found.size === LANDMARKS.length;
    toast(done ? `ALL ${LANDMARKS.length} LANDMARKS FOUND — ${l.name}`
               : `FOUND — ${l.name}   ${found.size}/${LANDMARKS.length}`);
    // two rising notes, so a discovery is audible when you are looking somewhere else
    bump(0.22, 660, 0.10, 'triangle');
    setTimeout(() => bump(0.22, 990, 0.16, 'triangle'), 90);
    return;                                // one a frame is plenty; they are 900 m apart
  }
}

function updateNav() {
  const px = mode === 'plane' ? plane.position.x : pilot.position.x;
  const pz = mode === 'plane' ? plane.position.z : pilot.position.z;
  if (started && !paused) checkDiscovery(px, pz);
  let best = null, bestD = Infinity;
  for (const p of PLACES) {
    const d = (p.x - px) ** 2 + (p.z - pz) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  if (!best) return;
  const dx = best.x - px, dz = best.z - pz;
  const dist = Math.sqrt(bestD);
  // same convention as the compass: +Z is north, +X is west, so a world direction
  // becomes a bearing through -atan2(dx, dz)
  let brg = (-Math.atan2(dx, dz) * R2D) % 360; if (brg < 0) brg += 360;
  elNavName.textContent = best.name;
  elNavSub.textContent = (dist < 950 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(1)} km`)
    + ' · ' + String(Math.round(brg) % 360).padStart(3, '0') + '°';
}

// =================================================================
//  INK POST-PROCESS
//  The look of the thing. A screen-space depth-edge filter: it draws interior lines as
//  well as silhouettes, at a constant screen-space weight, for one full-screen quad —
//  instead of a back-face shell doubling the vertex work on every mesh in the world.
//  Lines fade out with distance, because a one-pixel line on a far ridge is a crawling
//  speck and the fog has taken it anyway.
// =================================================================

// The composer's two ping-pong buffers need depth *textures*, not just depth buffers,
// or there is nothing to sample. Both get one, because which of the two holds the
// scene render when this pass runs depends on how many passes have swapped ahead of it.
const composer = new EffectComposer(renderer);
for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
  rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height, THREE.UnsignedIntType);
  rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
}

// `thickness` is in CSS pixels; the shader works in drawing-buffer pixels, so it is
// scaled by the device ratio at setSize time. Otherwise a line is half as heavy on a
// retina display as on a plain one — the one thing a screen-space outline must not do.
const inkParams = { on: true, thickness: 1.0, depthSense: 0.9, fadeNear: 1300, fadeFar: 3800, strength: 1.0 };

const InkShader = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 0.4 }, cameraFar: { value: 12000 },
    thickness: { value: inkParams.thickness },
    depthSense: { value: inkParams.depthSense },
    fadeNear: { value: inkParams.fadeNear }, fadeFar: { value: inkParams.fadeFar },
    strength: { value: inkParams.strength },
    debugMode: { value: 0 },
    inkColor: { value: new THREE.Color(INK_COLOR) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2  resolution;
    uniform float cameraNear, cameraFar, thickness, depthSense;
    uniform float fadeNear, fadeFar, strength;
    uniform int   debugMode;
    uniform vec3  inkColor;
    varying vec2 vUv;

    float dist(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      return -perspectiveDepthToViewZ(d, cameraNear, cameraFar);   // metres, positive
    }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 t = thickness / resolution;
      vec2 dx = vec2(t.x, 0.0), dy = vec2(0.0, t.y);

      float d0 = dist(vUv);
      float dl = dist(vUv - dx), dr = dist(vUv + dx);
      float du = dist(vUv - dy), dd = dist(vUv + dy);

      float curve = abs(dl + dr - 2.0*d0) + abs(du + dd - 2.0*d0);
      // a plane's *projected* curvature still grows with distance, so the tolerance
      // has to grow with it or the far ground fills up with lines
      float tol = depthSense * (0.05 + d0*0.004 + d0*d0*0.0009);
      float edge = smoothstep(0.9, 1.8, curve / tol);

      float fade = 1.0 - smoothstep(fadeNear, fadeFar, d0);
      float e = clamp(edge * fade * strength, 0.0, 1.0);
      // 1 = banded view-space depth, 2 = the raw edge mask. Kept from the original:
      // when the lines go missing these two answer "is there depth?" and "is there an
      // edge?" separately, which is the whole diagnosis in two screenshots.
      if (debugMode == 1) { gl_FragColor = vec4(vec3(fract(d0*0.1)), 1.0); return; }
      if (debugMode == 2) { gl_FragColor = vec4(vec3(e), 1.0); return; }
      gl_FragColor = vec4(mix(base.rgb, inkColor, e), base.a);
    }
  `,
};

class InkPass extends Pass {
  constructor() {
    super();
    this.material = new THREE.ShaderMaterial(InkShader);
    this.fsq = new FullScreenQuad(this.material);
    this.needsSwap = true;
  }
  setSize(w, h) {                       // w/h are drawing-buffer pixels
    this.material.uniforms.resolution.value.set(w, h);
    this.material.uniforms.thickness.value = inkParams.thickness * renderer.getPixelRatio();
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.cameraNear.value = camera.near; u.cameraFar.value = camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsq.render(renderer);
  }
}

composer.addPass(new RenderPass(scene, camera));
const inkPass = new InkPass();
composer.addPass(inkPass);            // before bloom: ink lines are not a light source
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.16, 0.7, 0.85));
composer.addPass(new OutputPass());
// composer.setSize takes CSS pixels and applies the pixel ratio itself — a pass's own
// setSize then receives drawing-buffer pixels, which is what the ink offsets want.
// (Multiplying by the ratio here instead makes every offset sub-texel and the lines
// simply never appear.)
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
});

// =================================================================
//  LOOP
// =================================================================
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  // Clamped: an alt-tab or a stalled tab otherwise comes back with a multi-second dt
  // and integrates the aircraft straight through the ground.
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now; frameNo++;

  if (!paused && started && !menuOpen) {
    if (mode === 'plane') updatePlane(dt);
    else updatePilot(dt);
    updateParticles(dt);
    waterMat.uniforms.uTime.value += dt;
  }
  updateCamera(dt, now);
  updateHUD(dt);
  updateAudio(dt);
  const rig = plane.children[0];
  if (rig && rig.userData.glass) rig.userData.glass.visible = !(camIdx === CAM_COCKPIT && mode === 'plane' && !mapView);

  const sx = mode === 'plane' ? plane.position.x : pilot.position.x;
  const sz = mode === 'plane' ? plane.position.z : pilot.position.z;
  planChunks(sx, sz);
  pumpChunks(5);
  refreshScenery(sx, sz, 4);
  refreshClouds(sx, sz);
  // With the map up the world is hidden and there is frame time going spare, so spend it
  // finishing the map you are looking at rather than trickling in the background.
  pumpMapBuild(mapView ? 10 : 3);
  if (!paused && started && !menuOpen) {
    if (mode === 'plane' && !mapView) {
      updateRaces(dt, plane.position.x, plane.position.y, plane.position.z);
      updateLimbos(plane.position.x, plane.position.y, plane.position.z);
    }
    updateBirds(dt, sx, mode === 'plane' ? plane.position.y : pilot.position.y, sz);
    trackPush(sx, sz);
    if (trackDirty) { trackSaveT += dt; if (trackSaveT > 12) { trackSaveT = 0; trackDirty = false; store.set(TRACK_KEY, trackXZ); } }
    updateTraffic(dt, sx, sz);
    updateAirspace(dt);
    for (const sp of spinners) sp.o.rotation.z += sp.spd * dt;
  }
  // the sun rides with the aircraft: a directional light does not care where it is,
  // but keeping it near keeps its target sane if shadows are ever switched back on
  sun.position.set(sx + sunDir.x * 500, sunDir.y * 500, sz + sunDir.z * 500);
  sun.target.position.set(sx, 0, sz); sun.target.updateMatrixWorld();

  // The sky travels with the eye. A dome parked at the world origin is fine in a
  // 1 km town and wrong in a 40 km one: fly far enough and you are off-centre inside
  // it — or outside it altogether — and its banding swings across the sky as an arch
  // that moves with you.
  if (skyDome) skyDome.position.copy(camera.position);
  composer.render();
}

// Build the whole first plan before showing anything: "RAISING THE LAND" is honest,
// and dropping into a world that is still popping in around you is worse than waiting.
planChunks(plane.position.x, plane.position.z);
pumpChunks(1e9);
refreshScenery(plane.position.x, plane.position.z);
refreshClouds(plane.position.x, plane.position.z);
startMapBuild();
composer.setSize(innerWidth, innerHeight);
requestAnimationFrame(frame);
{
  const elMenu = document.getElementById('menu');
  const elStart = document.getElementById('start');
  // The menu used to remove itself from the document half a second after the first click,
  // which made going back to it impossible by construction. It is only ever hidden now,
  // so Esc can bring it back and you can move to another field mid-session.
  const begin = () => {
    const first = !started;
    started = true; menuOpen = false;
    initAudio();                     // a real click is the only reliable audio unlock
    elMenu.classList.add('gone');
    elStart.textContent = 'BACK TO FLYING';
    if (first) toast(`W to roll · Space to rotate at ${Math.round(PLANE_TAKEOFF * 1.94384)} kts`);
  };
  // Opening the menu holds the world where it is. Without this you would come back from
  // choosing a field to find the aeroplane had flown on for as long as you took deciding.
  openMenu = () => {
    if (menuOpen) return;
    menuOpen = true;
    elMenu.classList.remove('gone');
    if (mapView) toggleMap();
    if (bookOpen) toggleBook();
    btns.forEach((o, j) => o.classList.toggle('on', j === startField));
  };
  elStart.addEventListener('click', begin);
  addEventListener('keydown', e => {
    if (e.code === 'Escape') { menuOpen ? begin() : openMenu(); return; }
    if (menuOpen && (e.code === 'Enter' || e.code === 'Space')) begin();
  });

  // One button per sited field. Picking one parks the aeroplane there straight away, so
  // the menu backdrop becomes the field you chose rather than a promise about it.
  const pick = document.getElementById('fieldPick');
  const lbl = document.createElement('div');
  lbl.className = 'lbl'; lbl.textContent = 'START FROM';
  pick.appendChild(lbl);
  const btns = STRIPS.map((S, i) => {
    const b = document.createElement('button');
    b.className = 'fld' + (i === startField ? ' on' : '');
    b.textContent = S.name;
    b.title = `${S.halfLen * 2 | 0} m · heading ${((S.hdg * 180 / Math.PI % 360) + 360) % 360 | 0}°`;
    b.addEventListener('click', () => {
      if (!menuOpen) return;
      setStartField(i);
      planeHome(); camYaw = planeHeading; camSettled = false;
      btns.forEach((o, j) => o.classList.toggle('on', j === startField));
    });
    pick.appendChild(b);
    return b;
  });
}
requestAnimationFrame(() => {
  elLoader.style.opacity = '0';
  setTimeout(() => elLoader.remove(), 650);
  // PLANE_TAKEOFF is 24 m/s and the HUD reads knots — telling the pilot to rotate
  // at "24" had them staring at an airspeed indicator that was already past it.
  toast(`W to roll · Space to rotate at ${Math.round(PLANE_TAKEOFF * 1.94384)} kts`);
});
console.log(`terrain: ${chunks.size} chunks, `
  + `${[...chunks.values()].reduce((a, c) => a + c.mesh.geometry.index.count / 3, 0) | 0} triangles`);
