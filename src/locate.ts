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

const LOCATE_TIMEOUT_MS = 12000

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
  if (err && 'code' in err && err.code === 2) return '定位服务不可用'
  if (err && 'code' in err && err.code === 3) return '定位超时'
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
  let locateTimeoutId: ReturnType<typeof setTimeout> | null = null
  let abortLocating = false

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
      opts.button.title = '点击取消定位'
    } else if (next === 'following') {
      opts.label.textContent = '跟随中'
      opts.button.title = '点击停止跟随'
    } else {
      opts.label.textContent = '跟随我'
      opts.button.title = '点击跟随我的位置'
    }
  }

  function clearLocateTimeout() {
    if (locateTimeoutId !== null) {
      clearTimeout(locateTimeoutId)
      locateTimeoutId = null
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

  function onInitialPosition(lat: number, lng: number, accuracy: number) {
    clearLocateTimeout()
    if (abortLocating || state !== 'locating') {
      console.log('[Locate] Position received but locate was cancelled')
      return
    }
    updateMarker(lat, lng, accuracy)
    follow = true
    setState('following')
    centerOnUser()
    startWatchForFollow()
  }

  function onWatchPosition(lat: number, lng: number, accuracy: number) {
    // Always update marker and emit position (for status strip) regardless of follow mode
    updateMarker(lat, lng, accuracy)
    
    // Only auto-pan if actively following
    if (follow && state === 'following') {
      programmaticMove = true
      map.panTo(lastLatLng!, { animate: true })
      map.once('moveend', () => {
        programmaticMove = false
      })
    }
  }

  function onError(err: GeolocationPositionError | Error | null, isTimeout = false) {
    clearLocateTimeout()
    const msg = isTimeout ? '定位超时，请检查系统定位是否开启' : permissionDeniedMessage(err)
    opts.toast(msg)
    if (state === 'locating') {
      stopWatch()
      setState('idle')
    }
  }

  async function getInitialPosition(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
    if (Capacitor.isNativePlatform()) {
      try {
        const pos = await Geolocation.getCurrentPosition({
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: 0,
        })
        return {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? 0,
        }
      } catch (e) {
        console.log('[Locate] Low-accuracy getCurrentPosition failed, trying high accuracy:', e)
      }
      try {
        const pos = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        })
        return {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? 0,
        }
      } catch (e) {
        console.error('[Locate] High-accuracy getCurrentPosition also failed:', e)
        throw e
      }
    } else {
      return new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? 0,
          }),
          (err) => reject(err),
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 0 }
        )
      })
    }
  }

  function startWatchForFollow() {
    if (watchId !== null) return
    
    console.log('[Locate] Starting watch for continuous updates')
    try {
      if (Capacitor.isNativePlatform()) {
        Geolocation.watchPosition(
          { enableHighAccuracy: true, timeout: 30000, minimumUpdateInterval: 1000 },
          (position, err) => {
            if (err || !position) {
              console.warn('[Locate] Watch error:', err)
              return
            }
            console.log('[Locate] Watch update:', position.coords.latitude, position.coords.longitude)
            onWatchPosition(
              position.coords.latitude,
              position.coords.longitude,
              position.coords.accuracy ?? 0
            )
          }
        ).then((id) => {
          watchId = id
          console.log('[Locate] Watch started with id:', id)
        }).catch((e) => {
          console.warn('[Locate] Failed to start watch:', e)
        })
      } else {
        watchId = navigator.geolocation.watchPosition(
          (position) => {
            console.log('[Locate] Watch update:', position.coords.latitude, position.coords.longitude)
            onWatchPosition(
              position.coords.latitude,
              position.coords.longitude,
              position.coords.accuracy ?? 0
            )
          },
          (err) => console.warn('[Locate] Watch error:', err),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
        )
        console.log('[Locate] Browser watch started with id:', watchId)
      }
    } catch (e) {
      console.warn('[Locate] startWatchForFollow failed:', e)
    }
  }

  async function startLocate() {
    abortLocating = false
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

    if (abortLocating) {
      console.log('[Locate] Locate aborted after permission check')
      setState('idle')
      return
    }

    locateTimeoutId = setTimeout(() => {
      if (state === 'locating') {
        console.warn('[Locate] Client-side timeout reached')
        onError(null, true)
      }
    }, LOCATE_TIMEOUT_MS)

    try {
      const pos = await getInitialPosition()
      if (pos && !abortLocating) {
        onInitialPosition(pos.lat, pos.lng, pos.accuracy)
      }
    } catch (e) {
      if (!abortLocating) {
        console.error('[Locate] getInitialPosition failed:', e)
        onError(e instanceof Error ? e : null)
      }
    }
  }

  function stopWatch() {
    clearLocateTimeout()
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

  function cancelLocate() {
    console.log('[Locate] User cancelled locating')
    abortLocating = true
    clearLocateTimeout()
    stopWatch()
    setState('idle')
    opts.toast('已取消定位')
  }

  function stop() {
    abortLocating = true
    stopWatch()
    clearMarkers()
    setState('idle')
  }

  async function toggle() {
    try {
      if (state === 'idle') {
        await startLocate()
        return
      }
      if (state === 'locating') {
        cancelLocate()
        return
      }
      if (state === 'following') {
        follow = false
        setState('located')
        return
      }
      follow = true
      setState('following')
      centerOnUser()
      if (watchId === null) {
        startWatchForFollow()
      }
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
