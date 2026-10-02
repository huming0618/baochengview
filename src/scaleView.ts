import type { CorridorStation, LineProjection } from './geo.ts'

export type ScaleOrientation = 'vertical' | 'horizontal'

export interface ScaleViewController {
  setCorridor: (stations: CorridorStation[]) => void
  setProjection: (proj: LineProjection | null) => void
  setHasLocation: (has: boolean) => void
  setVisible: (visible: boolean) => void
  getOrientation: () => ScaleOrientation
  destroy: () => void
}

function formatKm(km: number): string {
  if (!Number.isFinite(km)) return '—'
  if (km < 10) return km.toFixed(1)
  return String(Math.round(km))
}

/**
 * Linear scale/ruler of Baocheng stations. Positions ticks by corridor km.
 * Marks 「我」 from a polyline projection and highlights the X↔Y segment.
 */
export function createScaleView(root: HTMLElement): ScaleViewController {
  let corridor: CorridorStation[] = []
  let projection: LineProjection | null = null
  let hasLocation = false
  let visible = false
  let orientation: ScaleOrientation =
    window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches
      ? 'horizontal'
      : 'vertical'

  root.innerHTML = `
    <div class="scale-shell">
      <div class="scale-status" id="scale-status"></div>
      <div class="scale-scroll" id="scale-scroll">
        <div class="scale-track" id="scale-track">
          <div class="scale-plot" id="scale-plot">
            <div class="scale-rail" aria-hidden="true"></div>
            <div class="scale-highlight hidden" id="scale-highlight"></div>
            <div class="scale-ticks" id="scale-ticks"></div>
            <div class="scale-me hidden" id="scale-me" title="我">
              <span class="scale-me-dot"></span>
              <span class="scale-me-label">我</span>
            </div>
          </div>
        </div>
      </div>
      <div class="scale-ends">
        <span class="scale-end-from">宝鸡</span>
        <span class="scale-end-mid">宝成线 · 站序刻度</span>
        <span class="scale-end-to">成都</span>
      </div>
    </div>
  `

  const statusEl = root.querySelector('#scale-status') as HTMLElement
  const scrollEl = root.querySelector('#scale-scroll') as HTMLElement
  const trackEl = root.querySelector('#scale-track') as HTMLElement
  const ticksEl = root.querySelector('#scale-ticks') as HTMLElement
  const highlightEl = root.querySelector('#scale-highlight') as HTMLElement
  const meEl = root.querySelector('#scale-me') as HTMLElement

  function totalKm(): number {
    if (corridor.length === 0) return 1
    return Math.max(corridor[corridor.length - 1].km, 1e-3)
  }

  /** Fraction 0..1 along scale (宝鸡=0 → 成都=1). */
  function frac(km: number): number {
    return Math.max(0, Math.min(1, km / totalKm()))
  }

  function applyOrientation() {
    root.classList.toggle('scale-horizontal', orientation === 'horizontal')
    root.classList.toggle('scale-vertical', orientation === 'vertical')
  }

  function sizeTrack() {
    if (orientation === 'vertical') {
      const minH = Math.max(corridor.length * 44 + 48, scrollEl.clientHeight || 400)
      trackEl.style.height = `${minH}px`
      trackEl.style.width = ''
    } else {
      const minW = Math.max(corridor.length * 72 + 64, scrollEl.clientWidth || 600)
      trackEl.style.width = `${minW}px`
      trackEl.style.height = ''
    }
  }

  function renderTicks() {
    sizeTrack()
    ticksEl.innerHTML = corridor
      .map((s) => {
        const f = frac(s.km)
        const isEndpoint = s === corridor[0] || s === corridor[corridor.length - 1]
        const inSeg =
          !!projection &&
          !projection.atStation &&
          (s.name === projection.prev.name || s.name === projection.next.name)
        const atMe = projection?.atStation?.name === s.name
        const cls = [
          'scale-tick',
          isEndpoint ? 'endpoint' : '',
          inSeg ? 'seg-end' : '',
          atMe ? 'at-me' : '',
        ]
          .filter(Boolean)
          .join(' ')
        const style =
          orientation === 'vertical'
            ? `top:${(f * 100).toFixed(3)}%`
            : `left:${(f * 100).toFixed(3)}%`
        return `<div class="${cls}" style="${style}" data-name="${s.name}" data-km="${s.km.toFixed(1)}">
          <span class="scale-tick-mark"></span>
          <span class="scale-tick-name">${s.name}</span>
          <span class="scale-tick-km">${formatKm(s.km)} km</span>
        </div>`
      })
      .join('')
  }

  function updateStatus() {
    if (!hasLocation || !projection) {
      statusEl.innerHTML =
        `<button type="button" class="scale-locate-prompt" id="scale-locate-prompt">点击定位，显示你在哪两站之间</button>`
      highlightEl.classList.add('hidden')
      meEl.classList.add('hidden')
      return
    }

    const p = projection
    if (p.atStation) {
      statusEl.innerHTML = `<div class="scale-status-main">你在 <strong>${p.atStation.name}</strong> 附近</div>
        <div class="scale-status-sub">沿线约 ${formatKm(p.kmAlong)} km（宝鸡→成都）</div>`
    } else {
      statusEl.innerHTML = `<div class="scale-status-main">你在 <strong>${p.prev.name}</strong> ↔ <strong>${p.next.name}</strong> 之间</div>
        <div class="scale-status-sub">沿线约 ${formatKm(p.kmAlong)} km · 距线 ${Math.round(p.distM)} m</div>`
    }

    const f0 = frac(p.prev.km)
    const f1 = frac(p.next.km)
    highlightEl.classList.remove('hidden')
    if (orientation === 'vertical') {
      highlightEl.style.top = `${(f0 * 100).toFixed(3)}%`
      highlightEl.style.height = `${((f1 - f0) * 100).toFixed(3)}%`
      highlightEl.style.left = ''
      highlightEl.style.width = ''
    } else {
      highlightEl.style.left = `${(f0 * 100).toFixed(3)}%`
      highlightEl.style.width = `${((f1 - f0) * 100).toFixed(3)}%`
      highlightEl.style.top = ''
      highlightEl.style.height = ''
    }

    const fm = frac(p.kmAlong)
    meEl.classList.remove('hidden')
    if (orientation === 'vertical') {
      meEl.style.top = `${(fm * 100).toFixed(3)}%`
      meEl.style.left = ''
    } else {
      meEl.style.left = `${(fm * 100).toFixed(3)}%`
      meEl.style.top = ''
    }

    if (visible) {
      requestAnimationFrame(() => {
        meEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
      })
    }
  }

  function render() {
    applyOrientation()
    renderTicks()
    updateStatus()
  }

  const onResize = () => {
    const next: ScaleOrientation =
      window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches
        ? 'horizontal'
        : 'vertical'
    if (next !== orientation) {
      orientation = next
      render()
    } else if (visible) {
      renderTicks()
      updateStatus()
    }
  }
  window.addEventListener('resize', onResize)

  applyOrientation()

  return {
    setCorridor(stations) {
      corridor = stations
      render()
    },
    setProjection(proj) {
      projection = proj
      renderTicks()
      updateStatus()
    },
    setHasLocation(has) {
      hasLocation = has
      updateStatus()
    },
    setVisible(v) {
      visible = v
      root.classList.toggle('hidden', !v)
      if (v) render()
    },
    getOrientation: () => orientation,
    destroy() {
      window.removeEventListener('resize', onResize)
      root.innerHTML = ''
    },
  }
}
