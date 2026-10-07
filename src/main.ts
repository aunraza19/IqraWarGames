import { FlatMap } from './flatmap.js'
import type { GameState, ChatMessage, GameEvent, FactionId, Session, CommandResponse, CommandError, TurnReport } from './types.js'
import { clearLeaderboard, recordResult, topScores, type LeaderboardFaction } from './leaderboard.js'
import 'leaflet/dist/leaflet.css'
import './style.css'

const FACTION_COLORS: Record<string, string> = {
  nato: '#3498db',      // Blue - NATO
  russia: '#e74c3c',    // Red - Russia
  china: '#f1c40f'      // Yellow - China
}

const FACTIONS: FactionId[] = ['nato', 'russia', 'china']
const FACTION_LABEL: Record<FactionId, string> = { nato: 'NATO', russia: 'RUSSIA', china: 'CHINA' }
const FACTION_TAGLINE: Record<FactionId, string> = {
  nato: 'Best technology and the widest reach - spread across three continents.',
  russia: 'Heavy industry, artillery and strategic depth across Eurasia.',
  china: 'The biggest army and a strong economy - but only two territories.',
}

const EXAMPLE_COMMANDS = [
  'Attack the weakest nearby territory',
  'Recruit more infantry',
  'Improve military technology',
  'Play defensively this turn',
  'Focus on getting uranium',
]

const EVENT_ICONS: Record<string, string> = {
  move: '➔',
  attack: '⚔',
  combat: '⚔',
  fortify: '⛨',
  recruit: '➕',
  trade: '💰',
  spy: '🕵',
  research: '🔬',
  diplomacy: '🤝',
  capture: '🏴',
  victory: '🏆',
  nuke: '☢',
  build_nuke: '☢',
  betrayal: '🗡',
  forfeit: '❌',
  invalid: '⚠',
  message: '📨',
  hire_mercenary: '💵'
}

