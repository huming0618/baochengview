/**
 * Stay log: record time spent at a station, not the stretch between stations.
 *
 * Arrival uses the same 400 m radius as geo.AT_STATION_M.
 * Exit uses a larger 800 m radius so GPS jitter around the arrival edge
 * does not split one stop into many records.
 *
 * Completed stays (station, start, duration) are written to localStorage.
 * An in-progress stay stays in memory only and is shown as 正在停.
 */

import { AT_STATION_M, haversineM, type CorridorStation, type LatLng } from './geo.ts'

export const STAY_ARRIVAL_M = AT_STATION_M
export const STAY_EXIT_M = 800

export interface StayRecord {
  id: string
  stationName: string
  stationKm: number
  startTime: number
  endTime: number
  durationMs: number
}

export interface CurrentStay {
  station: CorridorStation
  startTime: number
}

const STORAGE_KEY = 'baocheng_stay_log'

let currentStay: CurrentStay | null = null
let records: StayRecord[] = []
const listeners = new Set<() => void>()

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function loadRecords(): StayRecord[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored) as StayRecord[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r) =>
        r &&
        typeof r.stationName === 'string' &&
        typeof r.startTime === 'number' &&
        typeof r.endTime === 'number' &&
        typeof r.durationMs === 'number'
    )
  } catch (e) {
    console.error('[StayLog] Failed to load records:', e)
    return []
  }
}

function saveRecords() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  } catch (e) {
    console.error('[StayLog] Failed to save records:', e)
  }
}

function notify() {
  for (const fn of listeners) fn()
}

function nearestStation(
  gps: LatLng,
  corridor: CorridorStation[]
): { station: CorridorStation; distM: number } | null {
  if (corridor.length === 0) return null
  let station = corridor[0]
  let distM = haversineM(gps, station)
  for (const s of corridor) {
    const d = haversineM(gps, s)
    if (d < distM) {
      distM = d
      station = s
    }
  }
  return { station, distM }
}

function closeCurrentStay(endTime: number) {
  if (!currentStay) return
  const durationMs = Math.max(0, endTime - currentStay.startTime)
  const record: StayRecord = {
    id: generateId(),
    stationName: currentStay.station.name,
    stationKm: currentStay.station.km,
    startTime: currentStay.startTime,
    endTime,
    durationMs,
  }
  records.push(record)
  saveRecords()
  console.log(
    `[StayLog] Closed stay at ${record.stationName}: ${formatDuration(durationMs)}`
  )
  currentStay = null
}

export function initStayLog() {
  records = loadRecords()
}

export function subscribeStayLog(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Update stay state from a GPS fix. Pass null when locate is off —
 * an open stay is left open (lost GPS is not a departure).
 */
export function updateStayLog(gps: LatLng | null, corridor: CorridorStation[]) {
  if (!gps || corridor.length === 0) {
    notify()
    return
  }

  const now = Date.now()
  let changed = false

  if (currentStay) {
    const distStay = haversineM(gps, currentStay.station)
    if (distStay > STAY_EXIT_M) {
      closeCurrentStay(now)
      changed = true
    }
  }

  if (!currentStay) {
    const nearest = nearestStation(gps, corridor)
    if (nearest && nearest.distM <= STAY_ARRIVAL_M) {
      currentStay = { station: nearest.station, startTime: now }
      changed = true
      console.log(
        `[StayLog] Started stay at ${nearest.station.name} (${Math.round(nearest.distM)} m)`
      )
    }
  }

  if (changed) notify()
}

export function getStayRecords(): StayRecord[] {
  return [...records].reverse()
}

export function getCurrentStay(): CurrentStay | null {
  return currentStay
}

export function formatDuration(ms: number): string {
  if (ms < 60000) {
    const secs = Math.floor(ms / 1000)
    return `${secs} 秒`
  }
  if (ms < 3600000) {
    const mins = Math.floor(ms / 60000)
    const secs = Math.floor((ms % 60000) / 1000)
    return secs > 0 ? `${mins} 分 ${secs} 秒` : `${mins} 分钟`
  }
  const hours = Math.floor(ms / 3600000)
  const mins = Math.floor((ms % 3600000) / 60000)
  return mins > 0 ? `${hours} 小时 ${mins} 分` : `${hours} 小时`
}

export function formatStayTime(timestamp: number): string {
  const d = new Date(timestamp)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hour = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${month}月${day}日 ${hour}:${min}`
}
