import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './style.css'
import {
  createCachedTileLayer,
  syncOfflineZoomLimits,
  warmCacheFromBundled,
  isOnline,
  resolveAssetUrl,
} from './tileCache.ts'
import { createLocateControl, type LocatePosition } from './locate.ts'
import {
  buildCorridor,
  flattenLineCoords,
  projectOntoCorridor,
  type CorridorStation,
  type LineProjection,
} from './geo.ts'
import { createScaleView } from './scaleView.ts'

interface StationProperties {
  name: string
  order: number
  type: string
}

interface LineProperties {
  name: string
  name_en: string
  from: string
  to: string
  ref: string
}

interface GeoJSONFeature {
  type: 'Feature'
  properties: StationProperties | LineProperties
  geometry: {
    type: 'Point' | 'MultiLineString'
    coordinates: [number, number] | [number, number][][]
  }
}

interface GeoJSONData {
  type: 'FeatureCollection'
  features: GeoJSONFeature[]
}

type AppView = 'map' | 'scale'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <div id="map-container">
    <header class="map-header">
      <div class="header-top">
        <div class="search-container">
          <input type="text" id="search-input" placeholder="搜索车站..." autocomplete="off" />
          <div id="search-results"></div>
        </div>
        <div class="view-toggle" role="group" aria-label="视图切换">
          <button type="button" id="view-map-btn" class="view-toggle-btn active" aria-pressed="true">地图</button>
          <button type="button" id="view-scale-btn" class="view-toggle-btn" aria-pressed="false">站序</button>
        </div>
        <button id="fit-line-btn" title="显示全线">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>
          </svg>
        </button>
      </div>
      <div id="location-status" class="location-status">
        <span class="location-status-icon">📍</span>
        <div class="location-status-content">
          <span id="location-status-coords" class="location-status-coords">未定位</span>
          <span id="location-status-corridor" class="location-status-corridor"></span>
        </div>
      </div>
    </header>
    <div id="map"></div>
    <div id="scale-view" class="scale-view hidden" aria-label="宝成线站序刻度"></div>
    <button id="locate-btn" class="locate-btn" title="定位 / 跟随我" type="button" aria-pressed="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="12" cy="12" r="3"/>
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
        <circle cx="12" cy="12" r="8"/>
      </svg>
      <span id="locate-label">定位</span>
    </button>
    <div id="offline-banner" class="offline-banner hidden">离线模式 · 已加载沿线底图</div>
    <div id="toast" class="toast hidden" role="status"></div>
    <div id="station-popup" class="station-popup hidden">
      <button class="popup-close" aria-label="关闭">&times;</button>
      <h3 class="popup-title"></h3>
      <p class="popup-detail"></p>
    </div>
  </div>
