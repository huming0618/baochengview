#!/usr/bin/env node
/**
 * Generate elevation profile data for the Baocheng railway corridor.
 * 
 * Data source: Open-Meteo Elevation API (SRTM 90m, free, no API key required)
 * https://open-meteo.com/en/docs/elevation-api
 * 
 * This script:
 * 1. Samples corridor km at regular intervals
 * 2. For each km, finds a point on the actual track polyline (same as GPS projection)
 * 3. Fetches elevation from SRTM via Open-Meteo
 * 4. Filters unrealistic elevation jumps (>45‰ grade)
 * 
 * Outputs: public/elevation-profile.json
 */

const fs = require('fs');
const path = require('path');

const GEOJSON_PATH = path.join(__dirname, '../public/baocheng.geojson');
const OUTPUT_PATH = path.join(__dirname, '../public/elevation-profile.json');

const OPEN_METEO_ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';
const SAMPLE_INTERVAL_KM = 1.5;
const MAX_GRADE_PERMILLE = 45;

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

function fromXY(xy, lat0) {
  const toDeg = r => r * 180 / Math.PI;
  const cos = Math.cos(lat0 * Math.PI / 180);
  return {
    lat: toDeg(xy.y / EARTH_R),
    lon: toDeg(xy.x / (EARTH_R * cos)),
  };
}

function nearestOnSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
  const lat0 = (aLat + bLat + pLat) / 3;
  const P = toXY(pLat, pLon, lat0);
  const A = toXY(aLat, aLon, lat0);
  const B = toXY(bLat, bLon, lat0);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 1e-6) {
    t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const Q = { x: A.x + t * dx, y: A.y + t * dy };
  const q = fromXY(Q, lat0);
  const distM = Math.hypot(P.x - Q.x, P.y - Q.y);
  return { lat: q.lat, lon: q.lon, distM, t };
}

