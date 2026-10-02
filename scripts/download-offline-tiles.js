#!/usr/bin/env node
/**
 * Pre-seed dark basemap tiles for Baocheng Railway corridor (Chengdu–Baoji).
 * Prefer Esri World Dark Gray (Carto often watermark-blocked). Reject known bad hashes.
 * Zoom z7–z11 along corridor bbox — keeps APK modest (~under 40MB).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'offline-tiles');

/** [south, west, north, east] — padded Baocheng corridor (宝鸡↔成都) */
const SEED_BBOX = [30.55, 103.86, 34.53, 107.38];
const Z_MIN = 7;
const Z_MAX = 11;
const WORKERS = 4;
const DELAY_MS = 140;
const UA =
  'BaochengViewOfflineSeeder/1.0 (https://github.com/huming0618/baochengview; educational offline pack; contact via GitHub issues)';

const ESRI_DARK = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
const OSM_FR = (s, z, x, y) => `https://${s}.tile.openstreetmap.fr/osmfr/${z}/${x}/${y}.png`;
const OSM_DE = (z, x, y) => `https://tile.openstreetmap.de/${z}/${x}/${y}.png`;
const CARTO = (s, z, x, y) => `https://${s}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`;
const SUBS = ['a', 'b', 'c'];

const KNOWN_BAD_HASHES = new Set([
  '53041128e533b76ce8da6b7f1803e17731806ed3', // Carto dark watermark
  '5e572ff20f984b9437bf38d4364d32979a5e1570', // Carto light watermark
  '0cfb5f443183efc5921f61005aaa7f341fcfd143', // OSM.org blocked placeholder
]);

