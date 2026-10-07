import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { GameState, Unit, Order, FactionOrders, TurnResult, GameEvent, ChatMessage, ModelCallCount, OrderSource, HumanTurnRecord } from './types.js'
import { getOpponentOrders, interpretCommand, type OrderVocabulary } from './ai.js'
import { FACTION_IDS, GAME_CONFIG, type FactionId } from './config.js'
import { availableActions, cleanText, describeOrder, factionLabel, validateOrders } from './orders.js'
import { FALLBACK_FOCUS, planFallbackOrders, type StrategyFocus } from './fallback.js'
import { buildTurnReport, type TurnReport } from './summary.js'
import { eventScore, factionScore, outcomeFor, type Outcome } from './scoring.js'
import {
  FORTIFY_IRON_COST,
  MERCENARY_GOLD_COST,
  RESOURCE_IDS,
  TERRAIN_DEFENSE,
  UNIT_ID_PREFIX,
  UNIT_STATS,
  UNIT_TECH_REQUIRED,
  isTechId,
  isUnitType,
  nukeBuildCost,
  researchCost,
  spyCost,
} from './rules.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load faction personas
function loadPersona(faction: string): string {
  try {
    return readFileSync(resolve(__dirname, `../game/factions/${faction}.md`), 'utf-8')
  } catch {
    return `You command the ${faction} faction.`
  }
}

const personas: Record<string, string> = {
  nato: loadPersona('nato'),
  russia: loadPersona('russia'),
  china: loadPersona('china')
}

/**
 * Lifecycle of one Human vs AI game:
 *   setup              - no game; the player is choosing a faction
 *   waiting_for_player - nothing happens until the player submits orders
 *   processing_turn    - one submission is being interpreted and resolved; others are refused
 *   finished           - a victory condition or the turn limit ended the game
 */
export type GamePhase = 'setup' | 'waiting_for_player' | 'processing_turn' | 'finished'

/** What the AI layer is doing right now, for the "thinking / network busy" indicator. */
export type AiStatus = 'idle' | 'thinking' | 'retrying'

/** Thrown when a game was reset while a turn was awaiting the AI. */
export class StaleTurnError extends Error {
  constructor(turn: number) {
    super(`Turn ${turn} discarded: the game was reset while it was in flight`)
    this.name = 'StaleTurnError'
  }
}

/** A submission the server refuses. `status` is the HTTP status; nothing in it is internal. */
export class TurnRejectedError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'TurnRejectedError'
  }
}

export interface CommandRequest {
  gameId: string
  turn: number
  /** Natural-language command (already length-checked by the HTTP layer). */
  command?: string
  /** Quick strategy, used instead of a command when the interpreter is unavailable. */
  quick?: StrategyFocus
}

export interface CommandResult {
  turn: number
  interpretation: string
  warnings: string[]
  accepted: string[]
  rejected: string[]
  report: TurnReport
}

interface Snapshot {
  state: GameState
  chatLength: number
  pendingAlliances: string[]
  surpriseAttackBonus: Record<string, number>
  unitSeq: number
}

export class GameEngine {
  state: GameState
  turnHistory: TurnResult[] = []
  chatLog: ChatMessage[] = []
  recentEvents: GameEvent[] = []
  pendingAlliances: Set<string> = new Set()
  surpriseAttackBonus: Record<string, number> = {}
  /** Bumped by reset()/start(); a turn that started under an older generation is discarded. */
  generation = 0

  // --- Human vs AI session ---
  gameId: string | null = null
  humanFaction: FactionId | null = null
  playerName: string = GAME_CONFIG.defaultPlayerName
  phase: GamePhase = 'setup'
  aiStatus: AiStatus = 'idle'
  lastReport: TurnReport | null = null
  /** Counts how often each AI opponent has had to fall back this game. */
  fallbackCount = 0
  /**
   * Opponent orders already generated for the turn being played. If the human's
   * command is refused (not understood / interpreter down) the turn is rolled
   * back to the identical snapshot, so a retry reuses these instead of spending
   * two more model calls.
   */
  private opponentCache: { key: string; orders: Record<string, FactionOrders> } | null = null
  /** Unit id counter (Date.now() ids collided when one faction recruited twice in a millisecond). */
  private unitSeq = 100

  constructor() {
    this.state = this.loadWorld()
  }

  private loadWorld(): GameState {
    const raw = readFileSync(resolve(__dirname, '../game/initial-world.json'), 'utf-8')
    const state = JSON.parse(raw) as GameState
    state.game.maxTurns = GAME_CONFIG.maxTurns
    return state
  }

  /** Back to the faction-selection screen with a fresh world. Invalidates any turn in flight. */
  reset() {
    this.generation++
    this.state = this.loadWorld()
    this.turnHistory = []
    this.chatLog = []
    this.recentEvents = []
    this.pendingAlliances = new Set()
    this.surpriseAttackBonus = {}
    this.state.game.startedAt = new Date().toISOString()
    this.state.game.turn = 0
    this.state.game.status = 'active'
    this.state.game.victor = null
    this.gameId = null
    this.humanFaction = null
    this.playerName = GAME_CONFIG.defaultPlayerName
    this.phase = 'setup'
    this.aiStatus = 'idle'
    this.lastReport = null
    this.fallbackCount = 0
    this.opponentCache = null
    this.unitSeq = 100
    this.updateScores()
  }

  /** Start a new game with the player in command of `humanFaction`. The other two factions are AI. */
  start(playerName: string, humanFaction: FactionId): { gameId: string; turn: number } {
    this.reset()
    this.gameId = randomUUID()
    this.humanFaction = humanFaction
    this.playerName = playerName
    this.phase = 'waiting_for_player'
    const ai = FACTION_IDS.filter((f) => f !== humanFaction).map(factionLabel).join(' and ')
    this.addChat('command', 'gm', 'The Arbiter',
      `WAR GAMES INITIATED. ${factionLabel(humanFaction)} is under human command; ${ai} are controlled by AI. ${this.state.game.maxTurns} turns.`)
    console.log(`\n>>> New game ${this.gameId}: human=${humanFaction}, maxTurns=${this.state.game.maxTurns}`)
    return { gameId: this.gameId, turn: this.state.game.turn + 1 }
  }

  /** Everything the UI needs about the session. Contains no secrets and no model prompts. */
  sessionInfo() {
    const finished = this.state.game.status === 'finished'
    return {
      gameId: this.gameId,
      phase: this.phase,
      humanFaction: this.humanFaction,
      playerName: this.playerName,
      /** The turn awaiting orders, or the last turn played once finished. */
      turn: finished ? this.state.game.turn : this.state.game.turn + 1,
      maxTurns: this.state.game.maxTurns,
      maxCommandLength: GAME_CONFIG.maxCommandLength,
      maxOrdersPerTurn: GAME_CONFIG.maxOrdersPerTurn,
      aiStatus: this.aiStatus,
      outcome: outcomeFor(this.state, this.humanFaction) as Outcome | null,
      finalScore: eventScore(this.state, this.humanFaction),
      availableActions: this.humanFaction && this.phase === 'waiting_for_player' ? availableActions(this.state, this.humanFaction) : [],
      lastReport: this.lastReport,
    }
  }

