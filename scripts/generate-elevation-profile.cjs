#!/usr/bin/env node
/**
 * Generate elevation profile data for the Baocheng railway corridor.
 * 
 * Data source: Open-Meteo Elevation API (SRTM 90m, free, no API key required)
 * https://open-meteo.com/en/docs/elevation-api
 * 
 * Uses station-to-station km as the ground truth for corridor distance,
 * and samples intermediate points between stations for profile resolution.
 * 
 * Outputs: public/elevation-profile.json
 */

const fs = require('fs');
const path = require('path');

const GEOJSON_PATH = path.join(__dirname, '../public/baocheng.geojson');
const OUTPUT_PATH = path.join(__dirname, '../public/elevation-profile.json');

const OPEN_METEO_ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function interpolateCoord(lat1, lon1, lat2, lon2, t) {
  return {
    lat: lat1 + t * (lat2 - lat1),
    lon: lon1 + t * (lon2 - lon1)
  };
}

async function fetchElevations(coords) {
  const lats = coords.map(c => c.lat).join(',');
  const lons = coords.map(c => c.lon).join(',');
  
  const url = `${OPEN_METEO_ELEVATION_URL}?latitude=${lats}&longitude=${lons}`;
  
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Open-Meteo API error: ${resp.status} ${resp.statusText}`);
  }
  
  const data = await resp.json();
  return data.elevation;
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
  
  console.log(`Found ${stations.length} stations`);
  
  let cumulativeKm = 0;
  const stationsWithKm = stations.map((s, i) => {
    if (i > 0) {
      cumulativeKm += haversineKm(stations[i-1].lat, stations[i-1].lon, s.lat, s.lon);
    }
    return { ...s, km: Math.round(cumulativeKm * 10) / 10 };
  });
  
  const totalKm = stationsWithKm[stationsWithKm.length - 1].km;
  console.log(`Total corridor length: ${totalKm} km (station-to-station)`);
  
  const SAMPLES_BETWEEN_STATIONS = 3;
  const profileCoords = [];
  
  for (let i = 0; i < stationsWithKm.length; i++) {
    const s = stationsWithKm[i];
    profileCoords.push({ lat: s.lat, lon: s.lon, km: s.km, isStation: true, stationName: s.name });
    
    if (i < stationsWithKm.length - 1) {
      const next = stationsWithKm[i + 1];
      const segKm = next.km - s.km;
      
      for (let j = 1; j <= SAMPLES_BETWEEN_STATIONS; j++) {
        const t = j / (SAMPLES_BETWEEN_STATIONS + 1);
        const interp = interpolateCoord(s.lat, s.lon, next.lat, next.lon, t);
        profileCoords.push({
          lat: interp.lat,
          lon: interp.lon,
          km: Math.round((s.km + t * segKm) * 10) / 10,
          isStation: false
        });
      }
    }
  }
  
  console.log(`Profile has ${profileCoords.length} sample points`);
  
  console.log(`Fetching elevations...`);
  
  const BATCH_SIZE = 100;
  const allElevations = [];
  
  for (let i = 0; i < profileCoords.length; i += BATCH_SIZE) {
    const batch = profileCoords.slice(i, i + BATCH_SIZE);
    console.log(`  Batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(profileCoords.length/BATCH_SIZE)}...`);
    
    try {
      const elevs = await fetchElevations(batch);
      allElevations.push(...elevs);
    } catch (err) {
      console.error(`  Error fetching batch: ${err.message}`);
      for (let j = 0; j < batch.length; j++) {
        allElevations.push(null);
      }
    }
    
    if (i + BATCH_SIZE < profileCoords.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  for (let i = 0; i < profileCoords.length; i++) {
    profileCoords[i].elevation = allElevations[i];
  }
  
  let nullCount = 0;
  for (let i = 0; i < profileCoords.length; i++) {
    if (profileCoords[i].elevation === null) {
      nullCount++;
      let prev = null, next = null;
      for (let j = i - 1; j >= 0; j--) {
        if (profileCoords[j].elevation !== null) { prev = profileCoords[j]; break; }
      }
      for (let j = i + 1; j < profileCoords.length; j++) {
        if (profileCoords[j].elevation !== null) { next = profileCoords[j]; break; }
      }
      if (prev && next) {
        const t = (profileCoords[i].km - prev.km) / (next.km - prev.km);
        profileCoords[i].elevation = Math.round(prev.elevation + t * (next.elevation - prev.elevation));
        profileCoords[i].interpolated = true;
      } else if (prev) {
        profileCoords[i].elevation = prev.elevation;
        profileCoords[i].interpolated = true;
      } else if (next) {
        profileCoords[i].elevation = next.elevation;
        profileCoords[i].interpolated = true;
      }
    }
  }
  
  if (nullCount > 0) {
    console.log(`Interpolated ${nullCount} missing elevation values`);
  }
  
  const stationsWithElevation = profileCoords
    .filter(p => p.isStation)
    .map(p => {
      const s = stationsWithKm.find(st => st.name === p.stationName);
      return {
        name: s.name,
        order: s.order,
        km: p.km,
        lat: s.lat,
        lon: s.lon,
        elevation: p.elevation,
        ...(p.interpolated ? { interpolated: true } : {})
      };
    });
  
  const elevations = profileCoords.map(p => p.elevation).filter(e => e !== null);
  const minElev = Math.min(...elevations);
  const maxElev = Math.max(...elevations);
  
  const output = {
    source: 'Open-Meteo Elevation API (SRTM 90m)',
    generated: new Date().toISOString(),
    summary: {
      totalKm: totalKm,
      minElevation: minElev,
      maxElevation: maxElev,
      stationCount: stations.length,
      profilePoints: profileCoords.length
    },
    stations: stationsWithElevation,
    profile: profileCoords.map(p => ({
      km: p.km,
      elevation: p.elevation,
      ...(p.interpolated ? { interpolated: true } : {})
    }))
  };
  
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote elevation profile to ${OUTPUT_PATH}`);
  console.log(`Summary: ${output.summary.totalKm} km, ${output.summary.minElevation}m - ${output.summary.maxElevation}m elevation`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