/** Create an element; text is always set with textContent, never parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

class WarGamesApp {
  private map: FlatMap
  private state: GameState | null = null
  private chatMessages: ChatMessage[] = []
  private chatIndex = 0
  private selectedFaction: FactionId | null = null
  private submitting = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private timerInterval: ReturnType<typeof setInterval> | null = null
  private startTime = 0
  private lastDisplayedTurn = 0
  /** Game id whose end screen has been shown (and recorded on the leaderboard). */
  private endShownFor: string | null = null
  private lbTab: LeaderboardFaction = 'nato'
  private reportVisible = false

  private get session(): Session | null {
    return this.state?.session ?? null
  }

  constructor() {
    this.map = new FlatMap($('globe-container'))

    // Setup screen
    $('setup-form').addEventListener('submit', (e) => { e.preventDefault(); this.startGame() })
    $('lb-clear').addEventListener('click', () => {
      if (confirm('Clear all leaderboard scores on this machine?')) {
        clearLeaderboard()
        this.renderLeaderboard()
      }
    })

    // Command panel
    const input = $<HTMLTextAreaElement>('command-input')
    $('command-form').addEventListener('submit', (e) => { e.preventDefault(); this.submitOrders({ command: input.value }) })
    input.addEventListener('input', () => this.updateCharCount())
    input.addEventListener('keydown', (e) => {
      // Enter executes; Shift+Enter adds a line.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        this.submitOrders({ command: input.value })
      }
    })
    const chips = $('command-chips')
    for (const text of EXAMPLE_COMMANDS) {
      const chip = h('button', 'chip', text)
      chip.type = 'button'
      chip.addEventListener('click', () => {
        input.value = text
        this.updateCharCount()
        input.focus()
      })
      chips.appendChild(chip)
    }
    for (const btn of document.querySelectorAll<HTMLButtonElement>('#quick-strategies [data-quick]')) {
      btn.addEventListener('click', () => this.submitOrders({ quick: btn.dataset.quick! }))
    }

    $('btn-reset').addEventListener('click', () => {
      const s = this.session
      const midGame = s && s.phase !== 'setup' && s.phase !== 'finished' && (this.state?.game.turn ?? 0) > 0
      if (midGame && !confirm('Abandon this game and return to faction selection?')) return
      this.newGame()
    })

    // Dismiss game summary modal on backdrop click
    $('game-summary-modal').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'game-summary-modal') $('game-summary-modal').classList.add('hidden')
    })

    this.boot()
  }

  private async boot() {
    // A reload mid-game should not replay the last turn's toasts and effects.
    this.lastDisplayedTurn = Number.MAX_SAFE_INTEGER
    await this.fetchState()
    this.lastDisplayedTurn = this.state?.game.turn ?? 0
    await this.fetchChat()
    const s = this.session
    if (!s || s.phase === 'setup') {
      this.showSetup()
    } else {
      // Page reloaded mid-game: pick up where the server is.
      this.startTime = this.state?.game.startedAt ? Date.parse(this.state.game.startedAt) : Date.now()
      if (s.phase !== 'finished') this.startTimer()
      if (s.phase === 'processing_turn') this.watchProcessing()
    }
  }

  // ---------- Setup screen ----------

  private showSetup() {
    this.selectedFaction = null
    $<HTMLInputElement>('player-name').value = ''
    $('setup-error').classList.add('hidden')
    this.buildFactionCards()
    this.renderSetupRoster()
    this.renderLeaderboard()
    $('setup-screen').classList.remove('hidden')
    $<HTMLInputElement>('player-name').focus()
  }

  private buildFactionCards() {
    const wrap = $('faction-cards')
    wrap.replaceChildren()
    for (const fid of FACTIONS) {
      const f = this.state?.factions[fid]
      const card = h('button', `faction-card ${fid}`)
      card.type = 'button'
      card.setAttribute('role', 'radio')
      card.setAttribute('aria-checked', 'false')
      card.dataset.faction = fid
      card.appendChild(h('div', 'fc-name', FACTION_LABEL[fid]))
      card.appendChild(h('div', 'fc-tagline', FACTION_TAGLINE[fid]))
      if (f) {
        card.appendChild(h('div', 'fc-stats', `${f.territoryCount} territories · ${f.units.length} units · military tech ${f.tech.military}`))
      }
      card.addEventListener('click', () => this.selectFaction(fid))
      wrap.appendChild(card)
    }
  }

  private selectFaction(fid: FactionId) {
    this.selectedFaction = fid
    for (const card of document.querySelectorAll<HTMLElement>('.faction-card')) {
      const on = card.dataset.faction === fid
      card.classList.toggle('selected', on)
      card.setAttribute('aria-checked', String(on))
    }
    $<HTMLButtonElement>('btn-begin').disabled = false
    this.lbTab = fid
    this.renderSetupRoster()
    this.renderLeaderboard()
  }

  private renderSetupRoster() {
    const roster = $('setup-roster')
    roster.replaceChildren()
    if (!this.selectedFaction) return
    roster.appendChild(h('div', 'roster-you', `YOU COMMAND ${FACTION_LABEL[this.selectedFaction]}`))
    for (const fid of FACTIONS.filter((f) => f !== this.selectedFaction)) {
      const row = h('div', 'roster-row')
      row.append(h('span', '', FACTION_LABEL[fid]), h('span', 'roster-dots'), h('span', 'roster-ai', 'AI'))
      roster.appendChild(row)
    }
  }

  private renderLeaderboard() {
    const tabs = $('lb-tabs')
    tabs.replaceChildren()
    for (const fid of FACTIONS) {
      const tab = h('button', `lb-tab ${fid}${fid === this.lbTab ? ' active' : ''}`, FACTION_LABEL[fid])
      tab.type = 'button'
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(fid === this.lbTab))
      tab.addEventListener('click', () => { this.lbTab = fid; this.renderLeaderboard() })
      tabs.appendChild(tab)
    }
    const list = $('lb-list')
    list.replaceChildren()
    const entries = topScores(this.lbTab, 8)
    if (entries.length === 0) {
      list.appendChild(h('li', 'lb-empty', `No ${FACTION_LABEL[this.lbTab]} scores yet - be the first.`))
      return
    }
    for (const e of entries) {
      const li = h('li', 'lb-row')
      li.append(
        h('span', 'lb-name', e.name),
        h('span', `lb-outcome ${e.outcome}`, e.outcome.toUpperCase()),
        h('span', 'lb-score', e.score.toLocaleString()),
      )
      list.appendChild(li)
    }
  }

  private async startGame() {
    if (!this.selectedFaction) return
    const begin = $<HTMLButtonElement>('btn-begin')
    begin.disabled = true
    $('setup-error').classList.add('hidden')
    try {
      const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerName: $<HTMLInputElement>('player-name').value, humanFaction: this.selectedFaction }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Could not start the game.')
      this.resetClientView()
      $('setup-screen').classList.add('hidden')
      this.startTime = Date.now()
      this.startTimer()
      await this.fetchState()
      await this.fetchChat()
      $<HTMLTextAreaElement>('command-input').focus()
    } catch (err) {
      const box = $('setup-error')
      box.textContent = err instanceof Error && err.message !== 'Failed to fetch' ? err.message : 'GAME SERVER UNREACHABLE - is the server running?'
      box.classList.remove('hidden')
      begin.disabled = false
    }
  }

  private async newGame() {
    this.stopPolling()
    try {
      await fetch('/api/reset', { method: 'POST' })
    } catch {
      /* server unreachable - fetchState below reports it */
    }
    this.resetClientView()
    this.stopTimer()
    $('elapsed').textContent = '0:00'
    await this.fetchState()
    this.showSetup()
  }

  /** Clear everything a previous game left in the UI. */
  private resetClientView() {
    this.chatMessages = []
    this.chatIndex = 0
    this.lastDisplayedTurn = 0
    this.endShownFor = null
    this.submitting = false
    this.reportVisible = false
    this.map.reset()
    $('game-summary-modal').classList.add('hidden')
    $('capture-toasts').replaceChildren()
    const input = $<HTMLTextAreaElement>('command-input')
    input.value = ''
    this.updateCharCount()
    this.hideNotice()
    $('quick-strategies').classList.add('hidden')
    $('turn-report').classList.add('hidden')
    $('command-form').classList.remove('hidden')
    this.setStatus(null)
    this.renderChat()
  }

  // ---------- Orders ----------

  private async submitOrders(payload: { command?: string; quick?: string }) {
    const s = this.session
    if (this.submitting || !s || s.phase !== 'waiting_for_player' || !s.gameId) return
    if (payload.command !== undefined) {
      const text = payload.command.trim()
      if (!text) {
        this.showNotice('Type your orders first.', ['Try: "Recruit infantry and defend Eastern Europe."'])
        return
      }
    }
    this.submitting = true
    this.lockCommands(true)
    this.hideNotice()
    this.setStatus(payload.quick ? 'EXECUTING QUICK STRATEGY...' : 'INTERPRETING YOUR ORDERS...')
    this.watchProcessing()

    try {
      const res = await fetch('/api/player-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: s.gameId, turn: s.turn, ...payload }),
      })
      const body = await res.json().catch(() => ({ error: 'Game server error. Please restart the round.', code: 'server_error' }))
      if (res.ok) {
        const ok = body as CommandResponse
        $<HTMLTextAreaElement>('command-input').value = ''
        this.updateCharCount()
        $('quick-strategies').classList.add('hidden')
        this.showReport(ok.report, ok.accepted, ok.warnings, ok.session.phase === 'finished')
      } else {
        this.handleRefusal(body as CommandError)
      }
    } catch {
      this.showNotice('GAME SERVER ERROR', ['The server could not be reached. Check it is running, then try again.'])
    } finally {
      this.submitting = false
      this.stopPolling()
      this.setStatus(null)
      await this.fetchState()
      await this.fetchChat()
      this.lockCommands(false)
    }
  }

  private handleRefusal(err: CommandError) {
    switch (err.code) {
      case 'not_understood': {
        const lines = [...(err.rejected ?? []).map((r) => `✕ ${r}`), ...(err.warnings ?? [])]
        lines.push('Your turn has not been used. Try something like: "Recruit infantry and defend Eastern Europe."')
        this.showNotice('COMMAND COULD NOT BE INTERPRETED', lines)
        break
      }
      case 'interpreter_unavailable':
        this.showNotice('AI COMMAND INTERPRETER UNAVAILABLE', [
          'Your turn has not been used. Try your orders again in a moment, or pick a quick strategy below.',
        ])
        $('quick-strategies').classList.remove('hidden')
        break
      case 'stale_game':
      case 'stale_turn':
      case 'turn_in_progress':
      case 'game_over':
        this.showNotice(err.error || 'That turn has already moved on.', [])
        break
      case 'server_error':
        this.showNotice('GAME SERVER ERROR', ['Please try again, or press NEW GAME to restart the round.'])
        break
      default:
        this.showNotice(err.error || 'Those orders could not be sent.', [])
    }
  }

  private lockCommands(locked: boolean) {
    const s = this.session
    const canPlay = !locked && !!s && s.phase === 'waiting_for_player'
    $<HTMLTextAreaElement>('command-input').disabled = !canPlay
    $<HTMLButtonElement>('btn-execute').disabled = !canPlay
    $<HTMLButtonElement>('btn-execute').textContent = locked ? 'WORKING...' : 'EXECUTE ORDERS'
    for (const b of document.querySelectorAll<HTMLButtonElement>('#quick-strategies button, .chip')) b.disabled = !canPlay
  }

  /** While a turn is processing, poll the session only to show "thinking / retrying". */
  private watchProcessing() {
    this.stopPolling()
    this.pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/state')
        const state = (await res.json()) as GameState
        const s = state.session
        if (!s) return
        if (s.phase === 'processing_turn') {
          if (s.aiStatus === 'retrying') this.setStatus('AI COMMAND NETWORK BUSY - RETRYING...', true)
          else if (!this.submitting) this.setStatus('AI OPPONENTS ARE PLANNING...')
          else this.setStatus('INTERPRETING YOUR ORDERS · AI OPPONENTS ARE PLANNING...')
        } else if (!this.submitting) {
          // Picked up after a reload: the turn finished without our request.
          this.stopPolling()
          this.setStatus(null)
          await this.fetchState()
          await this.fetchChat()
          if (s.lastReport) this.showReport(s.lastReport, [], [], s.phase === 'finished')
          this.lockCommands(false)
        }
      } catch {
        /* transient - next tick retries */
      }
    }, 1000)
    if (!this.submitting) this.lockCommands(true)
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private setStatus(text: string | null, warn = false) {
    const el = $('command-status')
    if (!text) {
      el.classList.add('hidden')
      el.textContent = ''
      return
    }
    el.replaceChildren(h('span', 'spinner'), document.createTextNode(text))
    el.classList.toggle('warn', warn)
    el.classList.remove('hidden')
  }

  private showNotice(title: string, lines: string[]) {
    const el = $('command-notice')
    el.replaceChildren(h('div', 'notice-title', title), ...lines.map((l) => h('div', 'notice-line', l)))
    el.classList.remove('hidden')
  }

  private hideNotice() {
    $('command-notice').classList.add('hidden')
    $('command-notice').replaceChildren()
  }

  private showReport(report: TurnReport, accepted: string[], warnings: string[], finished: boolean) {
    const el = $('turn-report')
    el.replaceChildren()

    const next = h('button', 'btn btn-next', finished ? 'SEE FINAL RESULT' : 'NEXT TURN \u25B8')
    next.type = 'button'
    next.addEventListener('click', () => {
      this.hideReport()
      if (finished) this.maybeShowGameSummary(true)
      else $<HTMLTextAreaElement>('command-input').focus()
    })
    const head = h('div', 'report-head')
    const text = h('div', 'report-head-text')
    text.append(h('div', 'report-title', `TURN ${report.turn} RESULTS`), h('div', 'report-headline', report.headline))
    head.append(text, next)
    el.appendChild(head)

    if (report.factions.some((f) => f.controller === 'fallback')) {
      el.appendChild(h('div', 'report-banner', 'AI FALLBACK STRATEGY ACTIVE'))
    }

    const cols = h('div', 'report-cols')
    for (const f of report.factions) {
      const you = f.label === 'YOU'
      const box = h('div', `report-box ${f.faction}${you ? ' you' : ''}`)
      const who = you ? `YOU · ${FACTION_LABEL[f.faction]}` :
        `${f.label} · ${f.controller === 'fallback' ? 'AI (FALLBACK)' : 'AI'}`
      const title = h('div', 'report-box-title', who)
      title.style.color = FACTION_COLORS[f.faction]
      box.appendChild(title)
      if (you && accepted.length) {
        box.appendChild(h('div', 'report-orders', `Orders: ${accepted.join(' · ')}`))
      }
      for (const line of f.lines.slice(0, 5)) {
        box.appendChild(h('div', `report-line ${line.ok ? 'ok' : 'bad'}`, `${line.ok ? '\u2713' : '\u2715'} ${line.text}`))
      }
      if (you) for (const w of warnings) box.appendChild(h('div', 'report-warning', `\u26A0 ${w}`))
      cols.appendChild(box)
    }
    el.appendChild(cols)

    this.reportVisible = true
    $('command-form').classList.add('hidden')
    el.classList.remove('hidden')
    next.focus()
  }

  private hideReport() {
    this.reportVisible = false
    $('turn-report').classList.add('hidden')
    $('command-form').classList.remove('hidden')
  }

  private updateCharCount() {
    const input = $<HTMLTextAreaElement>('command-input')
    const max = this.session?.maxCommandLength ?? 500
    input.maxLength = max
    const el = $('char-count')
    el.textContent = `${input.value.length} / ${max}`
    el.classList.toggle('near-limit', input.value.length > max * 0.9)
  }

  // ---------- Timer ----------

  private startTimer() {
    this.stopTimer()
    this.timerInterval = setInterval(() => this.updateElapsed(), 1000)
    this.updateElapsed()
  }

  private stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval)
      this.timerInterval = null
    }
  }

  private updateElapsed() {
    if (this.startTime > 0) {
      const elapsed = Math.max(0, Math.floor((Date.now() - this.startTime) / 1000))
      const min = Math.floor(elapsed / 60)
      const sec = elapsed % 60
      $('elapsed').textContent = `${min}:${sec.toString().padStart(2, '0')}`
    }
  }

  // ---------- State ----------

  private async fetchState() {
    try {
      const res = await fetch('/api/state')
      this.state = await res.json()
      this.render()
    } catch (err) {
      console.error('Failed to fetch state:', err)
      $('game-status').textContent = 'OFFLINE'
    }
  }

  private async fetchChat(): Promise<void> {
    try {
      const res = await fetch(`/api/chat?since=${this.chatIndex}`)
      const json = await res.json()
      const messages: ChatMessage[] = Array.isArray(json?.messages) ? json.messages : []
      const total: number = typeof json?.total === 'number' ? json.total : this.chatIndex + messages.length
      if (total < this.chatIndex) {
        // The server reset under us - start the log over.
        this.chatMessages = []
        this.chatIndex = 0
        return this.fetchChat()
      }
      if (messages.length > 0) {
        this.chatMessages.push(...messages)
        if (this.chatMessages.length > 200) this.chatMessages = this.chatMessages.slice(-200)
        this.chatIndex = total
        this.renderChat()
        // Flash the intel feed to signal new messages
        const feedEl = $('intel-feed')
        feedEl.classList.remove('new-intel')
        void feedEl.offsetWidth
        feedEl.classList.add('new-intel')
        setTimeout(() => feedEl.classList.remove('new-intel'), 2000)
      }
    } catch (err) {
      console.error('Failed to fetch chat:', err)
    }
  }

  private render() {
    if (!this.state) return
    const s = this.session

    this.map.render(this.state)

    $('turn-counter').textContent = s && s.phase !== 'setup' ? `${s.turn} / ${s.maxTurns}` : '-'
    this.renderRoster()

    const statusEl = $('game-status')
    if (this.state.game.status === 'finished' && s?.outcome) {
      statusEl.textContent = s.outcome.toUpperCase()
      statusEl.style.color = s.outcome === 'victory' ? '#4caf50' : s.outcome === 'defeat' ? '#e74c3c' : '#bbb'
      this.stopTimer()
      this.map.stopCamera()
      this.maybeShowGameSummary(false)
    } else if (s?.phase === 'processing_turn') {
      statusEl.textContent = 'RESOLVING'
      statusEl.style.color = '#f39c12'
    } else if (s?.phase === 'waiting_for_player') {
      statusEl.textContent = 'YOUR MOVE'
      statusEl.style.color = '#4caf50'
    } else {
      statusEl.textContent = 'WAITING'
      statusEl.style.color = '#888'
    }

    // Toasts for a newly resolved turn
    if (this.state.game.turn > this.lastDisplayedTurn && this.state.game.turn > 0) {
      this.lastDisplayedTurn = this.state.game.turn
      this.showTurnBriefing(this.state)
    }

    this.renderCommandPanel()
    this.renderFactionPanels()
  }

  private renderRoster() {
    const el = $('roster')
    el.replaceChildren()
    const s = this.session
    if (!s?.humanFaction) return
    for (const fid of FACTIONS) {
      const human = fid === s.humanFaction
      const chip = h('span', `roster-chip ${fid}${human ? ' human' : ''}`)
      chip.append(h('span', 'roster-name', FACTION_LABEL[fid]), h('span', 'roster-ctrl', human ? 'YOU' : 'AI'))
      el.appendChild(chip)
    }
  }

  private renderCommandPanel() {
    const s = this.session
    if (!s) return
    const title = $('command-title')
    const turnEl = $('command-turn')
    if (s.humanFaction) {
      title.textContent = `YOU COMMAND ${FACTION_LABEL[s.humanFaction]}`
      title.style.color = FACTION_COLORS[s.humanFaction]
      turnEl.textContent = s.phase === 'finished' ? 'GAME OVER' : `TURN ${s.turn} OF ${s.maxTurns}${s.playerName ? ` · ${s.playerName.toUpperCase()}` : ''}`
    } else {
      title.textContent = 'YOUR ORDERS'
      title.style.color = ''
      turnEl.textContent = ''
    }

    const avail = $('available-actions')
    avail.replaceChildren()
    if (s.phase === 'waiting_for_player' && s.availableActions.length) {
      avail.append(h('span', 'avail-label', 'AVAILABLE NOW'), ...s.availableActions.map((a) => h('span', 'avail-item', a)))
    }

    if (!this.submitting && !this.pollTimer) this.lockCommands(false)
    if (s.phase === 'finished' && !this.reportVisible) {
      $('command-form').classList.add('hidden')
    }
    this.updateCharCount()
  }

  private renderFactionPanels() {
    if (!this.state) return
    const human = this.session?.humanFaction ?? null
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      const panel = document.getElementById(`faction-${factionId}`)
      if (!panel) continue

      const res = faction.resources
      const tech = faction.tech
      panel.classList.toggle('is-human', factionId === human)
      const badge = panel.querySelector('.f-badge')!
      badge.textContent = human ? (factionId === human ? 'YOU' : 'AI') : ''
      badge.className = `f-badge ${human ? (factionId === human ? 'you' : 'ai') : ''}`

      panel.querySelector('.f-territories')!.textContent = `${faction.territoryCount}`
      panel.querySelector('.f-units')!.textContent = `${faction.units.length}`
      panel.querySelector('.f-gold')!.textContent = `${res.gold}`
      panel.querySelector('.f-food')!.textContent = `${res.food}`
      panel.querySelector('.f-iron')!.textContent = `${res.iron}`
      panel.querySelector('.f-influence')!.textContent = `${res.influence}`
      panel.querySelector('.f-knowledge')!.textContent = `${res.knowledge}`
      panel.querySelector('.f-score')!.textContent = `${faction.score}`
      panel.querySelector('.f-uranium')!.textContent = `${res.uranium || 0}`
      panel.querySelector('.f-nukes')!.textContent = (faction.nukes || 0).toLocaleString()
      panel.querySelector('.f-tech-mil')!.textContent = `${tech.military}`
      panel.querySelector('.f-tech-eco')!.textContent = `${tech.economic}`
      panel.querySelector('.f-tech-int')!.textContent = `${tech.intelligence}`
      panel.querySelector('.f-tech-nuc')!.textContent = `${tech.nuclear || 0}`

      const allyEl = panel.querySelector('.f-allies')!
      allyEl.textContent = faction.alliances.length > 0
        ? faction.alliances.map(a => FACTION_LABEL[a as FactionId] || a).join(', ')
        : 'None'
    }
  }

  private showTurnBriefing(state: GameState & { recentEvents?: GameEvent[] }) {
    const events = (state.recentEvents || []).filter(e => e.type !== 'invalid' && e.type !== 'forfeit')

    // Spawn toasts one-by-one with staggered timing
    const toastContainer = $('capture-toasts')
    for (let i = 0; i < events.length; i++) {
      const evt = events[i]
      const icon = EVENT_ICONS[evt.type] || '🏴'
      const color = evt.faction ? (FACTION_COLORS[evt.faction] || '#888') : '#888'
      setTimeout(() => {
        const toast = h('div', `capture-toast ${evt.type} ${evt.faction || ''}`)
        toast.style.borderLeftColor = color
        toast.append(h('span', 'toast-icon', icon), h('span', 'toast-text', evt.description))
        toastContainer.appendChild(toast)
        // Trigger exit animation then remove
        setTimeout(() => {
          toast.classList.add('exiting')
          setTimeout(() => toast.remove(), 400)
        }, 4000)
      }, i * 500)
    }
  }

  private renderChat() {
    const feedEl = $('intel-feed')
    const messages = this.chatMessages.filter(m =>
      m.channel === 'command' || m.channel === 'observer' || m.channel === 'diplomacy'
    )
    let html = ''
    for (const msg of messages.slice(-60)) {
      html += this.chatLine(msg, false)
    }
    feedEl.innerHTML = html || '<div class="chat-msg chat-empty">Awaiting intelligence...</div>'
    feedEl.scrollTop = feedEl.scrollHeight

    // Combined command feed in sidebar
    const combinedEl = document.getElementById('chat-combined')
    if (combinedEl) {
      const factionMsgs = this.chatMessages.filter(m => m.channel === 'nato' || m.channel === 'russia' || m.channel === 'china')
      let combinedHtml = ''
      for (const msg of factionMsgs.slice(-30)) {
        const color = FACTION_COLORS[msg.agent] || '#888'
        const who = msg.agent === this.session?.humanFaction ? 'YOU' : `${FACTION_LABEL[msg.agent as FactionId] ?? msg.agentName} AI`
        combinedHtml += `<div class="chat-msg"><span class="chat-agent" style="color:${color}">[${escapeHtml(who)}]</span> <span class="chat-text">${renderMarkdown(msg.message)}</span></div>`
      }
      combinedEl.innerHTML = combinedHtml || '<div class="chat-msg chat-empty">Awaiting orders...</div>'
      combinedEl.scrollTop = combinedEl.scrollHeight
    }
  }

  /** One feed line. Every server/model string goes through escapeHtml / renderMarkdown (which escapes first). */
  private chatLine(msg: ChatMessage, withTurn: boolean): string {
    const isDiplo = msg.channel === 'diplomacy'
    const isNews = msg.agent === 'narrator'
    const color = isDiplo ? (FACTION_COLORS[msg.agent] || '#888') : msg.agent === 'gm' ? '#9b59b6' : isNews ? '#1abc9c' : '#888'
    const sourceTag = isDiplo ? '<span class="feed-source diplo">DIPLO</span>' : isNews ? '<span class="feed-source news">SITREP</span>' : ''
    const who = isDiplo ? (msg.agent === this.session?.humanFaction ? 'YOU' : FACTION_LABEL[msg.agent as FactionId] ?? msg.agentName) : msg.agentName
    return `<div class="chat-msg">${sourceTag}<span class="chat-agent" style="color:${color}">[${withTurn ? `T${msg.turn} ` : ''}${escapeHtml(who)}]</span> <span class="chat-text">${renderMarkdown(msg.message)}</span></div>`
  }

  // ---------- End of game ----------

  /** Show the end screen once per game (after map effects settle), and record the result. */
  private maybeShowGameSummary(force: boolean) {
    const s = this.session
    if (!s || s.phase !== 'finished' || !s.gameId) return
    if (!force && (this.endShownFor === s.gameId || this.reportVisible)) return
    this.endShownFor = s.gameId
    const waitForEffects = () => {
      if (this.map.hasActiveAnimations()) setTimeout(waitForEffects, 300)
      else setTimeout(() => this.showGameSummary(), force ? 0 : 1200)
    }
    waitForEffects()
  }

  private showGameSummary() {
    const s = this.session
    if (!this.state || !s || !s.humanFaction || !s.outcome) return
    const human = s.humanFaction
    const me = this.state.factions[human]
    const score = s.finalScore ?? 0

    const rank = recordResult({
      id: s.gameId!,
      name: s.playerName,
      faction: human,
      score,
      outcome: s.outcome,
      turns: this.state.game.turn,
      territories: me.territoryCount,
      at: new Date().toISOString(),
    })

    const modal = $('game-summary-modal')
    const body = $('summary-modal-body')
    body.replaceChildren()

    const header = h('div', 'summary-header')
    const outcome = h('div', `summary-outcome ${s.outcome}`, s.outcome.toUpperCase())
    const victor = this.state.game.victor
    const sub = victor
      ? `${victor === human ? 'You' : FACTION_LABEL[victor as FactionId]} won ${victor === human ? '' : 'the game'}`.trim()
      : 'No faction finished ahead'
    header.append(h('div', 'summary-title', 'GAME OVER'), outcome, h('div', 'summary-subtitle', sub))
    body.appendChild(header)

    const stats = h('div', 'summary-stats')
    const stat = (label: string, value: string) => {
      const box = h('div', 'summary-stat')
      box.append(h('div', 'summary-stat-label', label), h('div', 'summary-stat-value', value))
      return box
    }
    stats.append(
      stat('Commander', s.playerName),
      stat('Faction', FACTION_LABEL[human]),
      stat('Turns', `${this.state.game.turn}`),
      stat('Territories', `${me.territoryCount}`),
      stat('Final score', score.toLocaleString()),
    )
    body.appendChild(stats)
    if (rank !== null) {
      body.appendChild(h('div', 'summary-rank', `#${rank} on the ${FACTION_LABEL[human]} leaderboard`))
    }

    const standings = h('div', 'summary-section')
    standings.appendChild(h('div', 'summary-section-title', 'FINAL STANDINGS'))
    for (const [fId, faction] of Object.entries(this.state.factions).sort((a, b) => b[1].score - a[1].score)) {
      const row = h('div', `summary-faction ${fId === victor ? 'victor' : ''}`)
      const name = h('span', 'summary-faction-name', `${FACTION_LABEL[fId as FactionId]} ${fId === human ? '(YOU)' : '(AI)'}`)
      name.style.color = FACTION_COLORS[fId] || '#888'
      const pts = h('span', 'summary-faction-score', `${faction.score} pts`)
      pts.style.color = FACTION_COLORS[fId] || '#888'
      row.append(name, h('span', 'summary-faction-stats', `${faction.territoryCount} territories - ${faction.units.length} units`), pts)
      standings.appendChild(row)
    }
    body.appendChild(standings)

    const moments = h('div', 'summary-section')
    moments.appendChild(h('div', 'summary-section-title', 'KEY MOMENTS'))
    const timeline = h('div', 'summary-timeline')
    const reports = this.chatMessages.filter(m => m.channel === 'observer').slice(-10)
    for (const msg of reports) {
      const entry = h('div', 'summary-timeline-entry')
      entry.append(h('span', 'summary-timeline-turn', `T${msg.turn}`), h('span', 'summary-timeline-text', msg.message))
      timeline.appendChild(entry)
    }
    if (!reports.length) timeline.appendChild(h('div', 'summary-timeline-text', 'No reports recorded.'))
    moments.appendChild(timeline)
    body.appendChild(moments)

    const actions = h('div', 'summary-actions')
    const again = h('button', 'btn btn-begin', 'PLAY AGAIN')
    const details = h('button', 'btn summary-btn-details', 'FULL LOG')
    const close = h('button', 'btn summary-btn-close', 'VIEW MAP')
    for (const b of [again, details, close]) b.type = 'button'
    again.addEventListener('click', () => this.newGame())
    details.addEventListener('click', () => this.showFullDetails(body))
    close.addEventListener('click', () => modal.classList.add('hidden'))
    actions.append(again, details, close)
    body.appendChild(actions)

    modal.classList.remove('hidden')
    body.scrollTop = 0
    again.focus({ preventScroll: true })
  }

  private showFullDetails(container: HTMLElement) {
    const header = h('div', 'summary-header')
    header.append(
      h('div', 'summary-title', 'FULL INTELLIGENCE LOG'),
      h('div', 'summary-subtitle', `${this.chatMessages.length} messages across ${this.state?.game.turn || 0} turns`),
    )
    const log = h('div', 'summary-full-log')
    log.innerHTML = this.chatMessages.map((m) => this.chatLine(m, true)).join('')

    const actions = h('div', 'summary-actions')
    const back = h('button', 'btn summary-btn-close', 'BACK')
    const again = h('button', 'btn btn-begin', 'PLAY AGAIN')
    back.type = 'button'
    again.type = 'button'
    back.addEventListener('click', () => this.showGameSummary())
    again.addEventListener('click', () => this.newGame())
    actions.append(back, again)
    container.replaceChildren(header, log, actions)
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function renderMarkdown(str: string): string {
  // Escape HTML first
  let out = escapeHtml(str)
  // **bold**
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // *italic*
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // __bold__
  out = out.replace(/__(.+?)__/g, '<strong>$1</strong>')
  // _italic_
  out = out.replace(/\b_(.+?)_\b/g, '<em>$1</em>')
  // `code`
  out = out.replace(/`(.+?)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:2px;font-size:10px;">$1</code>')
  return out
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  new WarGamesApp()
})
