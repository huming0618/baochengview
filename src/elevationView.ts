import type { LineProjection } from './geo.ts'

export interface ElevationStation {
  name: string
  order: number
  km: number
  lat: number
  lon: number
  elevation: number
}

export interface ElevationProfilePoint {
  km: number
  elevation: number
}

export interface ElevationProfileData {
  source: string
  generated: string
  summary: {
    totalKm: number
    minElevation: number
    maxElevation: number
    stationCount: number
    profilePoints: number
  }
  stations: ElevationStation[]
  profile: ElevationProfilePoint[]
}

export type ElevationMode = 'detailed' | 'relief'

export interface ElevationViewController {
  setData: (data: ElevationProfileData) => void
  setProjection: (proj: LineProjection | null) => void
  setHasLocation: (has: boolean) => void
  setVisible: (visible: boolean) => void
  destroy: () => void
}

function formatElevation(m: number): string {
  if (!Number.isFinite(m)) return '—'
  return `${Math.round(m)} m`
}

function formatKm(km: number): string {
  if (!Number.isFinite(km)) return '—'
  if (km < 10) return km.toFixed(1)
  return String(Math.round(km))
}

const MAX_GRADE_PERMILLE = 30

function computeSmoothedProfile(
  profile: ElevationProfilePoint[],
  windowSize: number
): ElevationProfilePoint[] {
  if (profile.length < 3) return profile

  const smoothed: ElevationProfilePoint[] = []

  for (let i = 0; i < profile.length; i++) {
    const start = Math.max(0, i - windowSize)
    const end = Math.min(profile.length - 1, i + windowSize)

    let sum = 0
    let weightSum = 0
    for (let j = start; j <= end; j++) {
      const dist = Math.abs(j - i)
      const weight = 1 / (1 + dist * 0.5)
      sum += profile[j].elevation * weight
      weightSum += weight
    }

    smoothed.push({
      km: profile[i].km,
      elevation: Math.round(sum / weightSum)
    })
  }

  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < smoothed.length; i++) {
      const prev = smoothed[i - 1]
      const curr = smoothed[i]
      const distKm = curr.km - prev.km
      if (distKm < 0.01) continue

      const elevDiff = curr.elevation - prev.elevation
      const maxChange = MAX_GRADE_PERMILLE * distKm

      if (Math.abs(elevDiff) > maxChange) {
        const direction = elevDiff > 0 ? 1 : -1
        smoothed[i].elevation = Math.round(prev.elevation + direction * maxChange * 0.95)
      }
    }
  }

  return smoothed
}

function computeStationsOnCurve(
  stations: ElevationStation[],
  profile: ElevationProfilePoint[]
): ElevationStation[] {
  return stations.map(s => {
    let prevPt: ElevationProfilePoint | null = null
    let nextPt: ElevationProfilePoint | null = null

    for (const p of profile) {
      if (p.km <= s.km) prevPt = p
      if (p.km >= s.km && !nextPt) nextPt = p
    }

    let elevation: number
    if (prevPt && nextPt && prevPt !== nextPt) {
      const t = (s.km - prevPt.km) / (nextPt.km - prevPt.km)
      elevation = Math.round(prevPt.elevation + t * (nextPt.elevation - prevPt.elevation))
    } else if (prevPt) {
      elevation = prevPt.elevation
    } else if (nextPt) {
      elevation = nextPt.elevation
    } else {
      elevation = s.elevation
    }

    return { ...s, elevation }
  })
}

