// @ts-nocheck
/**
 * Tile load order:
 *  1) Bundled offline-tiles/{z}/{x}/{y}.png (absolute URL from WebView origin)
 *  2) Cache API (runtime prefetch)
 *  3) Network Carto dark_all, then OSM (if online; Esri removed)
 *
 * Offline: map maxZoom capped to SEEDED_MAX_ZOOM so only seeded zooms are requested.
 */

const CACHE_NAME = 'baochengview-carto-tiles-v2';
const OSM_TEMPLATE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const CARTO_TEMPLATE = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';
const OSM_SUBDOMAINS = ['a', 'b', 'c'];
const CARTO_SUBDOMAINS = ['a', 'b', 'c', 'd'];

/** Known blocked/watermark tiles (Carto, OSM.org, Esri API-key JPEG). */
const BAD_TILE_SHA1 = new Set([
  '53041128e533b76ce8da6b7f1803e17731806ed3', // Carto dark watermark
  '5e572ff20f984b9437bf38d4364d32979a5e1570', // Carto light watermark
  '0cfb5f443183efc5921f61005aaa7f341fcfd143', // OSM.org blocked placeholder
  '8e2044cbe09d0889949893981eb09f9f0007dc44', // Esri "API key required" JPEG
]);

/** Bundled offline tiles cover this zoom range (see public/offline-tiles/manifest.json). */
export const SEEDED_MIN_ZOOM = 7;
export const SEEDED_MAX_ZOOM = 11;

/** Light gray 1×1 PNG — visible “missing” tile vs broken/transparent. */
const PLACEHOLDER_TILE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN48eIFAAV0ArnZwsdlAAAAAElFTkSuQmCC';

function appBase() {
  try {
    const b = import.meta.env.BASE_URL || './';
    return b.endsWith('/') ? b : `${b}/`;
  } catch {
    return './';
  }
}

/**
 * Resolve a packaged asset to an absolute URL.
 * Relative `./offline-tiles/...` breaks under some Capacitor WebView URLs
 * (https://localhost/ vs capacitor:// / path depth). Always anchor to origin + BASE_URL.
 */
