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

export function createElevationView(root: HTMLElement): ElevationViewController {
  let data: ElevationProfileData | null = null
  let projection: LineProjection | null = null
  let hasLocation = false
  let visible = false

  root.innerHTML = `
    <div class="elev-shell">
      <div class="elev-status" id="elev-status"></div>
      <div class="elev-chart-container" id="elev-chart-container">
        <div class="elev-chart" id="elev-chart">
          <canvas id="elev-canvas"></canvas>
          <div class="elev-me hidden" id="elev-me" title="我">
            <span class="elev-me-dot"></span>
            <span class="elev-me-label">我</span>
          </div>
        </div>
        <div class="elev-axis-y" id="elev-axis-y"></div>
      </div>
      <div class="elev-axis-x" id="elev-axis-x"></div>
      <div class="elev-ends">
        <span class="elev-end-from">宝鸡</span>
        <span class="elev-end-mid">宝成线 · 海拔剖面</span>
        <span class="elev-end-to">成都</span>
      </div>
    </div>
  `

  const statusEl = root.querySelector('#elev-status') as HTMLElement
  const chartEl = root.querySelector('#elev-chart') as HTMLElement
  const canvas = root.querySelector('#elev-canvas') as HTMLCanvasElement
  const meEl = root.querySelector('#elev-me') as HTMLElement
  const axisY = root.querySelector('#elev-axis-y') as HTMLElement
  const axisX = root.querySelector('#elev-axis-x') as HTMLElement

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
    if (!data) return 0
    const range = data.summary.maxElevation - data.summary.minElevation
    if (range <= 0) return 0.5
    return (elev - data.summary.minElevation) / range
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

    ctx.beginPath()
    ctx.strokeStyle = '#ffd700'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const profile = data.profile
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
    gradient.addColorStop(0, 'rgba(255, 215, 0, 0.3)')
    gradient.addColorStop(1, 'rgba(255, 215, 0, 0.05)')

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

    ctx.fillStyle = '#fff'
    for (const station of data.stations) {
      const x = padLeft + frac(station.km) * chartW
      const y = padTop + (1 - elevFrac(station.elevation)) * chartH
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  function renderAxes() {
    if (!data) return

    const minE = data.summary.minElevation
    const maxE = data.summary.maxElevation
    const range = maxE - minE

    const yTicks = []
    const step = range > 800 ? 400 : range > 400 ? 200 : 100
    const start = Math.ceil(minE / step) * step
    for (let e = start; e <= maxE; e += step) {
      yTicks.push(e)
    }

    axisY.innerHTML = yTicks.map(e => {
      const pct = (1 - elevFrac(e)) * 100
      return `<span class="elev-tick-y" style="top:${pct.toFixed(1)}%">${e} m</span>`
    }).join('')

    const xTicks = []
    const totalKm = data.summary.totalKm
    const kmStep = totalKm > 400 ? 100 : totalKm > 200 ? 50 : 25
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
        <button type="button" class="elev-locate-prompt" id="elev-locate-prompt">点击定位，显示你在海拔剖面上的位置</button>
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
    if (!data || data.profile.length === 0) return 0
    const profile = data.profile

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

  function render() {
    renderChart()
    renderAxes()
    updateStatus()
  }

  let resizeTimeout: number | undefined
  const onResize = () => {
    if (resizeTimeout) window.clearTimeout(resizeTimeout)
    resizeTimeout = window.setTimeout(() => {
      if (visible) render()
    }, 100)
  }
  window.addEventListener('resize', onResize)

  return {
    setData(d: ElevationProfileData) {
      data = d
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
        requestAnimationFrame(() => render())
      }
    },
    destroy() {
      window.removeEventListener('resize', onResize)
      root.innerHTML = ''
    }
  }
}