function lon2tile(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function lat2tile(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z),
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

const hashCounts = new Map();

async function fetchTile(z, x, y) {
  const s = SUBS[(x + y) % SUBS.length];
  const urls = [
    { url: ESRI_DARK(z, x, y), provider: 'esri' },
    { url: CARTO(s, z, x, y), provider: 'carto' },
    { url: OSM_FR(s, z, x, y), provider: 'osmfr' },
    { url: OSM_DE(z, x, y), provider: 'osmde' },
  ];
  let lastErr;
  for (const { url, provider } of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'image/png,image/*;q=0.8,*/*;q=0.5',
          Referer: 'https://github.com/huming0618/baochengview',
        },
      });
      if (!res.ok) {
        lastErr = new Error(`${provider} HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) {
        lastErr = new Error(`${provider} tiny`);
        continue;
      }
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      if (!isPng && !isJpeg) {
        lastErr = new Error(`${provider} not-image`);
        continue;
      }
      const h = sha1(buf);
      if (KNOWN_BAD_HASHES.has(h)) {
        lastErr = new Error(`${provider} known-bad-hash`);
        continue;
      }
      hashCounts.set(h, (hashCounts.get(h) || 0) + 1);
      return { buf, provider, hash: h };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('fail');
}

async function main() {
  const [south, west, north, east] = SEED_BBOX;
  const tileSet = new Map();
  const perZoom = {};

  for (let z = Z_MIN; z <= Z_MAX; z++) {
    const x0 = lon2tile(west, z);
    const x1 = lon2tile(east, z);
    const y0 = lat2tile(north, z);
    const y1 = lat2tile(south, z);
    let count = 0;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        tileSet.set(`${z}/${x}/${y}`, { z, x, y });
        count++;
      }
    }
    perZoom[z] = { x0, x1, y0, y1, count };
    console.log(`z${z}: x=${x0}-${x1} y=${y0}-${y1} -> ${count}`);
  }

  const jobs = [...tileSet.values()];
  console.log(`Unique tiles: ${jobs.length}`);
  fs.mkdirSync(OUT, { recursive: true });

  let ok = 0;
  let fail = 0;
  let skipped = 0;
  const providersUsed = { esri: 0, osmfr: 0, osmde: 0, carto: 0 };
  let next = 0;
  const t0 = Date.now();

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      const { z, x, y } = jobs[i];
      const destDir = path.join(OUT, String(z), String(x));
      const dest = path.join(destDir, `${y}.png`);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 100) {
        const existing = fs.readFileSync(dest);
        const h = sha1(existing);
        if (KNOWN_BAD_HASHES.has(h)) {
          fs.unlinkSync(dest);
        } else {
          hashCounts.set(h, (hashCounts.get(h) || 0) + 1);
          skipped++;
          ok++;
          if ((ok + fail) % 50 === 0 || i === jobs.length - 1) {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
            console.log(
              `[${ok + fail}/${jobs.length}] ok=${ok} fail=${fail} skip=${skipped} ${JSON.stringify(providersUsed)} ${elapsed}s`,
            );
          }
          continue;
        }
      }
      fs.mkdirSync(destDir, { recursive: true });
      try {
        const { buf, provider } = await fetchTile(z, x, y);
        fs.writeFileSync(dest, buf);
        ok++;
        providersUsed[provider] = (providersUsed[provider] || 0) + 1;
      } catch (e) {
        fail++;
        console.warn(`FAIL ${z}/${x}/${y}: ${e.message}`);
      }
      await sleep(DELAY_MS);
      if ((ok + fail) % 50 === 0 || i === jobs.length - 1) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(
          `[${ok + fail}/${jobs.length}] ok=${ok} fail=${fail} skip=${skipped} ${JSON.stringify(providersUsed)} ${elapsed}s`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, () => worker()));

  let fileCount = 0;
  let bytes = 0;
  const onDiskHashes = new Map();
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.png')) {
        const buf = fs.readFileSync(p);
        const h = sha1(buf);
        if (KNOWN_BAD_HASHES.has(h)) {
          fs.unlinkSync(p);
          continue;
        }
        fileCount++;
        bytes += buf.length;
        onDiskHashes.set(h, (onDiskHashes.get(h) || 0) + 1);
      }
    }
  }
  walk(OUT);

  const topDup = [...onDiskHashes.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(
    'Top hash dup:',
    topDup ? { hash: topDup[0].slice(0, 12), count: topDup[1] } : null,
    'uniqueHashes=',
    onDiskHashes.size,
  );

  const primary =
    Object.entries(providersUsed).sort((a, b) => b[1] - a[1])[0]?.[0] || 'esri';

  const manifest = {
    generatedAt: new Date().toISOString(),
    zoom: { min: Z_MIN, max: Z_MAX },
    seedBbox: SEED_BBOX,
    note: 'Baocheng Railway corridor Chengdu–Baoji (z7–z11). Seeded primarily from Esri World Dark Gray Base. Runtime tries Carto dark_all → Esri → OSM online.',
    perZoom,
    uniqueRequested: jobs.length,
    downloadedOk: ok,
    failed: fail,
    skippedExisting: skipped,
    providersUsed,
    primaryProvider: primary,
    uniqueHashesOnDisk: onDiskHashes.size,
    attribution:
      'Basemap tiles © Esri (World Dark Gray) and/or © OpenStreetMap contributors / CARTO. Bundled for offline Baocheng View demo only.',
    pathTemplate: 'offline-tiles/{z}/{x}/{y}.png',
    onDiskPngCount: fileCount,
    onDiskBytes: bytes,
    onDiskMB: Math.round((bytes / (1024 * 1024)) * 100) / 100,
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('DONE', manifest.onDiskMB, 'MB', fileCount, 'pngs fail=', fail, 'uniqueHashes=', onDiskHashes.size);
  if (fail > jobs.length * 0.08 || fileCount < jobs.length * 0.85) process.exit(2);
  if (onDiskHashes.size < Math.min(50, jobs.length * 0.05)) {
    console.error('Too few unique tile hashes — likely still blocked');
    process.exit(3);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