export function resolveAssetUrl(relPath) {
  const cleaned = String(relPath || '').replace(/^\.\//, '').replace(/^\//, '');
  const base = appBase();
  if (typeof window === 'undefined' || !window.location) {
    return `${base}${cleaned}`;
  }
  try {
    // new URL with relative base resolves against location.href
    if (base.startsWith('http://') || base.startsWith('https://')) {
      return new URL(cleaned, base.endsWith('/') ? base : `${base}/`).href;
    }
    if (base.startsWith('/')) {
      return new URL(`${base}${cleaned}`, window.location.origin).href;
    }
    // './' or '' — resolve against current document URL
    return new URL(`${base}${cleaned}`, window.location.href).href;
  } catch {
    const origin = window.location.origin || '';
    const prefix = base.startsWith('/') ? base : '/';
    return `${origin}${prefix}${cleaned}`;
  }
}

/** Bundled asset URL for a z/x/y tile. */
export function bundledTileUrl(z, x, y) {
  return resolveAssetUrl(`offline-tiles/${z}/${x}/${y}.png`);
}

export function tileUrl(z, x, y, template = OSM_TEMPLATE, subdomains = OSM_SUBDOMAINS) {
  const s = subdomains[(x + y) % subdomains.length];
  return template.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

export function networkTileUrls(z, x, y) {
  // Prefer Carto dark_all, then OSM. Esri removed (public Canvas often returns API-key watermarks).
  return [
    tileUrl(z, x, y, CARTO_TEMPLATE, CARTO_SUBDOMAINS),
    tileUrl(z, x, y, OSM_TEMPLATE, OSM_SUBDOMAINS),
  ];
}

async function sha1Hex(blob) {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reject tiny, known-watermark, or empty tiles before caching. */
async function isUsableTileBlob(blob) {
  if (!blob || blob.size < 100) return false;
  try {
    const h = await sha1Hex(blob);
    if (BAD_TILE_SHA1.has(h)) return false;
  } catch {
    /* subtle unavailable — size check only */
  }
  return true;
}

export function isOnline() {
  return typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
}

async function openCache() {
  if (!('caches' in globalThis)) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

function objectUrlFromBlob(blob) {
  return URL.createObjectURL(blob);
}

/** Try loading a bundled tile; returns { blob, bundledUrl } or null. Retries once on transient fail. */
async function tryBundled(z, x, y, { retries = 1 } = {}) {
  const url = bundledTileUrl(z, x, y);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) {
        // Retry with default cache mode (some WebViews dislike force-cache on first hit)
        if (attempt < retries) {
          const res2 = await fetch(url, { cache: 'default' });
          if (!res2.ok) continue;
          const blob2 = await res2.blob();
          if (blob2 && blob2.size >= 50) return { blob: blob2, bundledUrl: url };
          continue;
        }
        return null;
      }
      const blob = await res.blob();
      if (!blob || blob.size < 50) return null;
      return { blob, bundledUrl: url };
    } catch {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function matchCacheAnyKey(cache, urls) {
  for (const url of urls) {
    const hit = await cache.match(url);
    if (hit) return hit;
    // Also try OSM subdomain variants
    for (const s of OSM_SUBDOMAINS) {
      const alt = url.replace(/\/\/[a-d]\./, `//${s}.`);
      if (alt === url) continue;
      const h = await cache.match(alt);
      if (h) return h;
    }
  }
  return null;
}

async function putCache(cache, url, blob) {
  if (!cache) return;
  try {
    await cache.put(
      url,
      new Response(blob.slice(), {
        headers: { 'Content-Type': blob.type || 'image/png' },
      }),
    );
  } catch {
    /* quota */
  }
}

/**
 * Apply offline/online maxZoom on map + tile layer.
 * Offline: cap at SEEDED_MAX_ZOOM so Leaflet does not request blank z16–z19.
 */
export function syncOfflineZoomLimits(map, tileLayer) {
  if (!map) return;
  const online = isOnline();
  const maxZ = online ? 19 : SEEDED_MAX_ZOOM;
  map.setMaxZoom(maxZ);
  if (tileLayer) {
    tileLayer.options.maxZoom = maxZ;
    tileLayer.options.maxNativeZoom = online ? 19 : SEEDED_MAX_ZOOM;
  }
  if (!online && map.getZoom() > SEEDED_MAX_ZOOM) {
    map.setZoom(SEEDED_MAX_ZOOM);
  }
}

/** Create a Leaflet TileLayer that prefers bundled → Cache API → network (Carto then OSM). */
export function createCachedTileLayer(L, options = {}) {
  const TileLayerCached = L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('img');
      tile.alt = '';
      tile.setAttribute('role', 'presentation');
      if (this.options.crossOrigin || this.options.crossOrigin === '') {
        tile.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
      }
      // Do not set src yet — an early placeholder would fire load/done before the real tile.
      // Guard done() so load+manual paths never double-complete a tile.
      let settled = false;
      const onceDone = (err, t) => {
        if (settled) return;
        settled = true;
        done(err, t);
      };
      L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, onceDone, tile));
      L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, onceDone, tile));
      tile.dataset.pending = '1';
      const z = coords.z;
      const x = coords.x;
      const y = coords.y;
      const url = this.getTileUrl(coords);
      this._loadCached(z, x, y, url, tile, onceDone);
      return tile;
    },

    async _loadCached(z, x, y, url, tile, done) {
      const cache = await openCache();
      const finishOk = (blob, flag) => {
        if (!tile || tile.dataset.aborted === '1') return;
        delete tile.dataset.pending;
        delete tile.dataset.miss;
        if (flag) tile.dataset[flag] = '1';
        // Setting src triggers 'load' → Leaflet _tileOnLoad → onceDone(null, tile)
        tile.src = objectUrlFromBlob(blob);
      };
      const finishMiss = (err) => {
        if (!tile || tile.dataset.aborted === '1') return;
        delete tile.dataset.pending;
        tile.dataset.miss = '1';
        // Gray placeholder: load handler completes done(null). Do not call done(err).
        tile.src = PLACEHOLDER_TILE;
        this.fire('tileoffline', { url, err, z, x, y });
      };

      try {
        // Offline + zoom outside seed range → skip bundled hope, show placeholder
        if (!isOnline() && (z < SEEDED_MIN_ZOOM || z > SEEDED_MAX_ZOOM)) {
          finishMiss(new Error('zoom-outside-seed'));
          return;
        }

        // (a) Bundled offline tiles
        const bundled = await tryBundled(z, x, y, { retries: 1 });
        if (bundled) {
          finishOk(bundled.blob, 'fromBundled');
          // Mirror under both network URL keys for later cache hits
          await putCache(cache, url, bundled.blob);
          for (const alt of networkTileUrls(z, x, y)) {
            if (alt !== url) await putCache(cache, alt, bundled.blob);
          }
          return;
        }

        // (b) Cache API (OSM + Carto keys)
        if (cache) {
          const hit = await matchCacheAnyKey(cache, [url, ...networkTileUrls(z, x, y)]);
          if (hit) {
            const blob = await hit.blob();
            if (blob && blob.size >= 50) {
              finishOk(blob, 'fromCache');
              return;
            }
          }
        }

        // (c) Network: Carto then OSM (reject watermark hashes)
        if (!isOnline()) {
          finishMiss(new Error('offline-miss'));
          return;
        }

        let lastErr;
        for (const netUrl of networkTileUrls(z, x, y)) {
          try {
            const res = await fetch(netUrl, { mode: 'cors', credentials: 'omit' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            if (!(await isUsableTileBlob(blob))) throw new Error('bad-tile');
            await putCache(cache, netUrl, blob);
            await putCache(cache, url, blob);
            finishOk(blob, netUrl.includes('cartocdn') ? 'fromCarto' : 'fromNetwork');
            return;
          } catch (e) {
            lastErr = e;
          }
        }
        throw lastErr || new Error('network-fail');
      } catch (err) {
        // Last chance: bundled again (race / slow asset server)
        const bundled = await tryBundled(z, x, y, { retries: 1 });
        if (bundled) {
          finishOk(bundled.blob, 'fromBundled');
          return;
        }
        if (cache) {
          const hit = await matchCacheAnyKey(cache, [url, ...networkTileUrls(z, x, y)]);
          if (hit) {
            const blob = await hit.blob();
            if (blob && blob.size >= 50) {
              finishOk(blob, 'fromCache');
              return;
            }
          }
        }
        finishMiss(err);
      }
    },
  });

  return new TileLayerCached(CARTO_TEMPLATE, {
    maxZoom: 19,
    maxNativeZoom: 19,
    subdomains: CARTO_SUBDOMAINS,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    crossOrigin: true,
    ...options,
  });
}

