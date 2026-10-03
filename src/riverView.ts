import type { LineProjection } from './geo.ts'

export interface River {
  name: string
  km: number
  desc?: string
}

export interface RiverData {
  source: string
  generated: string
  summary: {
    totalKm: number
    riverCount: number
    uniqueRivers: number
  }
  rivers: River[]
}

export type RiverOrientation = 'vertical' | 'horizontal'

export interface RiverViewController {
  setData: (data: RiverData) => void
  setProjection: (proj: LineProjection | null) => void
  setHasLocation: (has: boolean) => void
  setVisible: (visible: boolean) => void
  destroy: () => void
}

function formatKm(km: number): string {
  if (!Number.isFinite(km)) return '—'
  if (km < 10) return km.toFixed(1)
  return String(Math.round(km))
}

export function createRiverView(root: HTMLElement): RiverViewController {
  let data: RiverData | null = null
  let projection: LineProjection | null = null
  let hasLocation = false
  let visible = false
  let orientation: RiverOrientation =
    window.innerWidth > window.innerHeight ? 'horizontal' : 'vertical'

  root.innerHTML = `
    <div class="river-shell">
      <div class="river-status" id="river-status"></div>
      <div class="river-scroll" id="river-scroll">
        <div class="river-track" id="river-track">
          <div class="river-plot" id="river-plot">
            <div class="river-rail" aria-hidden="true"></div>
            <div class="river-highlight hidden" id="river-highlight"></div>
            <div class="river-ticks" id="river-ticks"></div>
            <div class="river-me hidden" id="river-me" title="我">
              <span class="river-me-dot"></span>
              <span class="river-me-label">我</span>
            </div>
          </div>
        </div>
      </div>
      <div class="river-ends">
        <span class="river-end-from">宝鸡</span>
        <span class="river-end-mid">宝成线 · 沿线河流</span>
        <span class="river-end-to">成都</span>
      </div>
    </div>
  `

  const statusEl = root.querySelector('#river-status') as HTMLElement
  const scrollEl = root.querySelector('#river-scroll') as HTMLElement
  const trackEl = root.querySelector('#river-track') as HTMLElement
  const ticksEl = root.querySelector('#river-ticks') as HTMLElement
  const highlightEl = root.querySelector('#river-highlight') as HTMLElement
  const meEl = root.querySelector('#river-me') as HTMLElement

  function totalKm(): number {
    if (!data) return 545.7
    return Math.max(data.summary.totalKm, 1e-3)
  }

  function frac(km: number): number {
    return Math.max(0, Math.min(1, km / totalKm()))
  }

  function applyOrientation() {
    root.classList.toggle('river-horizontal', orientation === 'horizontal')
    root.classList.toggle('river-vertical', orientation === 'vertical')
  }

  function sizeTrack() {
    const riverCount = data?.rivers.length || 20
    if (orientation === 'vertical') {
      const minH = Math.max(riverCount * 48 + 60, scrollEl.clientHeight || 400)
      trackEl.style.height = `${minH}px`
      trackEl.style.width = ''
    } else {
      const minW = Math.max(riverCount * 80 + 80, scrollEl.clientWidth || 600)
      trackEl.style.width = `${minW}px`
      trackEl.style.height = ''
    }
  }

  function renderTicks() {
    if (!data) {
      ticksEl.innerHTML = ''
      return
    }

    sizeTrack()
    ticksEl.innerHTML = data.rivers
      .map((r) => {
        const f = frac(r.km)
        const isNearMe = projection && Math.abs(projection.kmAlong - r.km) < 15
        const cls = ['river-tick', isNearMe ? 'near-me' : ''].filter(Boolean).join(' ')
        const style =
          orientation === 'vertical'
            ? `top:${(f * 100).toFixed(3)}%`
            : `left:${(f * 100).toFixed(3)}%`
        const descHtml = r.desc ? `<span class="river-tick-desc">${r.desc}</span>` : ''
        return `<div class="${cls}" style="${style}" data-name="${r.name}" data-km="${r.km.toFixed(1)}">
          <span class="river-tick-mark">〰</span>
          <span class="river-tick-name">${r.name}</span>
          <span class="river-tick-km">${formatKm(r.km)} km</span>
          ${descHtml}
        </div>`
      })
      .join('')
  }

  function updateStatus() {
    if (!data) {
      statusEl.innerHTML = '<div class="river-loading">加载河流数据...</div>'
      highlightEl.classList.add('hidden')
      meEl.classList.add('hidden')
      return
    }

    if (!hasLocation || !projection) {
      statusEl.innerHTML = `
        <button type="button" class="river-locate-prompt" id="river-locate-prompt">点击定位，看看附近有什么河流</button>
      `
      highlightEl.classList.add('hidden')
      meEl.classList.add('hidden')
      return
    }

    const p = projection
    const nearbyRivers = data.rivers.filter(r => Math.abs(r.km - p.kmAlong) < 20)
    
    if (nearbyRivers.length > 0) {
      const closest = nearbyRivers.reduce((a, b) => 
        Math.abs(a.km - p.kmAlong) < Math.abs(b.km - p.kmAlong) ? a : b
      )
      const distToRiver = Math.abs(closest.km - p.kmAlong)
      
      if (distToRiver < 3) {
        statusEl.innerHTML = `
          <div class="river-status-main">你正在跨越 <strong>${closest.name}</strong></div>
          <div class="river-status-sub">沿线 ${formatKm(p.kmAlong)} km${closest.desc ? ` · ${closest.desc}` : ''}</div>
        `
      } else {
        const direction = closest.km > p.kmAlong ? '前方' : '后方'
        statusEl.innerHTML = `
          <div class="river-status-main">${direction}约 ${formatKm(distToRiver)} km 有 <strong>${closest.name}</strong></div>
          <div class="river-status-sub">你在沿线 ${formatKm(p.kmAlong)} km${closest.desc ? ` · ${closest.desc}` : ''}</div>
        `
      }
    } else {
      statusEl.innerHTML = `
        <div class="river-status-main">你在沿线 ${formatKm(p.kmAlong)} km</div>
        <div class="river-status-sub">附近暂无主要河流标记</div>
      `
    }

    const f0 = frac(Math.max(0, p.kmAlong - 20))
    const f1 = frac(Math.min(totalKm(), p.kmAlong + 20))
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
    const next: RiverOrientation =
      window.innerWidth > window.innerHeight ? 'horizontal' : 'vertical'
    if (next !== orientation) {
      orientation = next
      render()
    } else if (visible) {
      renderTicks()
      updateStatus()
    }
  }
  window.addEventListener('resize', onResize)
  window.addEventListener('orientationchange', onResize)

  applyOrientation()

  return {
    setData(d: RiverData) {
      data = d
      render()
    },
    setProjection(proj: LineProjection | null) {
      projection = proj
      renderTicks()
      updateStatus()
    },
    setHasLocation(has: boolean) {
      hasLocation = has
      updateStatus()
    },
    setVisible(v: boolean) {
      visible = v
      root.classList.toggle('hidden', !v)
      if (v) render()
    },
    destroy() {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      root.innerHTML = ''
    },
  }
}
