#!/usr/bin/env node
/**
 * Generate river crossing data for the Baocheng railway corridor.
 * 
 * Data source: OpenStreetMap via Overpass API
 * 
 * This script:
 * 1. Fetches major rivers near the Baocheng railway
 * 2. Calculates where each river crosses or is followed by the railway
 * 3. Maps crossings to corridor km positions
 * 
 * Outputs: public/rivers.json
 */

const fs = require('fs');
const path = require('path');

const GEOJSON_PATH = path.join(__dirname, '../public/baocheng.geojson');
const OUTPUT_PATH = path.join(__dirname, '../public/rivers.json');

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const EARTH_R = 6371000;

function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  return haversineM(lat1, lon1, lat2, lon2) / 1000;
}

function toXY(lat, lon, lat0) {
  const toRad = d => d * Math.PI / 180;
  const cos = Math.cos(toRad(lat0));
  return {
    x: toRad(lon) * EARTH_R * cos,
    y: toRad(lat) * EARTH_R,
  };
}

function lineSegmentIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const denom = (dy - cy) * (bx - ax) - (dx - cx) * (by - ay);
  if (Math.abs(denom) < 1e-10) return null;
  
  const ua = ((dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)) / denom;
  const ub = ((bx - ax) * (ay - cy) - (by - ay) * (ax - cx)) / denom;
  
  if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
    return {
      x: ax + ua * (bx - ax),
      y: ay + ua * (by - ay),
      t: ua
    };
  }
  return null;
}

function buildCorridor(stations) {
  const sorted = [...stations].sort((a, b) => a.order - b.order);
  const out = [];
  let km = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) km += haversineKm(sorted[i - 1].lat, sorted[i - 1].lon, sorted[i].lat, sorted[i].lon);
    out.push({ ...sorted[i], km });
  }
  return out;
}

function flattenLineCoords(multiLineStrings) {
  const segs = [];
  let cumKm = 0;
  
  for (const mls of multiLineStrings) {
    for (const part of mls.geometry.coordinates) {
      for (let i = 0; i < part.length - 1; i++) {
        const [lon1, lat1] = part[i];
        const [lon2, lat2] = part[i + 1];
        const segLen = haversineKm(lat1, lon1, lat2, lon2);
        segs.push({ 
          aLat: lat1, aLon: lon1, bLat: lat2, bLon: lon2,
          kmStart: cumKm,
          kmEnd: cumKm + segLen
        });
        cumKm += segLen;
      }
    }
  }
  return segs;
}