function lon2tile(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function lat2tile(lat, z) {
  return Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) /
      2) *
      Math.pow(2, z),
  );
}

/**
 * Prefetch tiles for a Leaflet LatLngBounds at zoom levels zMin..zMax.
 * Tries bundled → OSM → Carto for each tile.
 */
export async function prefetchTiles(bounds, zMin = 12, zMax = 16, onProgress) {
  if (!isOnline()) throw new Error('offline');
  const cache = await openCache();
  if (!cache) throw new Error('no-cache-api');

  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();

  const jobs = [];
  for (let z = zMin; z <= zMax; z++) {
    const x0 = lon2tile(west, z);
    const x1 = lon2tile(east, z);
    const y0 = lat2tile(north, z);
    const y1 = lat2tile(south, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        jobs.push({ z, x, y });
      }
    }
  }

  const MAX = 800;
  const list = jobs.slice(0, MAX);
  let ok = 0;
  let fail = 0;
  const concurrency = 4;
  let i = 0;

  async function worker() {
    while (i < list.length) {
      const idx = i++;
      const { z, x, y } = list[idx];
      const urls = networkTileUrls(z, x, y);
      const primary = urls[0];
      try {
        const existing = await matchCacheAnyKey(cache, urls);
        if (existing) {
          ok++;
        } else {
          const bundled = await tryBundled(z, x, y);
          if (bundled) {
            for (const u of urls) await putCache(cache, u, bundled.blob);
            ok++;
          } else {
            let saved = false;
            for (const netUrl of urls) {
              try {
                const res = await fetch(netUrl, { mode: 'cors', credentials: 'omit' });
                if (!res.ok) throw new Error(String(res.status));
                const blob = await res.blob();
                if (!(await isUsableTileBlob(blob))) throw new Error('bad-tile');
                for (const u of urls) await putCache(cache, u, blob);
                ok++;
                saved = true;
                await new Promise((r) => setTimeout(r, 80));
                break;
              } catch {
                /* try next template */
              }
            }
            if (!saved) fail++;
          }
        }
      } catch {
        fail++;
      }
      if (onProgress) onProgress({ ok, fail, total: list.length, done: ok + fail });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { ok, fail, total: list.length, truncated: jobs.length > MAX };
}

export async function countCachedTilesApprox() {
  const cache = await openCache();
  if (!cache) return 0;
  const keys = await cache.keys();
  return keys.length;
}

/**
 * Warm Cache API from bundled offline-tiles listed in manifest.
 * Retries manifest fetch; warms from China seedBbox / regions.
 */
export async function warmCacheFromBundled(onProgress) {
  const cache = await openCache();
  if (!cache) return { warmed: 0 };

  let manifest;
  const manifestUrl = resolveAssetUrl('offline-tiles/manifest.json');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(manifestUrl, { cache: attempt === 0 ? 'force-cache' : 'default' });
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      manifest = await res.json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  if (!manifest) return { warmed: 0 };

  const regions = [];
  if (Array.isArray(manifest.seedBbox) && manifest.seedBbox.length === 4) {
    regions.push({ bbox: manifest.seedBbox });
  }
  for (const a of manifest.airports || manifest.regions || manifest.metros || []) {
    const bbox = a.seedBbox || a.bbox;
    if (Array.isArray(bbox) && bbox.length === 4) regions.push({ bbox });
  }
  if (!regions.length) return { warmed: 0 };

  const zMin = manifest.zoom?.min ?? SEEDED_MIN_ZOOM;
  const zMax = manifest.zoom?.max ?? SEEDED_MAX_ZOOM;
  const jobs = [];
  const seen = new Set();
  for (const a of regions) {
    const bbox = a.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4) continue;
    const [south, west, north, east] = bbox;
    for (let z = zMin; z <= zMax; z++) {
      const x0 = lon2tile(west, z);
      const x1 = lon2tile(east, z);
      const y0 = lat2tile(north, z);
      const y1 = lat2tile(south, z);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = `${z}/${x}/${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          jobs.push({ z, x, y });
        }
      }
    }
  }

  let warmed = 0;
  const BATCH = 24;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const slice = jobs.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async ({ z, x, y }) => {
        const urls = networkTileUrls(z, x, y);
        try {
          if (await matchCacheAnyKey(cache, urls)) {
            warmed++;
            return;
          }
          const bundled = await tryBundled(z, x, y, { retries: 1 });
          if (!bundled) return;
          for (const u of urls) await putCache(cache, u, bundled.blob);
          warmed++;
        } catch {
          /* ignore */
        }
      }),
    );
    if (onProgress) onProgress({ warmed, total: jobs.length });
  }
  return { warmed, total: jobs.length };
}