export function createElevationView(root: HTMLElement): ElevationViewController {
  let data: ElevationProfileData | null = null
  let projection: LineProjection | null = null
  let hasLocation = false
  let visible = false
  let mode: ElevationMode = 'detailed'
  let smoothedProfile: ElevationProfilePoint[] = []
  let smoothedStations: ElevationStation[] = []
  let isLandscape = false

  root.innerHTML = `
    <div class="elev-shell">
      <div class="elev-header">
        <div class="elev-status" id="elev-status"></div>
        <div class="elev-mode-toggle" id="elev-mode-toggle">
          <button type="button" class="elev-mode-btn active" data-mode="detailed">海拔</button>
          <button type="button" class="elev-mode-btn" data-mode="relief">起伏</button>
        </div>
      </div>
      <div class="elev-chart-area">
        <div class="elev-chart-container" id="elev-chart-container">
          <div class="elev-chart" id="elev-chart">
            <canvas id="elev-canvas"></canvas>
            <div class="elev-me hidden" id="elev-me" title="我">
              <span class="elev-me-dot"></span>
              <span class="elev-me-label">我</span>
            </div>
            <span class="elev-end-label elev-end-from">宝鸡</span>
            <span class="elev-end-label elev-end-to">成都</span>
          </div>
          <div class="elev-axis-y" id="elev-axis-y"></div>
        </div>
        <div class="elev-axis-x" id="elev-axis-x"></div>
      </div>
      <div class="elev-footer">
        <span class="elev-end-mid" id="elev-mode-label">宝成线 · 海拔剖面</span>
      </div>
    </div>
  `

  const statusEl = root.querySelector('#elev-status') as HTMLElement
  const chartEl = root.querySelector('#elev-chart') as HTMLElement
  const canvas = root.querySelector('#elev-canvas') as HTMLCanvasElement
  const meEl = root.querySelector('#elev-me') as HTMLElement
  const axisY = root.querySelector('#elev-axis-y') as HTMLElement
  const axisX = root.querySelector('#elev-axis-x') as HTMLElement
  const modeToggle = root.querySelector('#elev-mode-toggle') as HTMLElement
  const modeLabel = root.querySelector('#elev-mode-label') as HTMLElement

  function checkLandscape() {
    const wasLandscape = isLandscape
    isLandscape = window.innerWidth > window.innerHeight
    if (wasLandscape !== isLandscape) {
      root.classList.toggle('elev-landscape', isLandscape)
      if (visible) render()
    }
  }

  function getActiveProfile(): ElevationProfilePoint[] {
    if (!data) return []
    return mode === 'relief' ? smoothedProfile : data.profile
  }

  function getActiveStations(): ElevationStation[] {
    if (!data) return []
    return mode === 'relief' ? smoothedStations : data.stations
  }

  function getElevRange() {
    const profile = getActiveProfile()
    if (profile.length === 0) return { min: 0, max: 1000 }
    const elevs = profile.map(p => p.elevation)
    return { min: Math.min(...elevs), max: Math.max(...elevs) }
  }

  function getChartDimensions() {
    const rect = chartEl.getBoundingClientRect()
    return {
      width: rect.width || 300,
      height: rect.height || 200
    }
  }

  function frac(km: number): number {
    if (!data) return 0
    return Math.max(0, Math.min(1, km / data.summary.totalKm))
  }

  function elevFrac(elev: number): number {
    const { min, max } = getElevRange()
    const range = max - min
    if (range <= 0) return 0.5
    return (elev - min) / range
  }

  function renderChart() {
    if (!data || !visible) return

    const { width, height } = getChartDimensions()
    const dpr = window.devicePixelRatio || 1

    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    const padLeft = 8
    const padRight = 8
    const padTop = 16
    const padBottom = 16
    const chartW = width - padLeft - padRight
    const chartH = height - padTop - padBottom

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.lineWidth = 1
    const gridLines = 4
    for (let i = 0; i <= gridLines; i++) {
      const y = padTop + (i / gridLines) * chartH
      ctx.beginPath()
      ctx.moveTo(padLeft, y)
      ctx.lineTo(padLeft + chartW, y)
      ctx.stroke()
    }

    if (projection && hasLocation) {
      const x0 = padLeft + frac(projection.prev.km) * chartW
      const x1 = padLeft + frac(projection.next.km) * chartW
      ctx.fillStyle = 'rgba(42, 147, 238, 0.2)'
      ctx.fillRect(x0, padTop, x1 - x0, chartH)
    }

    const profile = getActiveProfile()
    const lineColor = mode === 'relief' ? '#4ade80' : '#ffd700'
    const fillColorTop = mode === 'relief' ? 'rgba(74, 222, 128, 0.3)' : 'rgba(255, 215, 0, 0.3)'
    const fillColorBottom = mode === 'relief' ? 'rgba(74, 222, 128, 0.05)' : 'rgba(255, 215, 0, 0.05)'

    ctx.beginPath()
    ctx.strokeStyle = lineColor
    ctx.lineWidth = mode === 'relief' ? 3 : 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (let i = 0; i < profile.length; i++) {
      const x = padLeft + frac(profile[i].km) * chartW
      const y = padTop + (1 - elevFrac(profile[i].elevation)) * chartH
      if (i === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }
    ctx.stroke()

    const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + chartH)
    gradient.addColorStop(0, fillColorTop)
    gradient.addColorStop(1, fillColorBottom)

    ctx.beginPath()
    for (let i = 0; i < profile.length; i++) {
      const x = padLeft + frac(profile[i].km) * chartW
      const y = padTop + (1 - elevFrac(profile[i].elevation)) * chartH
      if (i === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }
    ctx.lineTo(padLeft + chartW, padTop + chartH)
    ctx.lineTo(padLeft, padTop + chartH)
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()

    const stations = getActiveStations()
    ctx.fillStyle = '#fff'
    for (const station of stations) {
      const x = padLeft + frac(station.km) * chartW
      const y = padTop + (1 - elevFrac(station.elevation)) * chartH
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  function renderAxes() {
    if (!data) return

    const { min: minE, max: maxE } = getElevRange()
    const range = maxE - minE

    const yTicks: number[] = []
    const step = range > 800 ? 400 : range > 400 ? 200 : 100
    const start = Math.ceil(minE / step) * step
    for (let e = start; e <= maxE; e += step) {
      yTicks.push(e)
    }

    axisY.innerHTML = yTicks.map(e => {
      const pct = (1 - elevFrac(e)) * 100
      return `<span class="elev-tick-y" style="top:${pct.toFixed(1)}%">${e} m</span>`
    }).join('')

    const xTicks: number[] = []
    const totalKm = data.summary.totalKm
    const kmStep = isLandscape ? 50 : (totalKm > 400 ? 100 : totalKm > 200 ? 50 : 25)
    for (let km = 0; km <= totalKm; km += kmStep) {
      xTicks.push(km)
    }

    axisX.innerHTML = xTicks.map(km => {
      const pct = frac(km) * 100
      return `<span class="elev-tick-x" style="left:${pct.toFixed(1)}%">${km} km</span>`
    }).join('')
  }

  function updateStatus() {
    if (!data) {
      statusEl.innerHTML = '<div class="elev-loading">加载海拔数据...</div>'
      meEl.classList.add('hidden')
      return
    }

    if (!hasLocation || !projection) {
      statusEl.innerHTML = `
        <button type="button" class="elev-locate-prompt" id="elev-locate-prompt">点击定位，显示你在剖面上的位置</button>
      `
      meEl.classList.add('hidden')
      return
    }

    const elevAtUser = interpolateElevation(projection.kmAlong)

    if (projection.atStation) {
      statusEl.innerHTML = `
        <div class="elev-status-main">你在 <strong>${projection.atStation.name}</strong> 附近</div>
        <div class="elev-status-sub">沿线 ${formatKm(projection.kmAlong)} km · 海拔约 ${formatElevation(elevAtUser)}</div>
      `
    } else {
      statusEl.innerHTML = `
        <div class="elev-status-main">你在 <strong>${projection.prev.name}</strong> ↔ <strong>${projection.next.name}</strong> 之间</div>
        <div class="elev-status-sub">沿线 ${formatKm(projection.kmAlong)} km · 海拔约 ${formatElevation(elevAtUser)} · 距线 ${Math.round(projection.distM)} m</div>
      `
    }

    const { width, height } = getChartDimensions()
    const padLeft = 8, padRight = 8, padTop = 16, padBottom = 16
    const chartW = width - padLeft - padRight
    const chartH = height - padTop - padBottom

    const x = padLeft + frac(projection.kmAlong) * chartW
    const y = padTop + (1 - elevFrac(elevAtUser)) * chartH

    meEl.classList.remove('hidden')
    meEl.style.left = `${x}px`
    meEl.style.top = `${y}px`
  }

  function interpolateElevation(km: number): number {
    const profile = getActiveProfile()
    if (profile.length === 0) return 0

    if (km <= profile[0].km) return profile[0].elevation
    if (km >= profile[profile.length - 1].km) return profile[profile.length - 1].elevation

    for (let i = 0; i < profile.length - 1; i++) {
      if (km >= profile[i].km && km <= profile[i + 1].km) {
        const t = (km - profile[i].km) / (profile[i + 1].km - profile[i].km)
        return profile[i].elevation + t * (profile[i + 1].elevation - profile[i].elevation)
      }
    }

    return profile[profile.length - 1].elevation
  }

  function updateModeLabel() {
    modeLabel.textContent = mode === 'relief' ? '宝成线 · 起伏概览' : '宝成线 · 海拔剖面'
  }

  function setMode(newMode: ElevationMode) {
    if (mode === newMode) return
    mode = newMode

    modeToggle.querySelectorAll('.elev-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode)
    })

    root.setAttribute('data-mode', mode)
    updateModeLabel()
    render()
  }

  function render() {
    checkLandscape()
    renderChart()
    renderAxes()
    updateStatus()
  }

  modeToggle.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.elev-mode-btn')
    if (btn) {
      const newMode = btn.getAttribute('data-mode') as ElevationMode
      if (newMode) setMode(newMode)
    }
  })

  let resizeTimeout: number | undefined
  const onResize = () => {
    if (resizeTimeout) window.clearTimeout(resizeTimeout)
    resizeTimeout = window.setTimeout(() => {
      checkLandscape()
      if (visible) render()
    }, 100)
  }
  window.addEventListener('resize', onResize)

  const orientationHandler = () => {
    checkLandscape()
    if (visible) render()
  }
  window.addEventListener('orientationchange', orientationHandler)

  checkLandscape()

  return {
    setData(d: ElevationProfileData) {
      data = d
      smoothedProfile = computeSmoothedProfile(d.profile, 8)
      smoothedStations = computeStationsOnCurve(d.stations, smoothedProfile)
      render()
    },
    setProjection(proj: LineProjection | null) {
      projection = proj
      renderChart()
      updateStatus()
    },
    setHasLocation(has: boolean) {
      hasLocation = has
      updateStatus()
    },
    setVisible(v: boolean) {
      visible = v
      root.classList.toggle('hidden', !v)
      if (v) {
        checkLandscape()
        requestAnimationFrame(() => render())
      }
    },
    destroy() {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', orientationHandler)
      root.innerHTML = ''
    }
  }
}
