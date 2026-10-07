// Re-export server types for frontend use (keep in sync)
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

export interface GameEvent {
  type: string
  faction: string
  description: string
  from?: string
  to?: string
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
  recentEvents?: GameEvent[]
  session?: Session
}

export interface ChatMessage {
  turn: number
  timestamp: string
  agent: string
  agentName: string
  channel: string
  message: string
}

export type FactionId = 'nato' | 'russia' | 'china'
export type GamePhase = 'setup' | 'waiting_for_player' | 'processing_turn' | 'finished'
export type OrderSource = 'human' | 'quick' | 'ai' | 'fallback'

export interface ReportLine {
  ok: boolean
  text: string
}

export interface FactionReport {
  faction: FactionId
  label: string
  controller: OrderSource
  summary: string
  lines: ReportLine[]
}

export interface TurnReport {
  turn: number
  headline: string
  factions: FactionReport[]
}

/** The Human vs AI session, as served by GET /api/state. */
export interface Session {
  gameId: string | null
  phase: GamePhase
  humanFaction: FactionId | null
  playerName: string
  turn: number
  maxTurns: number
  maxCommandLength: number
  maxOrdersPerTurn: number
  aiStatus: 'idle' | 'thinking' | 'retrying'
  outcome: 'victory' | 'defeat' | 'draw' | null
  finalScore: number | null
  availableActions: string[]
  lastReport: TurnReport | null
}

/** Body of a successful POST /api/player-command. */
export interface CommandResponse {
  status: 'resolved'
  turn: number
  interpretation: string
  warnings: string[]
  accepted: string[]
  rejected: string[]
  report: TurnReport
  session: Session
}

/** Body of a refused POST /api/player-command. */
export interface CommandError {
  error: string
  code: string
  degraded?: boolean
  interpretation?: string
  warnings?: string[]
  rejected?: string[]
}
