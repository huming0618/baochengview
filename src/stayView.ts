import {
  formatDuration,
  formatStayTime,
  getCurrentStay,
  getStayRecords,
  subscribeStayLog,
} from './stayLog.ts'

export interface StayViewController {
  setVisible: (visible: boolean) => void
  refresh: () => void
  destroy: () => void
}

export function createStayView(root: HTMLElement): StayViewController {
  let visible = false
  let tickId: number | undefined

  root.innerHTML = `
    <div class="stay-shell">
      <div class="stay-status" id="stay-status"></div>
      <div class="stay-scroll" id="stay-scroll">
        <div class="stay-list" id="stay-list"></div>
      </div>
      <div class="stay-ends">
        <span>宝鸡</span>
        <span class="stay-end-mid">宝成线 · 停留记录</span>
        <span>成都</span>
      </div>
    </div>
  `

  const statusEl = root.querySelector('#stay-status') as HTMLElement
  const listEl = root.querySelector('#stay-list') as HTMLElement

  function render() {
    const current = getCurrentStay()
    const records = getStayRecords()

    if (current) {
      const elapsed = Date.now() - current.startTime
      statusEl.innerHTML = `
        <div class="stay-status-main">正在停 · <strong>${current.station.name}</strong></div>
        <div class="stay-status-sub">开始于 ${formatStayTime(current.startTime)} · 已停 ${formatDuration(elapsed)}</div>
      `
    } else if (records.length === 0) {
      statusEl.innerHTML = `
        <div class="stay-status-main">还没有停留记录</div>
        <div class="stay-status-sub">定位后靠近车站才会开始记录，离开车站后写入本机</div>
      `
    } else {
      statusEl.innerHTML = `
        <div class="stay-status-main">共 ${records.length} 条停留</div>
        <div class="stay-status-sub">记录保存在本机，离开车站后写入</div>
      `
    }

    const currentHtml = current
      ? `<article class="stay-card stay-card-live">
          <div class="stay-card-name">${current.station.name}</div>
          <div class="stay-card-meta">开始 ${formatStayTime(current.startTime)}</div>
          <div class="stay-card-badge">正在停</div>
        </article>`
      : ''

    const recordsHtml = records
      .map(
        (r) => `<article class="stay-card">
          <div class="stay-card-name">${r.stationName}</div>
          <div class="stay-card-meta">开始 ${formatStayTime(r.startTime)}</div>
          <div class="stay-card-duration">${formatDuration(r.durationMs)}</div>
        </article>`
      )
      .join('')

    if (!currentHtml && !recordsHtml) {
      listEl.innerHTML = `<div class="stay-empty">到站停留会出现在这里</div>`
    } else {
      listEl.innerHTML = currentHtml + recordsHtml
    }
  }

  function startTick() {
    if (tickId !== undefined) return
    tickId = window.setInterval(() => {
      if (visible && getCurrentStay()) render()
    }, 1000)
  }

  function stopTick() {
    if (tickId !== undefined) {
      window.clearInterval(tickId)
      tickId = undefined
    }
  }

  const unsub = subscribeStayLog(() => {
    if (visible) render()
  })

  return {
    setVisible(v) {
      visible = v
      root.classList.toggle('hidden', !v)
      if (v) {
        render()
        startTick()
      } else {
        stopTick()
      }
    },
    refresh: render,
    destroy() {
      unsub()
      stopTick()
      root.innerHTML = ''
    },
  }
}