function pointToCorridorKm(lat, lon, corridor, trackSegs) {
  const lat0 = lat;
  const P = toXY(lat, lon, lat0);
  
  let bestDist = Infinity;
  let bestKm = 0;
  
  for (let i = 0; i < corridor.length - 1; i++) {
    const prev = corridor[i];
    const next = corridor[i + 1];
    
    const A = toXY(prev.lat, prev.lon, lat0);
    const B = toXY(next.lat, next.lon, lat0);
    
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len2 = dx * dx + dy * dy;
    
    let t = 0;
    if (len2 > 1e-6) {
      t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    
    const Qx = A.x + t * dx;
    const Qy = A.y + t * dy;
    const dist = Math.hypot(P.x - Qx, P.y - Qy);
    
    if (dist < bestDist) {
      bestDist = dist;
      bestKm = prev.km + t * (next.km - prev.km);
    }
  }
  
  return { km: bestKm, distM: bestDist };
}

async function fetchRivers(bbox) {
  const query = `
[out:json][timeout:60];
(
  way["waterway"="river"](${bbox});
  relation["waterway"="river"](${bbox});
);
out body;
>;
out skel qt;
`;

  console.log('Fetching rivers from Overpass API...');
  const resp = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  
  if (!resp.ok) {
    throw new Error(`Overpass API error: ${resp.status}`);
  }
  
  return resp.json();
}

function parseOsmRivers(osmData) {
  const nodes = new Map();
  const rivers = [];
  
  for (const el of osmData.elements) {
    if (el.type === 'node') {
      nodes.set(el.id, { lat: el.lat, lon: el.lon });
    }
  }
  
  for (const el of osmData.elements) {
    if (el.type === 'way' && el.tags?.waterway === 'river') {
      const name = el.tags.name || el.tags['name:zh'] || null;
      if (!name) continue;
      
      const coords = [];
      for (const nodeId of el.nodes) {
        const node = nodes.get(nodeId);
        if (node) coords.push(node);
      }
      
      if (coords.length >= 2) {
        rivers.push({ name, coords, osmId: el.id });
      }
    }
  }
  
  return rivers;
}

function findRiverCrossings(rivers, trackSegs, corridor) {
  const crossings = [];
  const seenRivers = new Map();
  
  for (const river of rivers) {
    for (let i = 0; i < river.coords.length - 1; i++) {
      const r1 = river.coords[i];
      const r2 = river.coords[i + 1];
      
      for (const seg of trackSegs) {
        const lat0 = (r1.lat + r2.lat + seg.aLat + seg.bLat) / 4;
        
        const R1 = toXY(r1.lat, r1.lon, lat0);
        const R2 = toXY(r2.lat, r2.lon, lat0);
        const T1 = toXY(seg.aLat, seg.aLon, lat0);
        const T2 = toXY(seg.bLat, seg.bLon, lat0);
        
        const inter = lineSegmentIntersect(R1.x, R1.y, R2.x, R2.y, T1.x, T1.y, T2.x, T2.y);
        
        if (inter) {
          const crossKm = seg.kmStart + inter.t * (seg.kmEnd - seg.kmStart);
          const projResult = pointToCorridorKm(
            r1.lat + inter.t * (r2.lat - r1.lat),
            r1.lon + inter.t * (r2.lon - r1.lon),
            corridor,
            trackSegs
          );
          
          const key = river.name;
          if (!seenRivers.has(key) || Math.abs(projResult.km - seenRivers.get(key).km) > 10) {
            const entry = {
              name: river.name,
              km: Math.round(projResult.km * 10) / 10,
              type: 'crossing'
            };
            
            if (!seenRivers.has(key) || projResult.km < seenRivers.get(key).km) {
              seenRivers.set(key, entry);
            }
            
            crossings.push(entry);
          }
        }
      }
    }
  }
  
  return crossings;
}

async function main() {
  console.log('Loading GeoJSON...');
  const geojson = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf8'));
  
  const stations = geojson.features
    .filter(f => f.geometry.type === 'Point')
    .map(f => ({
      name: f.properties.name,
      order: f.properties.order,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1]
    }))
    .sort((a, b) => a.order - b.order);
  
  const corridor = buildCorridor(stations);
  const totalKm = corridor[corridor.length - 1].km;
  
  console.log(`Corridor: ${totalKm.toFixed(1)} km`);
  
  const lineFeatures = geojson.features.filter(f => f.geometry.type === 'MultiLineString');
  const trackSegs = flattenLineCoords(lineFeatures);
  
  // Calculate bounding box with buffer
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const s of stations) {
    minLat = Math.min(minLat, s.lat);
    maxLat = Math.max(maxLat, s.lat);
    minLon = Math.min(minLon, s.lon);
    maxLon = Math.max(maxLon, s.lon);
  }
  
  const buffer = 0.15; // ~15km buffer
  const bbox = `${minLat - buffer},${minLon - buffer},${maxLat + buffer},${maxLon + buffer}`;
  console.log(`Bounding box: ${bbox}`);
  
  const osmData = await fetchRivers(bbox);
  console.log(`Found ${osmData.elements.length} OSM elements`);
  
  const rivers = parseOsmRivers(osmData);
  console.log(`Parsed ${rivers.length} named rivers`);
  
  const crossings = findRiverCrossings(rivers, trackSegs, corridor);
  console.log(`Found ${crossings.length} raw crossings`);
  
  // Deduplicate and sort
  const uniqueRivers = new Map();
  for (const c of crossings) {
    const existing = uniqueRivers.get(c.name);
    if (!existing) {
      uniqueRivers.set(c.name, [c]);
    } else {
      // Check if this is a significantly different crossing point
      const isDifferent = existing.every(e => Math.abs(e.km - c.km) > 15);
      if (isDifferent) {
        existing.push(c);
      }
    }
  }
  
  // Flatten and add crossing numbers for rivers that cross multiple times
  const finalRivers = [];
  for (const [name, riverCrossings] of uniqueRivers) {
    riverCrossings.sort((a, b) => a.km - b.km);
    
    for (let i = 0; i < riverCrossings.length; i++) {
      const c = riverCrossings[i];
      finalRivers.push({
        name: riverCrossings.length > 1 ? `${name} (${i + 1})` : name,
        baseName: name,
        km: c.km,
        crossingIndex: i + 1,
        totalCrossings: riverCrossings.length
      });
    }
  }
  
  finalRivers.sort((a, b) => a.km - b.km);
  
  // Add well-known rivers manually if missing (major rivers along Baocheng)
  const knownRivers = [
    { name: '渭河', km: 3, desc: '宝鸡市区' },
    { name: '清姜河', km: 12, desc: '清姜峡' },
    { name: '嘉陵江', km: 68, desc: '凤州至略阳段' },
    { name: '西汉水', km: 145, desc: '略阳附近' },
    { name: '嘉陵江', km: 190, desc: '阳平关至广元' },
    { name: '白龙江', km: 230, desc: '广元西' },
    { name: '嘉陵江', km: 275, desc: '昭化至剑门关' },
    { name: '涪江', km: 380, desc: '绵阳附近' },
    { name: '沱江', km: 470, desc: '德阳至成都' },
    { name: '府河', km: 540, desc: '成都市区' }
  ];
  
  // Merge known rivers with detected ones
  for (const kr of knownRivers) {
    const exists = finalRivers.some(r => 
      r.baseName === kr.name && Math.abs(r.km - kr.km) < 30
    );
    if (!exists) {
      finalRivers.push({
        name: kr.name,
        baseName: kr.name,
        km: kr.km,
        desc: kr.desc,
        source: 'manual'
      });
    }
  }
  
  finalRivers.sort((a, b) => a.km - b.km);
  
  const output = {
    source: 'OpenStreetMap + manual annotations',
    generated: new Date().toISOString(),
    summary: {
      totalKm: Math.round(totalKm * 10) / 10,
      riverCount: finalRivers.length,
      uniqueRivers: new Set(finalRivers.map(r => r.baseName)).size
    },
    rivers: finalRivers.map(r => ({
      name: r.name,
      km: r.km,
      ...(r.desc ? { desc: r.desc } : {})
    }))
  };
  
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote river data to ${OUTPUT_PATH}`);
  console.log(`Summary: ${output.summary.riverCount} river crossings, ${output.summary.uniqueRivers} unique rivers`);
  
  console.log('\nRivers along the line:');
  for (const r of output.rivers) {
    console.log(`  km ${String(r.km).padStart(5)}: ${r.name}${r.desc ? ` (${r.desc})` : ''}`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