`

const map = L.map('map', {
  zoomControl: false,
  attributionControl: false,
  maxZoom: 18,
  minZoom: 5,
}).setView([32.5, 105.5], 7)

L.control.zoom({ position: 'bottomright' }).addTo(map)

L.control.attribution({
  position: 'bottomleft',
  prefix: false
}).addTo(map).addAttribution(
  '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OSM</a> · CARTO'
)

const baseTiles = createCachedTileLayer(L, { maxZoom: 18 })
baseTiles.addTo(map)
syncOfflineZoomLimits(map, baseTiles)

const offlineBanner = document.getElementById('offline-banner')!
function setOfflineBanner(show: boolean) {
  offlineBanner.classList.toggle('hidden', !show)
}

let offlineTileWarned = false
let tileMissCount = 0
baseTiles.on('tileoffline', () => {
  tileMissCount += 1
  if (offlineTileWarned || tileMissCount < 3) return
  offlineTileWarned = true
  setOfflineBanner(true)
})
window.addEventListener('online', () => {
  offlineTileWarned = false
  tileMissCount = 0
  setOfflineBanner(false)
  syncOfflineZoomLimits(map, baseTiles)
})
window.addEventListener('offline', () => {
  syncOfflineZoomLimits(map, baseTiles)
  setOfflineBanner(true)
})
if (!isOnline()) setOfflineBanner(true)

warmCacheFromBundled(undefined).catch(() => {})

const lineStyle: L.PathOptions = {
  color: '#ffd700',
  weight: 4,
  opacity: 0.9
}

const stationIcon = L.divIcon({
  className: 'station-marker',
  iconSize: [12, 12],
  iconAnchor: [6, 6]
})

const stationIconSelected = L.divIcon({
  className: 'station-marker selected',
  iconSize: [16, 16],
  iconAnchor: [8, 8]
})

let lineLayer: L.GeoJSON | null = null
let stationMarkers: Map<string, L.Marker> = new Map()
let selectedStation: string | null = null
let stations: { name: string; lat: number; lon: number; order: number }[] = []
let corridor: CorridorStation[] = []
let lineSegs: { a: { lat: number; lon: number }; b: { lat: number; lon: number } }[] = []
let currentView: AppView = 'map'
let locateCtrl: ReturnType<typeof createLocateControl> | null = null

const scaleView = createScaleView(document.getElementById('scale-view')!)
const locationStatusCoords = document.getElementById('location-status-coords')!
const locationStatusCorridor = document.getElementById('location-status-corridor')!
const locationStatusEl = document.getElementById('location-status')!

function formatTime(): string {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
}

function updateLocationStatus(proj: LineProjection | null, pos: LocatePosition | null) {
  if (!pos) {
    locationStatusCoords.textContent = '未定位'
    locationStatusCorridor.textContent = ''
    locationStatusEl.classList.remove('has-location', 'off-corridor')
    return
  }
  
  const timestamp = formatTime()
  locationStatusCoords.textContent = `${pos.lat.toFixed(5)}°N, ${pos.lng.toFixed(5)}°E · ${timestamp}`
  locationStatusEl.classList.add('has-location')
  
  if (!proj) {
    locationStatusCorridor.textContent = '(偏离线路)'
    locationStatusEl.classList.add('off-corridor')
  } else {
    locationStatusEl.classList.remove('off-corridor')
    if (proj.atStation) {
      locationStatusCorridor.textContent = `你在 ${proj.atStation.name} 附近`
    } else {
      locationStatusCorridor.textContent = `你在 ${proj.prev.name} ↔ ${proj.next.name} 之间`
    }
  }
}

function applyLocationToScale(pos: LocatePosition | null) {
  if (!pos || corridor.length < 2 || lineSegs.length === 0) {
    scaleView.setHasLocation(false)
    scaleView.setProjection(null)
    updateLocationStatus(null, pos)
    return
  }
  const proj = projectOntoCorridor(
    { lat: pos.lat, lon: pos.lng },
    corridor,
    lineSegs
  )
  scaleView.setHasLocation(true)
  scaleView.setProjection(proj)
  updateLocationStatus(proj, pos)
}

async function loadData() {
  try {
    const response = await fetch(resolveAssetUrl('baocheng.geojson'))
    const data: GeoJSONData = await response.json()
    
    const lineFeatures = data.features.filter(f => f.geometry.type === 'MultiLineString')
    const stationFeatures = data.features.filter(f => f.geometry.type === 'Point')
    
    lineLayer = L.geoJSON(lineFeatures as any, {
      style: lineStyle
    }).addTo(map)

    lineSegs = []
    for (const f of lineFeatures) {
      const coords = f.geometry.coordinates as [number, number][][]
      lineSegs.push(...flattenLineCoords(coords))
    }
    
    stationFeatures.forEach(feature => {
      const props = feature.properties as StationProperties
      const coords = feature.geometry.coordinates as [number, number]
      
      stations.push({
        name: props.name,
        lat: coords[1],
        lon: coords[0],
        order: props.order
      })
      
      const marker = L.marker([coords[1], coords[0]], {
        icon: stationIcon
      }).addTo(map)
      
      marker.on('click', () => selectStation(props.name))
      stationMarkers.set(props.name, marker)
    })
    
    stations.sort((a, b) => a.order - b.order)
    corridor = buildCorridor(stations)
    scaleView.setCorridor(corridor)
    
    fitToLine()
    
    handleDeepLink()

    if (locateCtrl) {
      applyLocationToScale(locateCtrl.getLastPosition())
    }
  } catch (error) {
    console.error('加载数据失败:', error)
  }
}

function fitToLine() {
  if (lineLayer) {
    const bounds = lineLayer.getBounds()
    map.fitBounds(bounds, { padding: [20, 20] })
  }
}

function selectStation(name: string) {
  if (currentView !== 'map') {
    setView('map')
  }

  if (selectedStation) {
    const prevMarker = stationMarkers.get(selectedStation)
    if (prevMarker) {
      prevMarker.setIcon(stationIcon)
    }
  }
  
  selectedStation = name
  const marker = stationMarkers.get(name)
  if (marker) {
    marker.setIcon(stationIconSelected)
    const targetZoom = Math.min(12, map.getMaxZoom())
    map.setView(marker.getLatLng(), targetZoom, { animate: true })
  }
  
  const station = stations.find(s => s.name === name)
  if (station) {
    showPopup(station)
    updateURL(name)
  }
}

function showPopup(station: { name: string; lat: number; lon: number; order: number }) {
  const popup = document.getElementById('station-popup')!
  const title = popup.querySelector('.popup-title')!
  const detail = popup.querySelector('.popup-detail')!
  
  title.textContent = station.name
  const cs = corridor.find(s => s.name === station.name)
  const kmBit = cs ? ` · 沿线约 ${cs.km < 10 ? cs.km.toFixed(1) : Math.round(cs.km)} km` : ''
  detail.textContent = `宝成线第 ${station.order} 站${kmBit}`
  
  popup.classList.remove('hidden')
}

function hidePopup() {
  const popup = document.getElementById('station-popup')!
  popup.classList.add('hidden')
  
  if (selectedStation) {
    const marker = stationMarkers.get(selectedStation)
    if (marker) {
      marker.setIcon(stationIcon)
    }
    selectedStation = null
  }
}

function updateURL(stationName: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('q', stationName)
  window.history.replaceState({}, '', url.toString())
}

function handleDeepLink() {
  const url = new URL(window.location.href)
  const query = url.searchParams.get('q') || url.hash.slice(1)
  
  if (query) {
    const decoded = decodeURIComponent(query)
    const station = stations.find(s => 
      s.name === decoded || 
      s.name.includes(decoded) ||
      decoded.includes(s.name)
    )
    
    if (station) {
      setTimeout(() => selectStation(station.name), 300)
    }
  }
}

function setupSearch() {
  const input = document.getElementById('search-input') as HTMLInputElement
  const results = document.getElementById('search-results')!
  
  input.addEventListener('input', () => {
    const query = input.value.trim()
    
    if (!query) {
      results.innerHTML = ''
      results.classList.remove('visible')
      return
    }
    
    const matches = stations.filter(s => 
      s.name.includes(query)
    ).slice(0, 8)
    
    if (matches.length > 0) {
      results.innerHTML = matches.map(s => 
        `<button class="search-result-item" data-name="${s.name}">${s.name}</button>`
      ).join('')
      results.classList.add('visible')
      
      results.querySelectorAll('.search-result-item').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.getAttribute('data-name')!
          selectStation(name)
          input.value = ''
          results.innerHTML = ''
          results.classList.remove('visible')
        })
      })
    } else {
      results.innerHTML = '<div class="search-no-result">未找到车站</div>'
      results.classList.add('visible')
    }
  })
  
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const firstResult = results.querySelector('.search-result-item') as HTMLButtonElement
      if (firstResult) {
        firstResult.click()
      }
    } else if (e.key === 'Escape') {
      input.value = ''
      results.innerHTML = ''
      results.classList.remove('visible')
      input.blur()
    }
  })
  
  document.addEventListener('click', (e) => {
    if (!input.contains(e.target as Node) && !results.contains(e.target as Node)) {
      results.classList.remove('visible')
    }
  })
}

let toastTimer: number | undefined
function showToast(msg: string) {
  const el = document.getElementById('toast')!
  el.textContent = msg
  el.classList.remove('hidden')
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    el.classList.add('hidden')
  }, 3200)
}

function setView(view: AppView) {
  currentView = view
  const mapBtn = document.getElementById('view-map-btn')!
  const scaleBtn = document.getElementById('view-scale-btn')!
  const fitBtn = document.getElementById('fit-line-btn')!
  const mapEl = document.getElementById('map')!
  const isMap = view === 'map'

  mapBtn.classList.toggle('active', isMap)
  scaleBtn.classList.toggle('active', !isMap)
  mapBtn.setAttribute('aria-pressed', isMap ? 'true' : 'false')
  scaleBtn.setAttribute('aria-pressed', isMap ? 'false' : 'true')

  mapEl.classList.toggle('hidden-view', !isMap)
  scaleView.setVisible(!isMap)
  fitBtn.classList.toggle('hidden', !isMap)

  if (isMap) {
    requestAnimationFrame(() => map.invalidateSize())
  } else {
    hidePopup()
  }

  document.getElementById('map-container')!.dataset.view = view
}

function setupControls() {
  document.getElementById('fit-line-btn')!.addEventListener('click', () => {
    fitToLine()
    hidePopup()
  })
  
  document.querySelector('.popup-close')!.addEventListener('click', hidePopup)

  document.getElementById('view-map-btn')!.addEventListener('click', () => setView('map'))
  document.getElementById('view-scale-btn')!.addEventListener('click', () => setView('scale'))

  const locateBtn = document.getElementById('locate-btn') as HTMLButtonElement
  const locateLabel = document.getElementById('locate-label')!
  locateCtrl = createLocateControl(map, {
    button: locateBtn,
    label: locateLabel,
    toast: showToast,
    onPosition: applyLocationToScale,
  })
  locateBtn.addEventListener('click', () => {
    locateCtrl!.toggle().catch((e) => {
      console.error('[Main] Locate toggle failed:', e)
    })
  })

  document.getElementById('scale-view')!.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.id === 'scale-locate-prompt' || t.closest('#scale-locate-prompt')) {
      locateCtrl!.toggle().catch((err) => {
        console.error('[Main] Scale locate toggle failed:', err)
      })
    }
  })
}

loadData()
setupSearch()
setupControls()
