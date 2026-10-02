import L from 'leaflet'
import { Capacitor } from '@capacitor/core'
import { Geolocation, type PermissionStatus } from '@capacitor/geolocation'

export type LocateState = 'idle' | 'locating' | 'following' | 'located'

export interface LocatePosition {
  lat: number
  lng: number
  accuracy: number
}

export interface LocateController {
  getState: () => LocateState
  getLastPosition: () => LocatePosition | null
  toggle: () => Promise<void>
  stop: () => void
  destroy: () => void
}

function isPermissionGranted(status: PermissionStatus): boolean {
  return status.location === 'granted' || status.coarseLocation === 'granted'
}

async function ensurePermission(): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      let status = await Geolocation.checkPermissions()
      if (!isPermissionGranted(status)) {
        status = await Geolocation.requestPermissions()
      }
      return isPermissionGranted(status)
    }
    // Browser: prompt happens on first getCurrentPosition / watchPosition
    if (!('geolocation' in navigator)) return false
    return true
  } catch (e) {
    console.error('[Locate] Permission check/request failed:', e)
    throw e
  }
}

function permissionDeniedMessage(err?: GeolocationPositionError | Error | null): string {
  if (err && 'code' in err && err.code === 1) return '请允许位置权限后重试'
  if (err && err.message && /denied|permission/i.test(err.message)) return '请允许位置权限后重试'
  return '无法获取位置'
}

