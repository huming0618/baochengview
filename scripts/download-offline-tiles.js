#!/usr/bin/env node
/**
 * Pre-seed dark basemap tiles for Baocheng Railway corridor (Chengdu–Baoji).
 * Prefer Carto dark_all, then OSM mirrors (osm.fr / osm.de). Esri removed —
 * public Canvas often returns "API key required" watermarks.
 * Reject known bad hashes and post-pass identical tiny/blocked tiles.
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

const CARTO = (s, z, x, y) => `https://${s}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`;
const OSM_FR = (s, z, x, y) => `https://${s}.tile.openstreetmap.fr/osmfr/${z}/${x}/${y}.png`;
const OSM_DE = (z, x, y) => `https://tile.openstreetmap.de/${z}/${x}/${y}.png`;
const OSM_ORG = (s, z, x, y) => `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
const SUBS = ['a', 'b', 'c'];

const KNOWN_BAD_HASHES = new Set([
  '53041128e533b76ce8da6b7f1803e17731806ed3', // Carto dark watermark
  '5e572ff20f984b9437bf38d4364d32979a5e1570', // Carto light watermark
  '0cfb5f443183efc5921f61005aaa7f341fcfd143', // OSM.org blocked placeholder
  '8e2044cbe09d0889949893981eb09f9f0007dc44', // Esri "API key required" JPEG
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
  // Prefer Carto dark_all; fall back to OSM mirrors that work from CN/restricted nets.
  const urls = [
    { url: CARTO(s, z, x, y), provider: 'carto' },
    { url: OSM_FR(s, z, x, y), provider: 'osmfr' },
    { url: OSM_DE(z, x, y), provider: 'osmde' },
    { url: OSM_ORG(s, z, x, y), provider: 'osm' },
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
      // Esri-style API-key watermarks are often small JPEGs; we no longer fetch Esri,
      // but still reject tiny JPEGs that look like error tiles.
      if (isJpeg && buf.length < 4000) {
        lastErr = new Error(`${provider} suspicious-jpeg`);
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
  const force = process.argv.includes('--force');
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
  console.log(`Unique tiles: ${jobs.length} force=${force}`);
  fs.mkdirSync(OUT, { recursive: true });

  if (force) {
    // Wipe prior seeds (often Esri JPEG/PNG) so we do not skip bad packs.
    for (const ent of fs.readdirSync(OUT, { withFileTypes: true })) {
      const p = path.join(OUT, ent.name);
      if (ent.name === 'manifest.json') continue;
      fs.rmSync(p, { recursive: true, force: true });
    }
    console.log('Cleared existing offline-tiles (kept manifest until rewrite)');
  }

  let ok = 0;
  let fail = 0;
  let skipped = 0;
  const providersUsed = { carto: 0, osmfr: 0, osmde: 0, osm: 0 };
  let next = 0;
  const t0 = Date.now();

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      const { z, x, y } = jobs[i];
      const destDir = path.join(OUT, String(z), String(x));
      const dest = path.join(destDir, `${y}.png`);
      if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 100) {
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
  const hashToPaths = new Map();
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
        if (!hashToPaths.has(h)) hashToPaths.set(h, []);
        hashToPaths.get(h).push(p);
      }
    }
  }
  walk(OUT);

  // Reject mass-identical tiny tiles (blocked placeholders that slipped past known hashes).
  // Real basemap tiles rarely share one hash across >15% of the pack unless ocean/empty.
  // Only purge if the dominant hash is small (<4KB) AND covers >25% of files.
  const topDup = [...onDiskHashes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topDup && topDup[1] > Math.max(20, fileCount * 0.25)) {
    const samplePath = hashToPaths.get(topDup[0])?.[0];
    const sampleSize = samplePath ? fs.statSync(samplePath).size : 0;
    if (sampleSize > 0 && sampleSize < 4000) {
      console.warn(
        `Purging dominant tiny identical hash ${topDup[0].slice(0, 12)} count=${topDup[1]} size=${sampleSize}`,
      );
      for (const p of hashToPaths.get(topDup[0]) || []) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
      // re-walk
      fileCount = 0;
      bytes = 0;
      onDiskHashes.clear();
      walk(OUT);
    }
  }

  const topDup2 = [...onDiskHashes.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(
    'Top hash dup:',
    topDup2 ? { hash: topDup2[0].slice(0, 12), count: topDup2[1] } : null,
    'uniqueHashes=',
    onDiskHashes.size,
  );

  const primary =
    Object.entries(providersUsed).sort((a, b) => b[1] - a[1])[0]?.[0] || 'carto';

  const manifest = {
    generatedAt: new Date().toISOString(),
    zoom: { min: Z_MIN, max: Z_MAX },
    seedBbox: SEED_BBOX,
    note: 'Baocheng Railway corridor Chengdu–Baoji (z7–z11). Seeded from Carto dark_all with OSM mirrors fallback. Esri removed (API-key watermarks). Runtime: Carto → OSM.',
    perZoom,
    uniqueRequested: jobs.length,
    downloadedOk: ok,
    failed: fail,
    skippedExisting: skipped,
    providersUsed,
    primaryProvider: primary,
    uniqueHashesOnDisk: onDiskHashes.size,
    attribution:
      'Basemap tiles © OpenStreetMap contributors / CARTO. Bundled for offline Baocheng View demo only.',
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
