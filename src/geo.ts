/** Geometry helpers: project GPS onto Baocheng corridor polyline & station scale. */

export interface LatLng {
  lat: number
  lon: number
}

export interface Station extends LatLng {
  name: string
  order: number
}

export interface CorridorStation extends Station {
  /** Cumulative km from first station (order ascending: 宝鸡→成都). */
  km: number
}

export interface LineProjection {
  lat: number
  lon: number
  /** Distance from GPS to nearest point on polyline (meters). */
  distM: number
  /** Rough km along station corridor (宝鸡=0). */
  kmAlong: number
  prev: CorridorStation
  next: CorridorStation
  /** 0..1 within prev→next segment; 0 if at a station / endpoint. */
  t: number
  /** True when very close to a single station. */
  atStation: CorridorStation | null
}

const EARTH_R = 6371000

export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Local equirectangular meters around a reference latitude. */
function toXY(p: LatLng, lat0: number): { x: number; y: number } {
  const toRad = (d: number) => (d * Math.PI) / 180
  const cos = Math.cos(toRad(lat0))
  return {
    x: toRad(p.lon) * EARTH_R * cos,
    y: toRad(p.lat) * EARTH_R,
  }
}

function fromXY(xy: { x: number; y: number }, lat0: number): LatLng {
  const toDeg = (r: number) => (r * 180) / Math.PI
  const cos = Math.cos((lat0 * Math.PI) / 180)
  return {
    lat: toDeg(xy.y / EARTH_R),
    lon: toDeg(xy.x / (EARTH_R * cos)),
  }
}

export interface SegHit {
  lat: number
  lon: number
  distM: number
  t: number
}

/** Nearest point on segment A→B to P (planar approx in local meters). */
export function nearestOnSegment(p: LatLng, a: LatLng, b: LatLng): SegHit {
  const lat0 = (a.lat + b.lat + p.lat) / 3
  const P = toXY(p, lat0)
  const A = toXY(a, lat0)
  const B = toXY(b, lat0)
  const dx = B.x - A.x
  const dy = B.y - A.y
  const len2 = dx * dx + dy * dy
  let t = 0
  if (len2 > 1e-6) {
    t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2
    t = Math.max(0, Math.min(1, t))
  }
  const Q = { x: A.x + t * dx, y: A.y + t * dy }
  const q = fromXY(Q, lat0)
  const distM = Math.hypot(P.x - Q.x, P.y - Q.y)
  return { lat: q.lat, lon: q.lon, distM, t }
}

/** Flatten MultiLineString coordinates [lon,lat][][] into segment endpoints. */
export function flattenLineCoords(
  multi: [number, number][][]
): { a: LatLng; b: LatLng }[] {
  const segs: { a: LatLng; b: LatLng }[] = []
  for (const part of multi) {
    for (let i = 0; i < part.length - 1; i++) {
      const [lon1, lat1] = part[i]
      const [lon2, lat2] = part[i + 1]
      segs.push({
        a: { lat: lat1, lon: lon1 },
        b: { lat: lat2, lon: lon2 },
      })
    }
  }
  return segs
}

export function nearestOnPolyline(
  p: LatLng,
  segs: { a: LatLng; b: LatLng }[]
): SegHit {
  let best: SegHit | null = null
  for (const s of segs) {
    const hit = nearestOnSegment(p, s.a, s.b)
    if (!best || hit.distM < best.distM) best = hit
  }
  return best ?? { lat: p.lat, lon: p.lon, distM: Infinity, t: 0 }
}

/** Build corridor stations sorted by order with cumulative km (宝鸡→成都). */
export function buildCorridor(stations: Station[]): CorridorStation[] {
  const sorted = [...stations].sort((a, b) => a.order - b.order)
  const out: CorridorStation[] = []
  let km = 0
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) km += haversineM(sorted[i - 1], sorted[i]) / 1000
    out.push({ ...sorted[i], km })
  }
  return out
}

const AT_STATION_M = 400

/**
 * Project GPS onto the railway polyline, then infer which two stations
 * the user is between using the station-order corridor spine.
 */
export function projectOntoCorridor(
  gps: LatLng,
  corridor: CorridorStation[],
  segs: { a: LatLng; b: LatLng }[]
): LineProjection | null {
  if (corridor.length < 2) return null

  const onLine = nearestOnPolyline(gps, segs)
  const P: LatLng = { lat: onLine.lat, lon: onLine.lon }

  // Prefer consecutive station pair whose A→B segment best contains P
  let bestIdx = 0
  let bestScore = Infinity
  let bestT = 0
  for (let i = 0; i < corridor.length - 1; i++) {
    const hit = nearestOnSegment(P, corridor[i], corridor[i + 1])
    // Soft penalty outside segment so endpoints still work
    const outside = hit.t <= 0 || hit.t >= 1 ? 80 : 0
    const score = hit.distM + outside
    if (score < bestScore) {
      bestScore = score
      bestIdx = i
      bestT = hit.t
    }
  }

  // Also consider raw distance to each station (snap if on platform)
  let nearestSt = corridor[0]
  let nearestD = haversineM(P, nearestSt)
  for (const s of corridor) {
    const d = haversineM(P, s)
    if (d < nearestD) {
      nearestD = d
      nearestSt = s
    }
  }

  const prev = corridor[bestIdx]
  const next = corridor[bestIdx + 1]
  const segKm = Math.max(next.km - prev.km, 1e-6)
  const t = Math.max(0, Math.min(1, bestT))
  const kmAlong = prev.km + t * segKm

  const atStation = nearestD <= AT_STATION_M ? nearestSt : null

  return {
    lat: onLine.lat,
    lon: onLine.lon,
    distM: onLine.distM,
    kmAlong,
    prev,
    next,
    t,
    atStation,
  }
}