export function createLocateControl(
  map: L.Map,
  opts: {
    button: HTMLButtonElement
    label: HTMLElement
    toast: (msg: string) => void
    onPosition?: (pos: LocatePosition | null) => void
  }
): LocateController {
  let state: LocateState = 'idle'
  let watchId: string | number | null = null
  let marker: L.Marker | null = null
  let accuracyCircle: L.Circle | null = null
  let follow = false
  let programmaticMove = false
  let lastLatLng: L.LatLng | null = null
  let lastAccuracy = 0

  const userIcon = L.divIcon({
    className: 'user-location-marker',
    html: '<div class="user-location-dot"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })

  function emitPosition() {
    if (!opts.onPosition) return
    if (!lastLatLng) {
      opts.onPosition(null)
      return
    }
    opts.onPosition({
      lat: lastLatLng.lat,
      lng: lastLatLng.lng,
      accuracy: lastAccuracy,
    })
  }

  function setState(next: LocateState) {
    state = next
    opts.button.classList.toggle('active', next === 'following')
    opts.button.classList.toggle('located', next === 'located' || next === 'following')
    opts.button.setAttribute('aria-pressed', next === 'following' ? 'true' : 'false')
    if (next === 'idle') {
      opts.label.textContent = '定位'
      opts.button.title = '定位 / 跟随我'
    } else if (next === 'locating') {
      opts.label.textContent = '定位中'
      opts.button.title = '正在定位…'
    } else if (next === 'following') {
      opts.label.textContent = '跟随中'
      opts.button.title = '点击停止跟随'
    } else {
      opts.label.textContent = '跟随我'
      opts.button.title = '点击跟随我的位置'
    }
  }

  function updateMarker(lat: number, lng: number, accuracy: number) {
    const latlng = L.latLng(lat, lng)
    lastLatLng = latlng
    lastAccuracy = accuracy
    if (!marker) {
      marker = L.marker(latlng, { icon: userIcon, zIndexOffset: 1000, interactive: false }).addTo(map)
    } else {
      marker.setLatLng(latlng)
    }
    if (!accuracyCircle) {
      accuracyCircle = L.circle(latlng, {
        radius: Math.max(accuracy || 0, 8),
        color: '#2A93EE',
        weight: 1,
        opacity: 0.6,
        fillColor: '#2A93EE',
        fillOpacity: 0.15,
        interactive: false,
      }).addTo(map)
    } else {
      accuracyCircle.setLatLng(latlng)
      accuracyCircle.setRadius(Math.max(accuracy || 0, 8))
    }
    emitPosition()
  }

  function centerOnUser(zoom?: number) {
    if (!lastLatLng) return
    programmaticMove = true
    const z = zoom ?? Math.max(map.getZoom(), Math.min(14, map.getMaxZoom()))
    map.setView(lastLatLng, z, { animate: true })
    map.once('moveend', () => {
      programmaticMove = false
    })
  }

  function onPosition(lat: number, lng: number, accuracy: number) {
    updateMarker(lat, lng, accuracy)
    if (state === 'locating') {
      follow = true
      setState('following')
      centerOnUser()
    } else if (follow) {
      programmaticMove = true
      map.panTo(lastLatLng!, { animate: true })
      map.once('moveend', () => {
        programmaticMove = false
      })
    } else if (state === 'idle') {
      setState('located')
    }
  }

  function onError(err: GeolocationPositionError | Error | null) {
    opts.toast(permissionDeniedMessage(err))
    if (state === 'locating') {
      stopWatch()
      setState('idle')
    }
  }

  async function startWatch() {
    setState('locating')
    
    let ok = false
    try {
      ok = await ensurePermission()
    } catch (e) {
      console.error('[Locate] ensurePermission failed:', e)
      opts.toast('定位权限检查失败')
      setState('idle')
      return
    }
    
    if (!ok) {
      opts.toast('请允许位置权限后重试')
      setState('idle')
      return
    }

    try {
      if (Capacitor.isNativePlatform()) {
        watchId = await Geolocation.watchPosition(
          { enableHighAccuracy: true, timeout: 20000 },
          (position, err) => {
            if (err || !position) {
              onError(err ?? null)
              return
            }
            onPosition(
              position.coords.latitude,
              position.coords.longitude,
              position.coords.accuracy ?? 0
            )
          }
        )
      } else {
        watchId = navigator.geolocation.watchPosition(
          (position) => {
            onPosition(
              position.coords.latitude,
              position.coords.longitude,
              position.coords.accuracy ?? 0
            )
          },
          (err) => onError(err),
          { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
        )
      }
    } catch (e) {
      console.error('[Locate] watchPosition failed:', e)
      onError(e instanceof Error ? e : null)
    }
  }

  function stopWatch() {
    if (watchId != null) {
      if (Capacitor.isNativePlatform() && typeof watchId === 'string') {
        Geolocation.clearWatch({ id: watchId }).catch(() => {})
      } else if (typeof watchId === 'number') {
        navigator.geolocation.clearWatch(watchId)
      }
      watchId = null
    }
    follow = false
  }

  function clearMarkers() {
    if (marker) {
      map.removeLayer(marker)
      marker = null
    }
    if (accuracyCircle) {
      map.removeLayer(accuracyCircle)
      accuracyCircle = null
    }
    lastLatLng = null
    lastAccuracy = 0
    emitPosition()
  }

  function stop() {
    stopWatch()
    clearMarkers()
    setState('idle')
  }

  async function toggle() {
    try {
      if (state === 'idle') {
        await startWatch()
        return
      }
      if (state === 'locating') {
        // ignore double-taps while locating
        return
      }
      if (state === 'following') {
        follow = false
        setState('located')
        return
      }
      // located → resume follow
      follow = true
      setState('following')
      centerOnUser()
    } catch (e) {
      console.error('[Locate] toggle error:', e)
      opts.toast('定位功能出错')
      setState('idle')
    }
  }

  const onUserMove = () => {
    if (programmaticMove) return
    if (follow && state === 'following') {
      follow = false
      setState('located')
    }
  }
  map.on('dragstart', onUserMove)

  setState('idle')

  return {
    getState: () => state,
    getLastPosition: () =>
      lastLatLng
        ? { lat: lastLatLng.lat, lng: lastLatLng.lng, accuracy: lastAccuracy }
        : null,
    toggle,
    stop,
    destroy: () => {
      map.off('dragstart', onUserMove)
      stop()
    },
  }
}
