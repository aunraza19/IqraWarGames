export interface Territory {
  name: string
  terrain: 'plains' | 'mountains' | 'coast'
  continent: string
  lat: number
  lng: number
  owner: string | null
  fortified: boolean
  resources: Record<string, number>
  mercenaries: number
}

export interface Unit {
  id: string
  type: 'infantry' | 'armor' | 'artillery'
  territory: string
  hp: number
  xp: number
}

export interface Faction {
  name: string
  agent: string
  resources: { gold: number; food: number; iron: number; influence: number; knowledge: number; uranium: number }
  units: Unit[]
  tech: { military: number; economic: number; intelligence: number; nuclear: number }
  nukes: number
  oathbreaker: boolean
  alliances: string[]
  pacts: string[]
  territoryCount: number
  score: number
}

export interface ContinentBonus {
  name: string
  bonus: Record<string, number>
  territories: string[]
}

export interface GameState {
  game: {
    name: string
    turn: number
    maxTurns: number
    status: 'active' | 'finished'
    startedAt: string | null
    victor: string | null
  }
  map: {
    territories: Record<string, Territory>
    adjacency: Record<string, string[]>
    continents: Record<string, ContinentBonus>
  }
  factions: Record<string, Faction>
  victoryConditions: {
    domination: { territoriesRequired: number }
    economic: { goldRequired: number; coastTerritoriesRequired: number }
    diplomatic: { alliancesRequired: number; turnsRequired: number }
  }
}

export interface Order {
  action: string
  unit?: string
  to?: string
  target?: string
  territory?: string
  type?: string
  cost?: Record<string, number>
  offer?: Record<string, number>
  request?: Record<string, number>
  tech?: string
  proposal?: string
  duration?: number
  message?: string
}

/**
 * Who produced a faction's orders this turn:
 *   human    - the player's natural-language command, via the interpreter
 *   quick    - the player's quick-strategy button (interpreter unavailable)
 *   ai       - an AI opponent's model reply
 *   fallback - the deterministic planner, after an AI opponent's call failed
 */
export type OrderSource = 'human' | 'quick' | 'ai' | 'fallback'

export interface FactionOrders {
  orders: Order[]
  /** One short public sentence about the plan. Never hidden reasoning. */
  summary?: string
  source?: OrderSource
}

/** Model calls made to resolve one turn (logged, recorded in history, asserted in tests). */
export interface ModelCallCount {
  interpreter: number
  opponents: number
  narrator: number
  total: number
}

/** What the human asked for and what came of it - compact, no prompts or raw model output. */
export interface HumanTurnRecord {
  faction: string
  command: string | null
  quick: string | null
  interpretation: string
  warnings: string[]
  accepted: string[]
  rejected: string[]
}

export interface TurnResult {
  turn: number
  timestamp: string
  resolutionOrder: string[]
  orders: Record<string, FactionOrders>
  events: GameEvent[]
  headline: string
  human?: HumanTurnRecord
  modelCalls: ModelCallCount
}

export interface GameEvent {
  type: 'move' | 'attack' | 'fortify' | 'recruit' | 'trade' | 'spy' | 'research' | 'diplomacy' | 'combat' | 'capture' | 'victory' | 'forfeit' | 'invalid' | 'nuke' | 'build_nuke' | 'betrayal' | 'message' | 'hire_mercenary'
  faction: string
  description: string
  from?: string
  to?: string
  details?: Record<string, unknown>
}

export interface ChatMessage {
  turn: number
  timestamp: string
  agent: string
  agentName: string
  channel: 'command' | 'nato' | 'russia' | 'china' | 'diplomacy' | 'observer'
  message: string
}