async function fetchElevations(coords, retries = 3) {
  const lats = coords.map(c => c.lat).join(',');
  const lons = coords.map(c => c.lon).join(',');
  const url = `${OPEN_METEO_ELEVATION_URL}?latitude=${lats}&longitude=${lons}`;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(url);
      if (resp.status === 429) {
        const waitMs = Math.pow(2, attempt + 2) * 1000;
        console.log(`    Rate limited, waiting ${waitMs/1000}s...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      if (!resp.ok) {
        throw new Error(`Open-Meteo API error: ${resp.status} ${resp.statusText}`);
      }
      const data = await resp.json();
      return data.elevation;
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('Max retries exceeded');
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
  for (const mls of multiLineStrings) {
    for (const part of mls.geometry.coordinates) {
      for (let i = 0; i < part.length - 1; i++) {
        const [lon1, lat1] = part[i];
        const [lon2, lat2] = part[i + 1];
        segs.push({ aLat: lat1, aLon: lon1, bLat: lat2, bLon: lon2 });
      }
    }
  }
  return segs;
}

function nearestOnPolyline(lat, lon, segs) {
  let best = null;
  for (const s of segs) {
    const hit = nearestOnSegment(lat, lon, s.aLat, s.aLon, s.bLat, s.bLon);
    if (!best || hit.distM < best.distM) {
      best = hit;
    }
  }
  return best || { lat, lon, distM: Infinity };
}

/**
 * Convert a corridor km value to a point on the track polyline.
 * Interpolates between stations, then projects to nearest polyline segment.
 */
function corridorKmToTrackPoint(km, corridor, segs) {
  if (km <= 0) return { lat: corridor[0].lat, lon: corridor[0].lon };
  if (km >= corridor[corridor.length - 1].km) {
    return { lat: corridor[corridor.length - 1].lat, lon: corridor[corridor.length - 1].lon };
  }
  
  let stationIdx = 0;
  for (let i = 0; i < corridor.length - 1; i++) {
    if (km >= corridor[i].km && km <= corridor[i + 1].km) {
      stationIdx = i;
      break;
    }
  }
  
  const prev = corridor[stationIdx];
  const next = corridor[stationIdx + 1];
  const t = (km - prev.km) / (next.km - prev.km);
  
  const interpLat = prev.lat + t * (next.lat - prev.lat);
  const interpLon = prev.lon + t * (next.lon - prev.lon);
  
  const onTrack = nearestOnPolyline(interpLat, interpLon, segs);
  
  if (onTrack.distM < 5000) {
    return { lat: onTrack.lat, lon: onTrack.lon };
  }
  return { lat: interpLat, lon: interpLon };
}

function filterUnrealisticGrades(profile, maxGradePermille) {
  const filtered = [];
  const issues = [];
  
  for (let i = 0; i < profile.length; i++) {
    const pt = profile[i];
    
    if (pt.elevation === null) {
      issues.push({ km: pt.km, reason: 'null elevation' });
      continue;
    }
    
    if (filtered.length === 0) {
      filtered.push({ ...pt });
      continue;
    }
    
    const prev = filtered[filtered.length - 1];
    const distKm = Math.abs(pt.km - prev.km);
    const elevDiff = Math.abs(pt.elevation - prev.elevation);
    
    if (distKm > 0.01) {
      const gradePermille = (elevDiff / (distKm * 1000)) * 1000;
      
      if (gradePermille > maxGradePermille) {
        issues.push({ 
          km: pt.km, 
          reason: `grade ${gradePermille.toFixed(0)}‰ (${prev.elevation}m → ${pt.elevation}m over ${(distKm*1000).toFixed(0)}m)`,
          originalElev: pt.elevation
        });
        continue;
      }
    }
    
    filtered.push({ ...pt });
  }
  
  const result = [];
  for (let i = 0; i < profile.length; i++) {
    const pt = profile[i];
    const existing = filtered.find(f => Math.abs(f.km - pt.km) < 0.01);
    
    if (existing) {
      result.push(existing);
    } else {
      let prevF = null, nextF = null;
      for (const f of filtered) {
        if (f.km < pt.km && (!prevF || f.km > prevF.km)) prevF = f;
        if (f.km > pt.km && (!nextF || f.km < nextF.km)) nextF = f;
      }
      
      if (prevF && nextF) {
        const t = (pt.km - prevF.km) / (nextF.km - prevF.km);
        const interpElev = Math.round(prevF.elevation + t * (nextF.elevation - prevF.elevation));
        result.push({ ...pt, elevation: interpElev, interpolated: true });
      } else if (prevF) {
        result.push({ ...pt, elevation: prevF.elevation, interpolated: true });
      } else if (nextF) {
        result.push({ ...pt, elevation: nextF.elevation, interpolated: true });
      }
    }
  }
  
  return { profile: result, issues };
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
  
  console.log(`Found ${stations.length} stations`);
  console.log(`Corridor: ${totalKm.toFixed(1)} km (station-to-station)`);
  
  const lineFeatures = geojson.features.filter(f => f.geometry.type === 'MultiLineString');
  const segs = flattenLineCoords(lineFeatures);
  console.log(`Track geometry: ${segs.length} segments`);
  
  console.log(`Generating sample points every ${SAMPLE_INTERVAL_KM} km...`);
  const sampleKms = [];
  for (let km = 0; km <= totalKm; km += SAMPLE_INTERVAL_KM) {
    sampleKms.push(Math.round(km * 10) / 10);
  }
  if (sampleKms[sampleKms.length - 1] < totalKm - 0.5) {
    sampleKms.push(Math.round(totalKm * 10) / 10);
  }
  
  const samples = sampleKms.map(km => {
    const pt = corridorKmToTrackPoint(km, corridor, segs);
    return { km, lat: pt.lat, lon: pt.lon };
  });
  console.log(`${samples.length} sample points`);
  
  console.log('Fetching elevations from Open-Meteo (SRTM)...');
  const BATCH_SIZE = 80;
  const elevations = [];
  
  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
    const batch = samples.slice(i, i + BATCH_SIZE);
    console.log(`  Batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(samples.length/BATCH_SIZE)}...`);
    
    try {
      const elevs = await fetchElevations(batch);
      elevations.push(...elevs);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      for (let j = 0; j < batch.length; j++) {
        elevations.push(null);
      }
    }
    
    if (i + BATCH_SIZE < samples.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  
  const rawProfile = samples.map((s, i) => ({
    km: s.km,
    lat: s.lat,
    lon: s.lon,
    elevation: elevations[i]
  }));
  
  console.log(`Filtering unrealistic grades (>${MAX_GRADE_PERMILLE}‰)...`);
  const { profile: filteredProfile, issues } = filterUnrealisticGrades(rawProfile, MAX_GRADE_PERMILLE);
  
  if (issues.length > 0) {
    console.log(`  Filtered/interpolated ${issues.length} points:`);
    issues.slice(0, 8).forEach(iss => console.log(`    km ${iss.km}: ${iss.reason}`));
    if (issues.length > 8) console.log(`    ... and ${issues.length - 8} more`);
  }
  
  console.log('Fetching station elevations...');
  const stationElevs = await fetchElevations(stations.map(s => ({ lat: s.lat, lon: s.lon })));
  
  const stationsWithElevation = corridor.map((s, i) => ({
    name: s.name,
    order: s.order,
    km: Math.round(s.km * 10) / 10,
    lat: s.lat,
    lon: s.lon,
    elevation: stationElevs[i]
  }));
  
  const validElevs = filteredProfile.map(p => p.elevation).filter(e => e !== null);
  const minElev = Math.min(...validElevs);
  const maxElev = Math.max(...validElevs);
  const interpolatedCount = filteredProfile.filter(p => p.interpolated).length;
  
  const output = {
    source: 'Open-Meteo Elevation API (SRTM 90m)',
    generated: new Date().toISOString(),
    notes: {
      samplingMethod: 'Points sampled at regular corridor-km intervals, projected to nearest track segment',
      kmSystem: 'Corridor-km consistent with locate projection (station-to-station interpolation)',
      gradeFilter: `Points implying >${MAX_GRADE_PERMILLE}‰ grade were interpolated from neighbors`,
      interpolatedPoints: interpolatedCount,
      filteredIssues: issues.length
    },
    summary: {
      totalKm: Math.round(totalKm * 10) / 10,
      minElevation: minElev,
      maxElevation: maxElev,
      stationCount: stations.length,
      profilePoints: filteredProfile.length
    },
    stations: stationsWithElevation,
    profile: filteredProfile.map(p => ({
      km: p.km,
      elevation: p.elevation,
      ...(p.interpolated ? { interpolated: true } : {})
    }))
  };
  
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote elevation profile to ${OUTPUT_PATH}`);
  console.log(`Summary: ${output.summary.totalKm} km corridor, ${minElev}m - ${maxElev}m elevation`);
  console.log(`Profile: ${filteredProfile.length} points, ${interpolatedCount} interpolated`);
  
  if (issues.length > 0) {
    console.log(`\nNote: ${issues.length} points were filtered/interpolated due to unrealistic grades.`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