  private addChat(channel: ChatMessage['channel'], agent: string, agentName: string, message: string) {
    this.chatLog.push({
      turn: this.state.game.turn,
      timestamp: new Date().toISOString(),
      agent,
      agentName,
      channel,
      message
    })
  }

  /**
   * The faction's view of the board: its own assets, what it can see (owned
   * and adjacent territory, plus allies' land), and per-unit legal moves.
   * Used for the AI opponents AND for the human command interpreter.
   */
  buildBriefing(factionId: string): string {
    const faction = this.state.factions[factionId]
    const visibleTerritories = this.getVisibleTerritories(factionId)
    const territoryStates: Record<string, unknown> = {}

    for (const tId of visibleTerritories) {
      const territory = this.state.map.territories[tId]
      const unitsHere: { id: string; type: string; owner: string }[] = []
      for (const [fid, f] of Object.entries(this.state.factions)) {
        for (const u of f.units) {
          if (u.territory === tId) unitsHere.push({ id: u.id, type: u.type, owner: fid })
        }
      }
      territoryStates[tId] = {
        name: territory.name,
        terrain: territory.terrain,
        continent: territory.continent,
        owner: territory.owner,
        fortified: territory.fortified,
        mercenaries: territory.mercenaries || 0,
        resources: territory.resources,
        units: unitsHere,
        adjacent: this.state.map.adjacency[tId]
      }
    }

    // Check continent control
    const continentControl: string[] = []
    for (const [contId, cont] of Object.entries(this.state.map.continents)) {
      if (cont.territories.every(t => this.state.map.territories[t]?.owner === factionId)) {
        continentControl.push(contId)
      }
    }

    // Build per-unit action hints so AI knows valid moves/attacks
    const unitActions: Record<string, { location: string; canMoveTo: string[]; canAttack: string[] }> = {}
    for (const unit of faction.units) {
      const adj = this.state.map.adjacency[unit.territory] || []
      const canMoveTo: string[] = []
      const canAttack: string[] = []
      for (const tId of adj) {
        const t = this.state.map.territories[tId]
        if (!t) continue
        // Can attack if enemy units or mercenaries are there
        const hasEnemyUnits = Object.entries(this.state.factions).some(([fid, f]) =>
          fid !== factionId && f.units.some(u => u.territory === tId)
        )
        const hasMercs = (t.mercenaries || 0) > 0 && t.owner !== factionId
        if (hasEnemyUnits || hasMercs) {
          canAttack.push(tId)
        }
        // Can move to if no enemy units (or empty)
        if (!hasEnemyUnits) {
          canMoveTo.push(tId)
        }
      }
      unitActions[unit.id] = { location: unit.territory, canMoveTo, canAttack }
    }

    const turn = this.state.game.turn
    const turnsLeft = this.state.game.maxTurns - turn + 1
    return JSON.stringify({
      turn,
      maxTurns: this.state.game.maxTurns,
      turnsRemaining: turnsLeft,
      urgency: turnsLeft <= 2 ? 'FINAL TURNS - act decisively!' : 'Short game - expand and strike early.',
      you: factionId,
      maxOrders: GAME_CONFIG.maxOrdersPerTurn,
      resources: faction.resources,
      tech: faction.tech,
      nukes: faction.nukes || 0,
      oathbreaker: faction.oathbreaker || false,
      units: faction.units,
      unitActions,
      territoryCount: faction.territoryCount,
      continentsControlled: continentControl,
      visibleMap: territoryStates,
      alliances: faction.alliances,
      victoryConditions: this.state.victoryConditions,
      recentEvents: this.turnHistory.slice(-2).flatMap(t => t.events.filter(e => e.faction === factionId || e.type === 'combat').map(e => e.description))
    })
  }

  private getVisibleTerritories(factionId: string): string[] {
    const visible = new Set<string>()
    const faction = this.state.factions[factionId]

    // Add owned territories and their neighbors
    for (const [tId, territory] of Object.entries(this.state.map.territories)) {
      if (territory.owner === factionId) {
        visible.add(tId)
        for (const adj of this.state.map.adjacency[tId] || []) {
          visible.add(adj)
        }
      }
    }

    // Add territories around units
    for (const unit of faction.units) {
      visible.add(unit.territory)
      for (const adj of this.state.map.adjacency[unit.territory] || []) {
        visible.add(adj)
      }
    }

    // Alliance shared vision
    for (const allyId of faction.alliances) {
      const ally = this.state.factions[allyId]
      if (!ally) continue
      for (const [tId, territory] of Object.entries(this.state.map.territories)) {
        if (territory.owner === allyId) visible.add(tId)
      }
    }

    return Array.from(visible)
  }

  /** Ids a faction's model reply may use: its own units, every territory, the other factions. */
  private vocabulary(factionId: string): OrderVocabulary {
    return {
      units: this.state.factions[factionId].units.map((u) => u.id),
      territories: Object.keys(this.state.map.territories),
      factions: FACTION_IDS.filter((f) => f !== factionId),
    }
  }

  private snapshot(): Snapshot {
    return {
      state: structuredClone(this.state),
      chatLength: this.chatLog.length,
      pendingAlliances: [...this.pendingAlliances],
      surpriseAttackBonus: { ...this.surpriseAttackBonus },
      unitSeq: this.unitSeq,
    }
  }

  private restore(s: Snapshot) {
    this.state = s.state
    this.chatLog.length = s.chatLength
    this.pendingAlliances = new Set(s.pendingAlliances)
    this.surpriseAttackBonus = s.surpriseAttackBonus
    this.unitSeq = s.unitSeq
  }

  /**
   * Factions act in a fixed rotation - turn 1: NATO, Russia, China; turn 2:
   * Russia, China, NATO; ... - so no faction (and so no choice of human faction)
   * always moves first. Within a faction, orders resolve in the order given.
   */
  resolutionOrder(turn: number): string[] {
    const ids = FACTION_IDS.filter((f) => this.state.factions[f])
    const k = (turn - 1) % ids.length
    return [...ids.slice(k), ...ids.slice(0, k)]
  }

  /** Advance the turn counter and pay income. Orders are gathered against the state this leaves. */
  private beginTurn(): number {
    this.state.game.turn++
    const turn = this.state.game.turn

    // Surprise attack bonuses last one turn
    for (const fid of Object.keys(this.surpriseAttackBonus)) {
      delete this.surpriseAttackBonus[fid]
    }

    this.addChat('command', 'gm', 'The Arbiter', `--- TURN ${turn} ---`)

    // Collect resources from owned territories
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      const foodCost = faction.units.length
      faction.resources.food -= foodCost
      if (faction.resources.food < 0) faction.resources.food = 0
      faction.resources.knowledge += 1

      // Territory resources
      for (const territory of Object.values(this.state.map.territories)) {
        if (territory.owner === factionId) {
          for (const [res, amount] of Object.entries(territory.resources)) {
            (faction.resources as Record<string, number>)[res] = ((faction.resources as Record<string, number>)[res] || 0) + amount
          }
        }
      }

      // Continent bonus
      for (const cont of Object.values(this.state.map.continents)) {
        if (cont.territories.every(t => this.state.map.territories[t]?.owner === factionId)) {
          for (const [res, amount] of Object.entries(cont.bonus)) {
            (faction.resources as Record<string, number>)[res] = ((faction.resources as Record<string, number>)[res] || 0) + amount
          }
        }
      }

      // Trade Networks (economic tech 1) - coastal territories produce +1 gold
      if (faction.tech.economic >= 1) {
        for (const territory of Object.values(this.state.map.territories)) {
          if (territory.owner === factionId && territory.terrain === 'coast') {
            faction.resources.gold += 1
          }
        }
      }

      // Central Banking (economic tech 2) - 10% interest on gold
      if (faction.tech.economic >= 2) {
        faction.resources.gold += Math.floor(faction.resources.gold * 0.1)
      }
    }
    return turn
  }

  private updateScores() {
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      faction.territoryCount = Object.values(this.state.map.territories).filter(t => t.owner === factionId).length
      faction.score = factionScore(this.state, factionId)
    }
  }

  /**
   * Resolve one turn's orders (already gathered) and close the turn: scores,
   * victory, turn limit, deterministic summary, history. Synchronous - nothing
   * here waits on a model.
   */
  private resolveTurn(
    allOrders: Record<string, FactionOrders>,
    opts: { strict?: Set<string>; human?: HumanTurnRecord; modelCalls?: ModelCallCount } = {}
  ): TurnResult {
    const turn = this.state.game.turn
    const events: GameEvent[] = []
    const order = this.resolutionOrder(turn)

    for (const factionId of order) {
      const factionOrders = allOrders[factionId]
      if (!factionOrders) continue
      const fName = this.state.factions[factionId].name
      const orders = factionOrders.orders.slice(0, GAME_CONFIG.maxOrdersPerTurn)
      const source = factionOrders.source ?? 'ai'
      const tag = source === 'fallback' ? ' [fallback strategy]' : source === 'quick' ? ' [quick strategy]' : ''
      if (orders.length === 0) {
        events.push({ type: 'forfeit', faction: factionId, description: `${fName} takes no action`, details: { actor: factionId } })
        this.addChat(factionId as ChatMessage['channel'], factionId, fName, `[No orders]${tag}`)
        continue
      }
      this.addChat(factionId as ChatMessage['channel'], factionId, fName,
        `Orders: ${orders.map(o => o.action).join(', ')}${factionOrders.summary ? ` — ${factionOrders.summary}` : ''}${tag}`)
      for (const o of orders) {
        const result = this.resolveOrder(factionId, o, opts.strict?.has(factionId) ?? false)
        if (result) {
          result.details = { ...(result.details || {}), actor: factionId }
          events.push(result)
        }
      }
    }

    this.updateScores()

    // Check victory
    const victor = this.checkVictory()
    if (victor) {
      this.state.game.status = 'finished'
      this.state.game.victor = victor.faction
      events.push({ type: 'victory', faction: victor.faction, description: `${this.state.factions[victor.faction].name} achieves ${victor.type} victory!` })
      this.addChat('command', 'gm', 'The Arbiter', `VICTORY: ${this.state.factions[victor.faction].name} wins by ${victor.type}!`)
    } else if (turn >= this.state.game.maxTurns) {
      this.state.game.status = 'finished'
      const best = Math.max(...Object.values(this.state.factions).map(f => f.score))
      const leaders = Object.entries(this.state.factions).filter(([, f]) => f.score === best).map(([id]) => id)
      if (leaders.length === 1) {
        this.state.game.victor = leaders[0]
        events.push({ type: 'victory', faction: leaders[0], description: `${this.state.factions[leaders[0]].name} wins by highest score (${best})!` })
      } else {
        // A shared top score is a draw - no faction is picked by iteration order.
        this.state.game.victor = null
        events.push({ type: 'victory', faction: leaders[0], description: `Draw: ${leaders.map(factionLabel).join(' and ')} tie on ${best} points` })
      }
    }

    const sources = Object.fromEntries(Object.entries(allOrders).map(([f, o]) => [f, o.source ?? 'ai'])) as Record<string, OrderSource>
    const summaries = Object.fromEntries(Object.entries(allOrders).map(([f, o]) => [f, o.summary ?? '']))
    const report = buildTurnReport(this.state, turn, events, order, sources, summaries, this.humanFaction, opts.human?.rejected ?? [])

    // Deterministic recap (replaces the old narrator model call)
    const eventSummary = events.filter(e => e.type !== 'invalid' && e.type !== 'forfeit').map(e => e.description).join('. ')
    this.addChat('command', 'gm', 'The Arbiter', eventSummary || 'A quiet turn — no significant events.')
    this.addChat('observer', 'narrator', 'Situation Report', report.headline)

    // Store recent events for map animation
    this.recentEvents = events
    this.lastReport = report

    const modelCalls = opts.modelCalls ?? { interpreter: 0, opponents: 0, narrator: 0, total: 0 }
    const turnResult: TurnResult = {
      turn,
      timestamp: new Date().toISOString(),
      resolutionOrder: order,
      orders: allOrders,
      events,
      headline: report.headline,
      ...(opts.human ? { human: opts.human } : {}),
      modelCalls,
    }
    this.turnHistory.push(turnResult)
    return turnResult
  }

  /**
   * Play one turn with the given orders for every faction, no model calls,
   * every faction resolved like an AI faction. For tests and tooling.
   */
  playOrders(orders: Record<string, Order[]>): TurnResult {
    this.beginTurn()
    const all: Record<string, FactionOrders> = {}
    for (const fid of Object.keys(this.state.factions)) all[fid] = { orders: orders[fid] ?? [], source: 'ai' }
    return this.resolveTurn(all)
  }

  /**
   * The Human vs AI turn: the player's submission drives everything.
   *
   *  1. Synchronous guards: right game, right turn, not already processing, not finished.
   *     The phase flips to processing_turn before the first await, so a double
   *     submit is refused rather than queued.
   *  2. Snapshot, then pay income and build briefings from that frozen state.
   *  3. In parallel: interpret the human's command (1 model call, or none for a
   *     quick strategy) and get each AI opponent's orders (1 call each, reused
   *     from cache when this turn is being retried). An opponent whose call fails
   *     gets the deterministic fallback planner instead.
   *  4. If the game was reset meanwhile, drop everything (StaleTurnError).
   *  5. Validate the human's orders. If the command was not understood or no
   *     order survives, roll back to the snapshot: the turn is not consumed.
   *  6. Resolve all three factions' orders, close the turn.
   */
  async submitCommand(req: CommandRequest): Promise<CommandResult> {
    if (!this.gameId || req.gameId !== this.gameId || !this.humanFaction) {
      throw new TurnRejectedError('stale_game', 409, 'This game is no longer active. Start a new game.')
    }
    if (this.phase === 'finished' || this.state.game.status === 'finished') {
      throw new TurnRejectedError('game_over', 409, 'The game is over. Start a new game to play again.')
    }
    if (this.phase === 'processing_turn') {
      throw new TurnRejectedError('turn_in_progress', 409, 'Orders for this turn are already being processed.')
    }
    if (req.turn !== this.state.game.turn + 1) {
      throw new TurnRejectedError('stale_turn', 409, 'Those orders were for a different turn.')
    }

    this.phase = 'processing_turn'
    this.aiStatus = 'thinking'
    const gen = this.generation
    const human = this.humanFaction
    const saved = this.snapshot()

    try {
      const turn = this.beginTurn()
      const frozen = this.state
      const calls: ModelCallCount = { interpreter: 0, opponents: 0, narrator: 0, total: 0 }
      const onRetry = () => { if (gen === this.generation) this.aiStatus = 'retrying' }

      // --- AI opponents ---
      const cacheKey = `${this.gameId}:${turn}`
      const cached = this.opponentCache?.key === cacheKey ? this.opponentCache.orders : null
      const opponents = FACTION_IDS.filter((f) => f !== human)
      const opponentJobs = opponents.map(async (fid): Promise<[string, FactionOrders]> => {
        if (cached?.[fid]) return [fid, cached[fid]]
        const briefing = this.buildBriefing(fid)
        calls.opponents++
        try {
          const o = await getOpponentOrders(fid, personas[fid], briefing, this.vocabulary(fid), onRetry)
          console.log(`[turn ${turn}] ${fid} (AI): ${o.orders.length} orders`)
          return [fid, { ...o, source: 'ai' }]
        } catch (err) {
          console.warn(`[turn ${turn}] ${fid} AI unavailable (${err instanceof Error ? err.message : String(err)}) - fallback strategy`)
          return [fid, { orders: planFallbackOrders(frozen, fid, FALLBACK_FOCUS[fid]), summary: 'Fallback strategy', source: 'fallback' }]
        }
      })

      // --- Human ---
      type HumanJob = { ok: true; understood: boolean; interpretation: string; warnings: string[]; orders: unknown[] } | { ok: false; error: string }
      let humanJob: Promise<HumanJob>
      if (req.quick) {
        humanJob = Promise.resolve({ ok: true, understood: true, interpretation: `Quick strategy: ${req.quick}`, warnings: [], orders: planFallbackOrders(frozen, human, req.quick) })
      } else {
        calls.interpreter++
        const names = Object.fromEntries(Object.entries(frozen.map.territories).map(([id, t]) => [id, t.name]))
        humanJob = interpretCommand(human, this.buildBriefing(human), names, req.command ?? '', this.vocabulary(human), onRetry)
          .then((i): HumanJob => ({ ok: true, ...i }))
          .catch((err): HumanJob => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      }

      const [humanResult, ...opponentResults] = await Promise.all([humanJob, ...opponentJobs])
      if (gen !== this.generation) throw new StaleTurnError(turn)
      calls.total = calls.interpreter + calls.opponents + calls.narrator
      const opponentOrders = Object.fromEntries(opponentResults)
      this.opponentCache = { key: cacheKey, orders: opponentOrders }

      if (!humanResult.ok) {
        console.warn(`[turn ${turn}] interpreter unavailable (${humanResult.error}) - turn not consumed`)
        this.logCalls(turn, calls, 'interpreter failed, rolled back')
        this.restore(saved)
        throw new TurnRejectedError('interpreter_unavailable', 503,
          'AI command interpreter temporarily unavailable. Your turn has not been consumed - try again, or pick a quick strategy.',
          { degraded: true })
      }

      const validation = validateOrders(frozen, human, humanResult.orders)
      const rejected = validation.rejected.map(r => r.reason)
      if (!req.quick && (!humanResult.understood || validation.accepted.length === 0)) {
        this.logCalls(turn, calls, 'no usable human orders, rolled back')
        this.restore(saved)
        throw new TurnRejectedError('not_understood', 422,
          humanResult.understood
            ? 'None of those orders are possible right now. Your turn has not been consumed.'
            : "I couldn't determine valid military orders. Your turn has not been consumed.",
          { interpretation: humanResult.interpretation, warnings: humanResult.warnings, rejected })
      }

      const accepted = validation.accepted.map(o => describeOrder(frozen, human, o))
      const humanRecord: HumanTurnRecord = {
        faction: human,
        command: req.quick ? null : (req.command ?? null),
        quick: req.quick ?? null,
        interpretation: humanResult.interpretation,
        warnings: humanResult.warnings,
        accepted,
        rejected,
      }
      const allOrders: Record<string, FactionOrders> = {
        ...opponentOrders,
        [human]: { orders: validation.accepted, summary: humanResult.interpretation, source: req.quick ? 'quick' : 'human' },
      }
      this.fallbackCount += Object.values(opponentOrders).filter(o => o.source === 'fallback').length

      const result = this.resolveTurn(allOrders, { strict: new Set([human]), human: humanRecord, modelCalls: calls })
      this.opponentCache = null
      this.phase = this.isFinished() ? 'finished' : 'waiting_for_player'
      this.logCalls(turn, calls, `resolved${this.phase === 'finished' ? ' - game over' : ''}`)

      return {
        turn: result.turn,
        interpretation: humanResult.interpretation,
        warnings: humanResult.warnings,
        accepted,
        rejected,
        report: this.lastReport!,
      }
    } catch (err) {
      if (err instanceof StaleTurnError) {
        // The game this turn belonged to is gone; leave the new game untouched.
        console.log(err.message)
        throw new TurnRejectedError('stale_game', 409, 'The game was reset while those orders were being processed.')
      }
      if (gen === this.generation && !(err instanceof TurnRejectedError)) {
        // Unexpected failure mid-turn: never leave a half-resolved turn behind.
        console.error('Turn error:', err)
        this.restore(saved)
        throw new TurnRejectedError('server_error', 500, 'Game server error. Please try again or restart the round.')
      }
      throw err
    } finally {
      if (gen === this.generation) {
        if (this.phase === 'processing_turn') this.phase = 'waiting_for_player'
        this.aiStatus = 'idle'
      }
    }
  }

  isFinished(): boolean {
    return this.state.game.status === 'finished'
  }

  private logCalls(turn: number, c: ModelCallCount, note: string) {
    console.log(`[turn ${turn}] model calls: interpreter=${c.interpreter} opponents=${c.opponents} narrator=${c.narrator} total=${c.total} (${note})`)
  }

  /**
   * Apply one order. AI factions get the original lenient handling (fuzzy unit
   * ids, a substitute unit that can reach the target). `strict` - used for the
   * human faction, whose orders were already validated - takes ids literally:
   * if the named unit was destroyed or moved earlier this turn, the order fails.
   */
  private resolveOrder(factionId: string, order: Order, strict = false): GameEvent | null {
    const faction = this.state.factions[factionId]
    const fName = faction.name

    switch (order.action) {
      case 'move': {
        // Accept to OR target field
        const moveTo = order.to || order.target
        // Find unit by exact ID or fuzzy match
        let unit = faction.units.find(u => u.id === order.unit)
        if (strict && !unit) return { type: 'invalid', faction: factionId, description: `${fName}: the unit ordered to move is no longer available` }
        if (!unit && order.unit) {
          unit = faction.units.find(u => u.id.includes(order.unit!) || order.unit!.includes(u.id))
        }
        // If no unit found, pick one that can reach the destination
        if (!unit && moveTo) {
          unit = faction.units.find(u => {
            const adj = this.state.map.adjacency[u.territory]
            return adj?.includes(moveTo)
          })
        }
        if (!unit || !moveTo) return { type: 'invalid', faction: factionId, description: `${fName}: invalid move - no unit or destination` }
        const adj = this.state.map.adjacency[unit.territory]
        if (!adj?.includes(moveTo)) {
          if (strict) return { type: 'invalid', faction: factionId, description: `${fName}: unit can no longer reach ${moveTo}` }
          // Try to find ANY unit that can reach
          const altUnit = faction.units.find(u => {
            const uAdj = this.state.map.adjacency[u.territory]
            return uAdj?.includes(moveTo)
          })
          if (altUnit) {
            unit = altUnit
          } else {
            return { type: 'invalid', faction: factionId, description: `${fName}: no units can reach ${moveTo}` }
          }
        }

        const oldTerritory = unit.territory
        unit.territory = moveTo

        const territory = this.state.map.territories[moveTo]
        if (territory && !territory.owner) {
          // Check for mercenary defenders
          if (territory.mercenaries && territory.mercenaries > 0) {
            const mercResult = this.resolveMercenaryCombat(factionId, unit, moveTo)
            return mercResult
          }
          territory.owner = factionId
          const tName = territory.name
          return { type: 'capture', faction: factionId, description: `${fName} captures neutral ${tName}`, from: oldTerritory, to: moveTo }
        } else if (territory && territory.owner && territory.owner !== factionId) {
          const defenders = this.getUnitsAtTerritory(moveTo).filter(u => u.owner !== factionId)
          if (defenders.length > 0) {
            return this.resolveCombat(factionId, unit, defenders[0].owner, defenders[0].unit, moveTo)
          } else {
            territory.owner = factionId
            const tName = territory.name
            return { type: 'capture', faction: factionId, description: `${fName} captures undefended ${tName}`, from: oldTerritory, to: moveTo }
          }
        }

        const tName = this.state.map.territories[moveTo]?.name || moveTo
        return { type: 'move', faction: factionId, description: `${fName} moves unit to ${tName}`, from: oldTerritory, to: moveTo }
      }

      case 'attack': {
        // Accept target OR to field (AI often confuses them)
        const attackTarget = order.target || order.to
        // Find unit by exact ID, or fuzzy match (AI sometimes drops prefix or uses wrong format)
        let unit = faction.units.find(u => u.id === order.unit)
        if (strict && !unit) return { type: 'invalid', faction: factionId, description: `${fName}: the unit ordered to attack is no longer available` }
        if (!unit && order.unit) {
          // Try partial match
          unit = faction.units.find(u => u.id.includes(order.unit!) || order.unit!.includes(u.id))
        }
        // If no unit specified or not found, pick closest unit that can reach the target
        if (!unit && attackTarget) {
          unit = faction.units.find(u => {
            const adj = this.state.map.adjacency[u.territory]
            return adj?.includes(attackTarget)
          })
        }
        if (!unit || !attackTarget) return { type: 'invalid', faction: factionId, description: `${fName}: invalid attack - no unit or target` }
        const attackFrom = unit.territory
        const adj = this.state.map.adjacency[unit.territory]
        if (!adj?.includes(attackTarget)) {
          if (strict) return { type: 'invalid', faction: factionId, description: `${fName}: unit can no longer reach ${attackTarget}` }
          // Try to find ANY unit that can reach the target
          const altUnit = faction.units.find(u => {
            const uAdj = this.state.map.adjacency[u.territory]
            return uAdj?.includes(attackTarget)
          })
          if (altUnit) {
            unit = altUnit
          } else {
            return { type: 'invalid', faction: factionId, description: `${fName}: no units adjacent to ${attackTarget}` }
          }
        }

        const defenders = this.getUnitsAtTerritory(attackTarget).filter(u => u.owner !== factionId)
        if (defenders.length === 0) {
          const territory = this.state.map.territories[attackTarget]
          // Check for mercenary defenders in neutral territory
          if (territory && !territory.owner && territory.mercenaries && territory.mercenaries > 0) {
            return this.resolveMercenaryCombat(factionId, unit, attackTarget)
          }
          unit.territory = attackTarget
          if (territory && territory.owner !== factionId) territory.owner = factionId
          const tName = territory?.name || attackTarget
          return { type: 'capture', faction: factionId, description: `${fName} takes undefended ${tName}`, from: attackFrom, to: attackTarget }
        }

        return this.resolveCombat(factionId, unit, defenders[0].owner, defenders[0].unit, attackTarget)
      }

      case 'fortify': {
        const tId = order.territory
        if (!tId) return { type: 'invalid', faction: factionId, description: `${fName}: invalid fortify` }
        const territory = this.state.map.territories[tId]
        if (!territory || territory.owner !== factionId) return { type: 'invalid', faction: factionId, description: `${fName}: can't fortify ${tId}` }
        if (faction.resources.iron < FORTIFY_IRON_COST) return { type: 'invalid', faction: factionId, description: `${fName}: not enough iron to fortify` }
        faction.resources.iron -= FORTIFY_IRON_COST
        territory.fortified = true
        return { type: 'fortify', faction: factionId, description: `${fName} fortifies ${territory.name}`, to: tId }
      }

      case 'recruit': {
        const unitType = order.type || 'infantry'
        if (!isUnitType(unitType)) return { type: 'invalid', faction: factionId, description: `${fName}: unknown unit type ${unitType}` }
        const stats = UNIT_STATS[unitType]
        if (faction.resources.gold < stats.cost.gold || faction.resources.iron < stats.cost.iron) {
          return { type: 'invalid', faction: factionId, description: `${fName}: can't afford ${unitType}` }
        }
        if (faction.tech.military < UNIT_TECH_REQUIRED[unitType]) {
          return { type: 'invalid', faction: factionId, description: `${fName}: ${unitType === 'armor' ? 'mechanized infantry' : 'precision strike'} not researched` }
        }

        // Units are raised only in territory the faction owns (game/rules.md). An AI
        // order with no territory defaults to an owned territory, preferring one it has troops in.
        const owned = (id: string | undefined) => !!id && this.state.map.territories[id]?.owner === factionId
        const requested = order.territory || order.to || order.target
        const tId = requested ?? (strict ? undefined : (faction.units.find(u => owned(u.territory))?.territory ??
          Object.keys(this.state.map.territories).find(owned)))
        if (!tId) return { type: 'invalid', faction: factionId, description: `${fName}: no territory for recruitment` }
        if (!owned(tId)) return { type: 'invalid', faction: factionId, description: `${fName}: can only recruit in its own territory (${tId})` }

        faction.resources.gold -= stats.cost.gold
        faction.resources.iron -= stats.cost.iron
        const newUnit: Unit = { id: `${factionId}-${UNIT_ID_PREFIX[unitType]}-${++this.unitSeq}`, type: unitType, territory: tId, hp: 2, xp: 0 }
        faction.units.push(newUnit)
        const tName = this.state.map.territories[tId]?.name || tId
        return { type: 'recruit', faction: factionId, description: `${fName} recruits ${unitType} at ${tName}`, to: tId }
      }

      case 'research': {
        const tech = order.tech
        if (!isTechId(tech)) {
          return { type: 'invalid', faction: factionId, description: `${fName}: invalid research target` }
        }
        const currentLevel = faction.tech[tech]
        const cost = researchCost(tech, currentLevel)
        if (!cost) return { type: 'invalid', faction: factionId, description: `${fName}: ${tech} already maxed` }

        // Nuclear tech has special costs (knowledge + uranium)
        if (faction.resources.knowledge < cost.knowledge) return { type: 'invalid', faction: factionId, description: `${fName}: not enough knowledge for ${tech} research` }
        if (faction.resources.uranium < cost.uranium) return { type: 'invalid', faction: factionId, description: `${fName}: not enough uranium for nuclear research` }
        faction.resources.knowledge -= cost.knowledge
        faction.resources.uranium -= cost.uranium

        ;(faction.tech as Record<string, number>)[tech] = currentLevel + 1
        return { type: 'research', faction: factionId, description: `${fName} researches ${tech} level ${currentLevel + 1}`, to: faction.units[0]?.territory }
      }

      case 'spy': {
        if (!order.target || !this.state.map.territories[order.target]) return { type: 'invalid', faction: factionId, description: `${fName}: unknown spy target` }
        const cost = spyCost(faction.tech.intelligence)
        if (faction.resources.influence < cost) return { type: 'invalid', faction: factionId, description: `${fName}: not enough influence to spy` }
        faction.resources.influence -= cost
        return { type: 'spy', faction: factionId, description: `${fName} sends spies to ${this.state.map.territories[order.target].name}`, to: order.target }
      }

      case 'trade': {
        if (!order.to || !order.offer) return { type: 'invalid', faction: factionId, description: `${fName}: invalid trade` }
        const target = this.state.factions[order.to]
        if (!target || order.to === factionId) return { type: 'invalid', faction: factionId, description: `${fName}: unknown trade target` }

        // Check the whole offer before moving anything: whole positive amounts of
        // real resources only (a negative "offer" used to take from the target).
        const offer = Object.entries(order.offer)
        const fRes = faction.resources as Record<string, number>
        if (offer.length === 0) return { type: 'invalid', faction: factionId, description: `${fName}: invalid trade` }
        for (const [res, amount] of offer) {
          if (!(RESOURCE_IDS as string[]).includes(res) || !Number.isInteger(amount) || amount <= 0) {
            return { type: 'invalid', faction: factionId, description: `${fName}: invalid trade` }
          }
          if ((fRes[res] || 0) < amount) return { type: 'invalid', faction: factionId, description: `${fName}: can't afford trade` }
        }
        for (const [res, amount] of offer) {
          fRes[res] -= amount;
          (target.resources as Record<string, number>)[res] = ((target.resources as Record<string, number>)[res] || 0) + amount
        }

        this.addChat('diplomacy', factionId, fName, `Sends ${JSON.stringify(order.offer)} to ${target.name}`)
        return { type: 'trade', faction: factionId, description: `${fName} trades ${JSON.stringify(order.offer)} to ${target.name}` }
      }

      case 'diplomacy': {
        if (!order.to || !order.proposal) return { type: 'invalid', faction: factionId, description: `${fName}: invalid diplomacy` }
        if (order.proposal === 'alliance') {
          const target = this.state.factions[order.to]
          if (!target) return { type: 'invalid', faction: factionId, description: `${fName}: unknown faction ${order.to}` }
          // Oathbreakers cannot form alliances
          if (faction.oathbreaker) return { type: 'invalid', faction: factionId, description: `${fName}: marked as Oathbreaker — no faction will accept your alliance` }
          if (target.oathbreaker) return { type: 'invalid', faction: factionId, description: `${fName}: ${target.name} is an Oathbreaker — alliance refused` }
          // Alliance requires mutual proposal — track pending proposals
          const pendingKey = `${factionId}->${order.to}`
          const reverseKey = `${order.to}->${factionId}`
          this.pendingAlliances.add(pendingKey)

          if (this.pendingAlliances.has(reverseKey)) {
            // Both sides have proposed — form the alliance
            if (!faction.alliances.includes(order.to)) faction.alliances.push(order.to)
            if (!target.alliances.includes(factionId)) target.alliances.push(factionId)
            this.pendingAlliances.delete(pendingKey)
            this.pendingAlliances.delete(reverseKey)
            this.addChat('diplomacy', factionId, fName, `Alliance formed with ${target.name}!`)
            return { type: 'diplomacy', faction: factionId, description: `${fName} and ${target.name} form an alliance!` }
          } else {
            this.addChat('diplomacy', factionId, fName, `Proposes alliance with ${target.name}`)
            return { type: 'diplomacy', faction: factionId, description: `${fName} proposes alliance with ${target.name}` }
          }
        }
        return { type: 'diplomacy', faction: factionId, description: `${fName} proposes ${order.proposal} with ${this.state.factions[order.to]?.name || order.to}` }
      }

      case 'build_nuke': {
        if (faction.tech.nuclear < 1) return { type: 'invalid', faction: factionId, description: `${fName}: nuclear tech not researched` }
        const { gold: nukeCostGold, uranium: nukeCostUranium } = nukeBuildCost(faction.tech.nuclear)
        if (faction.resources.gold < nukeCostGold || faction.resources.uranium < nukeCostUranium) {
          return { type: 'invalid', faction: factionId, description: `${fName}: can't afford nuclear warhead (need ${nukeCostGold}g + ${nukeCostUranium}u)` }
        }
        faction.resources.gold -= nukeCostGold
        faction.resources.uranium -= nukeCostUranium
        faction.nukes = (faction.nukes || 0) + 1

        // Deterrence effect at nuclear level 3: other factions lose influence
        if (faction.tech.nuclear >= 3) {
          for (const [otherId, otherFaction] of Object.entries(this.state.factions)) {
            if (otherId !== factionId) {
              otherFaction.resources.influence = Math.max(0, otherFaction.resources.influence - 5)
            }
          }
        }

        this.addChat('command', 'gm', 'The Arbiter', `NUCLEAR ALERT: ${fName} has built a nuclear warhead!`)
        return { type: 'build_nuke', faction: factionId, description: `${fName} builds a nuclear warhead! (arsenal: ${faction.nukes})`, to: faction.units[0]?.territory }
      }

      case 'nuke': {
        if (!faction.nukes || faction.nukes < 1) return { type: 'invalid', faction: factionId, description: `${fName}: no nuclear warheads available` }
        const targetTId = order.target
        if (!targetTId) return { type: 'invalid', faction: factionId, description: `${fName}: invalid nuke target` }
        const targetTerritory = this.state.map.territories[targetTId]
        if (!targetTerritory) return { type: 'invalid', faction: factionId, description: `${fName}: unknown territory ${targetTId}` }

        // Without ICBM tech (nuclear >= 2), can only nuke adjacent territories
        if (faction.tech.nuclear < 2) {
          const ownedTerritories = Object.entries(this.state.map.territories)
            .filter(([_, t]) => t.owner === factionId)
            .map(([id]) => id)
          const adjacentToOwned = new Set<string>()
          for (const ownedT of ownedTerritories) {
            for (const adj of this.state.map.adjacency[ownedT] || []) {
              adjacentToOwned.add(adj)
            }
          }
          if (!adjacentToOwned.has(targetTId)) {
            return { type: 'invalid', faction: factionId, description: `${fName}: ${targetTId} not in range (need ICBM tech)` }
          }
        }

        // Can't nuke your own territory
        if (targetTerritory.owner === factionId) {
          return { type: 'invalid', faction: factionId, description: `${fName}: can't nuke your own territory` }
        }

        faction.nukes--

        const tName = targetTerritory.name
        const targetOwner = targetTerritory.owner

        // Destroy ALL units in the territory
        for (const f of Object.values(this.state.factions)) {
          f.units = f.units.filter(u => u.territory !== targetTId)
        }

        // Remove fortification and set territory to irradiated (no owner, no resources for 5 turns)
        targetTerritory.fortified = false
        targetTerritory.owner = null
        // Saved but never restored - see TODO.md ("irradiated for 5 turns")
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const originalResources = { ...targetTerritory.resources }
        targetTerritory.resources = {}

        this.addChat('command', 'gm', 'The Arbiter', `NUCLEAR STRIKE: ${fName} launches a nuclear warhead at ${tName}! All units destroyed. Territory irradiated.`)
        this.addChat('diplomacy', factionId, fName, `We have unleashed nuclear fire upon ${tName}. Let this be a warning.`)

        // Second Strike retaliation check
        if (targetOwner && targetOwner !== factionId) {
          const defender = this.state.factions[targetOwner]
          if (defender && defender.tech.nuclear >= 3 && defender.nukes > 0) {
            // Auto-retaliate against a random attacker territory
            const attackerTerritories = Object.entries(this.state.map.territories)
              .filter(([_, t]) => t.owner === factionId)
            if (attackerTerritories.length > 0) {
              const [retaliationTId, retaliationTerritory] = attackerTerritories[Math.floor(Math.random() * attackerTerritories.length)]
              defender.nukes--
              // Destroy units in retaliation territory
              for (const f of Object.values(this.state.factions)) {
                f.units = f.units.filter(u => u.territory !== retaliationTId)
              }
              retaliationTerritory.fortified = false
              retaliationTerritory.owner = null
              retaliationTerritory.resources = {}
              this.addChat('command', 'gm', 'The Arbiter', `SECOND STRIKE: ${defender.name} retaliates with a nuclear strike on ${retaliationTerritory.name}!`)
            }
          }
        }

        return {
          type: 'nuke',
          faction: factionId,
          description: `${fName} NUKES ${tName}! All units destroyed, territory irradiated.`,
          from: Object.entries(this.state.map.territories).find(([_, t]) => t.owner === factionId)?.[0],
          to: targetTId
        }
      }

      case 'break_alliance': {
        if (!order.to) return { type: 'invalid', faction: factionId, description: `${fName}: invalid break_alliance` }
        const allyIndex = faction.alliances.indexOf(order.to)
        if (allyIndex === -1) return { type: 'invalid', faction: factionId, description: `${fName}: no alliance with ${order.to} to break` }

        // Remove alliance from both sides
        faction.alliances.splice(allyIndex, 1)
        const target = this.state.factions[order.to]
        if (target) {
          const reverseIndex = target.alliances.indexOf(factionId)
          if (reverseIndex !== -1) target.alliances.splice(reverseIndex, 1)
        }

        // Mark as oathbreaker permanently — no future alliances
        faction.oathbreaker = true
        // Grant surprise attack bonus for this turn
        this.surpriseAttackBonus[factionId] = 3

        this.addChat('diplomacy', factionId, fName, `BETRAYAL! ${fName} breaks their alliance with ${target?.name || order.to}!`)
        this.addChat('command', 'gm', 'The Arbiter', `OATHBREAKER: ${fName} has broken their alliance with ${target?.name || order.to}!`)
        return { type: 'betrayal', faction: factionId, description: `${fName} BETRAYS ${target?.name || order.to}! Alliance broken. Surprise attack bonus granted.`, to: faction.units[0]?.territory, details: { targetFaction: order.to } }
      }

      case 'message': {
        const msg = cleanText(order.message, GAME_CONFIG.maxMessageLength)
        if (!msg) return { type: 'invalid', faction: factionId, description: `${fName}: empty message` }
        this.addChat('diplomacy', factionId, fName, msg)
        return { type: 'message', faction: factionId, description: `${fName} sends a diplomatic message` }
      }

      case 'hire_mercenary': {
        const tId = order.territory
        if (!tId) return { type: 'invalid', faction: factionId, description: `${fName}: invalid hire_mercenary — no territory` }
        const territory = this.state.map.territories[tId]
        if (!territory) return { type: 'invalid', faction: factionId, description: `${fName}: unknown territory ${tId}` }
        if (!territory.mercenaries || territory.mercenaries < 1) return { type: 'invalid', faction: factionId, description: `${fName}: no mercenaries in ${territory.name}` }

        // Must be adjacent to owned territory or have a unit there
        const hasAccess = faction.units.some(u => u.territory === tId) ||
          Object.entries(this.state.map.territories).some(([tid, t]) =>
            t.owner === factionId && (this.state.map.adjacency[tid] || []).includes(tId)
          )
        if (!hasAccess) return { type: 'invalid', faction: factionId, description: `${fName}: no access to ${territory.name} to hire mercenaries` }

        const hireCost = MERCENARY_GOLD_COST
        if (faction.resources.gold < hireCost) return { type: 'invalid', faction: factionId, description: `${fName}: not enough gold to hire mercenary (need ${hireCost})` }

        faction.resources.gold -= hireCost
        territory.mercenaries--
        const mercUnit: Unit = { id: `${factionId}-merc-${++this.unitSeq}`, type: 'infantry', territory: tId, hp: 2, xp: 0 }
        faction.units.push(mercUnit)

        // Claim the territory if neutral
        if (!territory.owner) territory.owner = factionId

        const tName = territory.name
        return { type: 'hire_mercenary', faction: factionId, description: `${fName} hires a mercenary at ${tName}`, to: tId }
      }

      default:
        return { type: 'invalid', faction: factionId, description: `${fName}: unknown action ${order.action}` }
    }
  }

  private getUnitsAtTerritory(tId: string): { owner: string; unit: Unit }[] {
    const results: { owner: string; unit: Unit }[] = []
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      for (const unit of faction.units) {
        if (unit.territory === tId) results.push({ owner: factionId, unit })
      }
    }
    return results
  }

  private resolveCombat(attackerId: string, attackerUnit: Unit, defenderId: string, defenderUnit: Unit, tId: string): GameEvent {
    const attackerFaction = this.state.factions[attackerId]
    const defenderFaction = this.state.factions[defenderId]
    const territory = this.state.map.territories[tId]
    const tName = territory?.name || tId
    const attackerFrom = attackerUnit.territory

    const aStats = UNIT_STATS[attackerUnit.type]
    const dStats = UNIT_STATS[defenderUnit.type]
    const terrainBonus = TERRAIN_DEFENSE[territory.terrain] || 0
    // Precision Strike (military tech 2): artillery ignores fortification
    const artilleryBypass = attackerUnit.type === 'artillery' && attackerFaction.tech.military >= 2
    const fortBonus = (territory.fortified && !artilleryBypass) ? 2 : 0

    const xpBonus = (unit: Unit) => Math.floor((unit.xp || 0) / 1) // +1 attack per XP
    const surpriseBonus = this.surpriseAttackBonus[attackerId] || 0

    // Combined Arms Doctrine (military tech 3): +1 attack, veterans get +1 defense
    const attackStrength = aStats.attack + (attackerFaction.tech.military >= 3 ? 1 : 0) + xpBonus(attackerUnit) + surpriseBonus
    const veteranDefBonus = (defenderFaction.tech.military >= 3 && defenderUnit.xp > 0) ? 1 : 0
    const defendStrength = dStats.defense + terrainBonus + fortBonus + (defenderFaction.tech.military >= 3 ? 1 : 0) + veteranDefBonus + xpBonus(defenderUnit)

    const roll = Math.floor(Math.random() * 6) + 1 + (attackStrength - defendStrength)

    if (roll >= 7) {
      defenderUnit.hp -= 2
      if (defenderUnit.hp <= 0) {
        defenderFaction.units = defenderFaction.units.filter(u => u.id !== defenderUnit.id)
      } else {
        const retreatTerritory = (this.state.map.adjacency[tId] || []).find(t => this.state.map.territories[t]?.owner === defenderId)
        if (retreatTerritory) defenderUnit.territory = retreatTerritory
        else defenderFaction.units = defenderFaction.units.filter(u => u.id !== defenderUnit.id)
      }
      attackerUnit.territory = tId
      territory.owner = attackerId
      territory.fortified = false
      // Attacker gains XP for winning
      if (attackerUnit.hp > 0) attackerUnit.xp = (attackerUnit.xp || 0) + 1
      return { type: 'combat', faction: attackerId, description: `${attackerFaction.name} defeats ${defenderFaction.name} at ${tName}! (roll: ${roll})`, from: attackerFrom, to: tId }
    } else if (roll >= 4) {
      attackerUnit.hp -= 1
      defenderUnit.hp -= 1
      if (attackerUnit.hp <= 0) attackerFaction.units = attackerFaction.units.filter(u => u.id !== attackerUnit.id)
      else attackerUnit.xp = (attackerUnit.xp || 0) + 1
      if (defenderUnit.hp <= 0) defenderFaction.units = defenderFaction.units.filter(u => u.id !== defenderUnit.id)
      else defenderUnit.xp = (defenderUnit.xp || 0) + 1
      return { type: 'combat', faction: attackerId, description: `Battle at ${tName}: ${attackerFaction.name} vs ${defenderFaction.name} — draw!`, to: tId }
    } else {
      attackerUnit.hp -= 2
      if (attackerUnit.hp <= 0) {
        attackerFaction.units = attackerFaction.units.filter(u => u.id !== attackerUnit.id)
      }
      // Defender gains XP for repelling
      defenderUnit.xp = (defenderUnit.xp || 0) + 1
      return { type: 'combat', faction: defenderId, description: `${defenderFaction.name} repels ${attackerFaction.name} at ${tName}!`, to: tId }
    }
  }

  private resolveMercenaryCombat(attackerId: string, attackerUnit: Unit, tId: string): GameEvent {
    const attackerFaction = this.state.factions[attackerId]
    const territory = this.state.map.territories[tId]
    const tName = territory?.name || tId
    const attackFrom = attackerUnit.territory

    const aStats = UNIT_STATS[attackerUnit.type]
    const terrainBonus = TERRAIN_DEFENSE[territory.terrain] || 0
    const xpBonus = Math.floor((attackerUnit.xp || 0) / 1)
    const surpriseBonus = this.surpriseAttackBonus[attackerId] || 0

    // Mercenaries fight as infantry
    const mercDefense = UNIT_STATS.infantry.defense + terrainBonus
    const attackStrength = aStats.attack + (attackerFaction.tech.military >= 3 ? 1 : 0) + xpBonus + surpriseBonus

    const roll = Math.floor(Math.random() * 6) + 1 + (attackStrength - mercDefense)

    if (roll >= 5) {
      // Attacker wins — clear mercenaries, capture territory
      territory.mercenaries = 0
      attackerUnit.territory = tId
      territory.owner = attackerId
      attackerUnit.xp = (attackerUnit.xp || 0) + 1
      return { type: 'combat', faction: attackerId, description: `${attackerFaction.name} defeats mercenaries at ${tName}!`, from: attackFrom, to: tId }
    } else if (roll >= 3) {
      // Partial — kill some mercenaries but take damage
      territory.mercenaries = Math.max(0, territory.mercenaries - 1)
      attackerUnit.hp -= 1
      if (attackerUnit.hp <= 0) {
        attackerFaction.units = attackerFaction.units.filter(u => u.id !== attackerUnit.id)
        return { type: 'combat', faction: attackerId, description: `${attackerFaction.name} fights mercenaries at ${tName} — mutual destruction!`, to: tId }
      }
      attackerUnit.xp = (attackerUnit.xp || 0) + 1
      return { type: 'combat', faction: attackerId, description: `${attackerFaction.name} clashes with mercenaries at ${tName} — both sides take losses`, to: tId }
    } else {
      // Attacker repelled
      attackerUnit.hp -= 1
      if (attackerUnit.hp <= 0) {
        attackerFaction.units = attackerFaction.units.filter(u => u.id !== attackerUnit.id)
      }
      return { type: 'combat', faction: attackerId, description: `Mercenaries at ${tName} repel ${attackerFaction.name}!`, to: tId }
    }
  }

  private checkVictory(): { faction: string; type: string } | null {
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      // Domination
      if (faction.territoryCount >= this.state.victoryConditions.domination.territoriesRequired) {
        return { faction: factionId, type: 'domination' }
      }
      // Economic
      let coastCount = 0
      for (const territory of Object.values(this.state.map.territories)) {
        if (territory.owner === factionId && territory.terrain === 'coast') coastCount++
      }
      if (faction.resources.gold >= this.state.victoryConditions.economic.goldRequired && coastCount >= this.state.victoryConditions.economic.coastTerritoriesRequired) {
        return { faction: factionId, type: 'economic' }
      }
      // Diplomatic (must hold alliances for minimum turns)
      if (faction.alliances.length >= this.state.victoryConditions.diplomatic.alliancesRequired &&
          this.state.game.turn >= this.state.victoryConditions.diplomatic.turnsRequired) {
        return { faction: factionId, type: 'diplomatic' }
      }
    }
    return null
  }
}
