/**
 * Order normalisation and legality checks for orders that came from a model
 * acting for the HUMAN faction (and from the deterministic fallback planner).
 *
 * The turn resolver in engine.ts stays the authority on outcomes - it re-checks
 * costs and positions as it applies each order. This module runs first, against
 * the same state the briefing was built from, and decides which proposed orders
 * are allowed to reach the resolver at all:
 *
 *   - only actions the engine implements, only the acting faction's own units
 *   - ids must exist exactly (no fuzzy matching, no invented units or territories)
 *   - adjacency, ownership, tech gates and costs are checked
 *   - costs are tracked across the whole order list, so "recruit armor twice"
 *     with money for one keeps the first and rejects the second
 *   - one order per unit per turn, and at most `maxOrders` orders
 *
 * Rejections carry a short, player-readable reason using display names.
 */

import type { GameState, Order } from './types.js'
import { GAME_CONFIG, FACTION_IDS } from './config.js'
import {
  FORTIFY_IRON_COST,
  MERCENARY_GOLD_COST,
  RESOURCE_IDS,
  UNIT_STATS,
  UNIT_TECH_REQUIRED,
  isTechId,
  isUnitType,
  nukeBuildCost,
  researchCost,
  spyCost,
  type ResourceId,
} from './rules.js'

/** Every action the turn resolver implements. Anything else is rejected. */
export const ORDER_ACTIONS = [
  'move',
  'attack',
  'fortify',
  'recruit',
  'research',
  'spy',
  'trade',
  'diplomacy',
  'break_alliance',
  'message',
  'hire_mercenary',
  'build_nuke',
  'nuke',
] as const
export type OrderAction = (typeof ORDER_ACTIONS)[number]

export interface RejectedOrder {
  action: string
  reason: string
}

export interface ValidationResult {
  accepted: Order[]
  rejected: RejectedOrder[]
}

export const UNIT_LABEL: Record<string, string> = { infantry: 'Infantry', armor: 'Armor', artillery: 'Artillery' }

/** Strip control characters and collapse whitespace; used for any free text a model or player supplies. */
export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s ? s.slice(0, 80) : undefined
}

/**
 * Reduce an untrusted object to the canonical Order shape for its action,
 * dropping every field that action does not use. Returns null when the input
 * is not an object or names no known action.
 */
export function normalizeOrder(raw: unknown): Order | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const action = str(r.action)?.toLowerCase()
  if (!action || !(ORDER_ACTIONS as readonly string[]).includes(action)) return null

  switch (action as OrderAction) {
    case 'move':
      return { action, unit: str(r.unit), to: str(r.to) ?? str(r.target) }
    case 'attack':
      return { action, unit: str(r.unit), target: str(r.target) ?? str(r.to) }
    case 'fortify':
    case 'hire_mercenary':
      return { action, territory: str(r.territory) ?? str(r.target) ?? str(r.to) }
    case 'recruit':
      return { action, type: str(r.type)?.toLowerCase(), territory: str(r.territory) ?? str(r.to) }
    case 'research':
      return { action, tech: str(r.tech)?.toLowerCase() }
    case 'spy':
    case 'nuke':
      return { action, target: str(r.target) ?? str(r.to) ?? str(r.territory) }
    case 'trade': {
      const offer: Record<string, number> = {}
      if (r.offer && typeof r.offer === 'object' && !Array.isArray(r.offer)) {
        for (const [k, v] of Object.entries(r.offer as Record<string, unknown>)) {
          if (typeof v === 'number') offer[k] = v
        }
      }
      return { action, to: str(r.to)?.toLowerCase(), offer }
    }
    case 'diplomacy':
      return { action, to: str(r.to)?.toLowerCase(), proposal: str(r.proposal)?.toLowerCase() ?? 'alliance' }
    case 'break_alliance':
      return { action, to: str(r.to)?.toLowerCase() }
    case 'message': {
      const to = str(r.to)?.toLowerCase()
      return { action, message: cleanText(r.message, GAME_CONFIG.maxMessageLength), ...(to ? { to } : {}) }
    }
    case 'build_nuke':
      return { action }
  }
}

/** Display name for a territory id (falls back to the id). */
export function territoryName(state: GameState, id: string | undefined): string {
  if (!id) return 'an unknown territory'
  return state.map.territories[id]?.name ?? id
}

const FACTION_LABELS: Record<string, string> = { nato: 'NATO', russia: 'Russia', china: 'China' }

/** Short faction label used in player-facing text ("NATO", "Russia", "China"). */
export function factionLabel(id: string | undefined): string {
  return (id && FACTION_LABELS[id]) || 'an unknown faction'
}

/** One-line, player-facing description of an order ("Attack Ukraine with Infantry"). */
export function describeOrder(state: GameState, factionId: string, order: Order): string {
  const t = (id?: string) => territoryName(state, id)
  const unit = state.factions[factionId]?.units.find((u) => u.id === order.unit)
  const unitLabel = unit ? `${UNIT_LABEL[unit.type] ?? unit.type} from ${t(unit.territory)}` : 'a unit'
  switch (order.action) {
    case 'move': return `Move ${unitLabel} to ${t(order.to)}`
    case 'attack': return `Attack ${t(order.target)} with ${unitLabel}`
    case 'fortify': return `Fortify ${t(order.territory)}`
    case 'recruit': return `Recruit ${UNIT_LABEL[order.type ?? ''] ?? order.type} in ${t(order.territory)}`
    case 'research': return `Research ${order.tech} technology`
    case 'spy': return `Send spies to ${t(order.target)}`
    case 'trade': return `Send ${Object.entries(order.offer ?? {}).map(([k, v]) => `${v} ${k}`).join(', ')} to ${factionLabel(order.to)}`
    case 'diplomacy': return `Propose an alliance to ${factionLabel(order.to)}`
    case 'break_alliance': return `Break the alliance with ${factionLabel(order.to)}`
    case 'message': return order.to ? `Message ${factionLabel(order.to)}: "${order.message}"` : `Diplomatic message: "${order.message}"`
    case 'hire_mercenary': return `Hire mercenaries in ${t(order.territory)}`
    case 'build_nuke': return 'Build a nuclear warhead'
    case 'nuke': return `Nuclear strike on ${t(order.target)}`
    default: return order.action
  }
}

/**
 * Check `rawOrders` for `factionId` against `state` without mutating it.
 * Orders are considered in sequence; the first `maxOrders` legal ones are kept.
 */
export function validateOrders(
  state: GameState,
  factionId: string,
  rawOrders: unknown[],
  maxOrders: number = GAME_CONFIG.maxOrdersPerTurn
): ValidationResult {
  const faction = state.factions[factionId]
  const accepted: Order[] = []
  const rejected: RejectedOrder[] = []
  if (!faction) {
    return { accepted, rejected: rawOrders.map(() => ({ action: 'unknown', reason: 'Unknown faction' })) }
  }

  const { territories, adjacency } = state.map
  const t = (id?: string) => territoryName(state, id)
  const budget: Record<ResourceId, number> = { ...faction.resources }
  const tech: Record<string, number> = { ...faction.tech }
  let nukes = faction.nukes || 0
  const usedUnits = new Set<string>()
  const fortifying = new Set<string>()
  const proposals = new Set<string>()
  const mercsLeft: Record<string, number> = {}
  const owns = (id: string) => territories[id]?.owner === factionId
  const enemyUnitsAt = (id: string) =>
    Object.entries(state.factions).some(([fid, f]) => fid !== factionId && f.units.some((u) => u.territory === id))
  const otherFaction = (id?: string) => !!id && id !== factionId && (FACTION_IDS as readonly string[]).includes(id) && !!state.factions[id]

  const check = (o: Order): string | null => {
    switch (o.action as OrderAction) {
      case 'move':
      case 'attack': {
        const dest = o.action === 'move' ? o.to : o.target
        const verb = o.action === 'move' ? 'move' : 'attack'
        if (!o.unit) return `No unit was named for the ${verb}`
        const unit = faction.units.find((u) => u.id === o.unit)
        if (!unit) {
          const foreign = Object.entries(state.factions).some(([fid, f]) => fid !== factionId && f.units.some((u) => u.id === o.unit))
          return foreign ? 'You can only command your own units' : 'That unit does not exist'
        }
        if (usedUnits.has(unit.id)) return `${UNIT_LABEL[unit.type]} in ${t(unit.territory)} already has orders this turn`
        if (!dest || !territories[dest]) return `Unknown destination for the ${verb}`
        if (!(adjacency[unit.territory] || []).includes(dest)) {
          return `${UNIT_LABEL[unit.type]} in ${t(unit.territory)} cannot reach ${t(dest)}`
        }
        if (o.action === 'attack' && owns(dest) && !enemyUnitsAt(dest)) return `${t(dest)} is already yours - nothing to attack`
        usedUnits.add(unit.id)
        return null
      }
      case 'fortify': {
        const id = o.territory
        if (!id || !territories[id]) return 'Unknown territory to fortify'
        if (!owns(id)) return `You can only fortify your own territory (${t(id)})`
        if (territories[id].fortified || fortifying.has(id)) return `${t(id)} is already fortified`
        if (budget.iron < FORTIFY_IRON_COST) return `Not enough iron to fortify (need ${FORTIFY_IRON_COST})`
        budget.iron -= FORTIFY_IRON_COST
        fortifying.add(id)
        return null
      }
      case 'recruit': {
        if (!isUnitType(o.type)) return `Unknown unit type "${o.type ?? ''}"`
        if (tech.military < UNIT_TECH_REQUIRED[o.type]) {
          return `${UNIT_LABEL[o.type]} needs military tech ${UNIT_TECH_REQUIRED[o.type]}`
        }
        const id = o.territory
        if (!id || !territories[id]) return 'Unknown territory to recruit in'
        if (!owns(id)) return `You can only recruit in your own territory (${t(id)})`
        const cost = UNIT_STATS[o.type].cost
        if (budget.gold < cost.gold || budget.iron < cost.iron) {
          return `Not enough resources for ${UNIT_LABEL[o.type]} (need ${cost.gold} gold + ${cost.iron} iron)`
        }
        budget.gold -= cost.gold
        budget.iron -= cost.iron
        return null
      }
      case 'research': {
        if (!isTechId(o.tech)) return `Unknown technology "${o.tech ?? ''}"`
        const cost = researchCost(o.tech, tech[o.tech])
        if (!cost) return `${o.tech} technology is already at maximum level`
        if (budget.knowledge < cost.knowledge) return `Not enough knowledge for ${o.tech} research (need ${cost.knowledge})`
        if (budget.uranium < cost.uranium) return `Not enough uranium for nuclear research (need ${cost.uranium})`
        budget.knowledge -= cost.knowledge
        budget.uranium -= cost.uranium
        tech[o.tech]++
        return null
      }
      case 'spy': {
        if (!o.target || !territories[o.target]) return 'Unknown spy target'
        const cost = spyCost(tech.intelligence)
        if (budget.influence < cost) return `Not enough influence to spy (need ${cost})`
        budget.influence -= cost
        return null
      }
      case 'trade': {
        if (!otherFaction(o.to)) return 'Trades must go to another faction'
        const entries = Object.entries(o.offer ?? {})
        if (entries.length === 0) return 'The trade offers nothing'
        for (const [res, amount] of entries) {
          if (!(RESOURCE_IDS as string[]).includes(res)) return `Unknown resource "${res}"`
          if (!Number.isInteger(amount) || amount <= 0) return 'Trade amounts must be positive whole numbers'
          if (budget[res as ResourceId] < amount) return `Not enough ${res} for that trade`
        }
        for (const [res, amount] of entries) budget[res as ResourceId] -= amount
        return null
      }
      case 'diplomacy': {
        if (!otherFaction(o.to)) return 'Alliances can only be proposed to another faction'
        if (o.proposal !== 'alliance') return 'Only alliance proposals are supported'
        if (faction.alliances.includes(o.to!)) return `Already allied with ${factionLabel(o.to)}`
        if (faction.oathbreaker) return 'Oathbreakers cannot form alliances'
        if (state.factions[o.to!].oathbreaker) return `${factionLabel(o.to)} is an Oathbreaker`
        if (proposals.has(o.to!)) return 'Alliance already proposed this turn'
        proposals.add(o.to!)
        return null
      }
      case 'break_alliance':
        if (!o.to || !faction.alliances.includes(o.to)) return `No alliance with ${factionLabel(o.to)} to break`
        return null
      case 'message':
        if (!o.message) return 'Empty diplomatic message'
        if (o.to && !otherFaction(o.to)) return 'Messages can only be sent to another faction'
        return null
      case 'hire_mercenary': {
        const id = o.territory
        if (!id || !territories[id]) return 'Unknown territory to hire mercenaries in'
        const left = mercsLeft[id] ?? territories[id].mercenaries ?? 0
        if (left < 1) return `No mercenaries for hire in ${t(id)}`
        const access = faction.units.some((u) => u.territory === id) ||
          Object.entries(territories).some(([tid, ter]) => ter.owner === factionId && (adjacency[tid] || []).includes(id))
        if (!access) return `No access to ${t(id)} to hire mercenaries`
        if (budget.gold < MERCENARY_GOLD_COST) return `Not enough gold to hire mercenaries (need ${MERCENARY_GOLD_COST})`
        budget.gold -= MERCENARY_GOLD_COST
        mercsLeft[id] = left - 1
        return null
      }
      case 'build_nuke': {
        if (tech.nuclear < 1) return 'Nuclear technology has not been researched'
        const cost = nukeBuildCost(tech.nuclear)
        if (budget.gold < cost.gold || budget.uranium < cost.uranium) {
          return `Not enough resources for a warhead (need ${cost.gold} gold + ${cost.uranium} uranium)`
        }
        budget.gold -= cost.gold
        budget.uranium -= cost.uranium
        nukes++
        return null
      }
      case 'nuke': {
        if (nukes < 1) return 'No operational nuclear warheads'
        const id = o.target
        if (!id || !territories[id]) return 'Unknown nuclear target'
        if (owns(id)) return 'You cannot strike your own territory'
        if (tech.nuclear < 2) {
          const inRange = Object.entries(territories).some(([tid, ter]) => ter.owner === factionId && (adjacency[tid] || []).includes(id))
          if (!inRange) return `${t(id)} is out of range without ICBM technology`
        }
        nukes--
        return null
      }
      default:
        return `Unsupported action "${o.action}"`
    }
  }

  for (const raw of rawOrders) {
    const order = normalizeOrder(raw)
    const action = (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).action === 'string')
      ? String((raw as Record<string, unknown>).action).slice(0, 40)
      : 'unknown'
    if (!order) {
      rejected.push({ action, reason: `"${action}" is not an available action` })
      continue
    }
    if (accepted.length >= maxOrders) {
      rejected.push({ action: order.action, reason: `Order limit reached (${maxOrders} per turn)` })
      continue
    }
    const reason = check(order)
    if (reason) rejected.push({ action: order.action, reason })
    else accepted.push(order)
  }

  return { accepted, rejected }
}

const ACTION_HINT_LABELS: [OrderAction, string][] = [
  ['attack', 'Attack'],
  ['move', 'Move'],
  ['recruit', 'Recruit'],
  ['fortify', 'Fortify'],
  ['research', 'Research'],
  ['hire_mercenary', 'Hire mercenaries'],
  ['spy', 'Spy'],
  ['diplomacy', 'Alliance'],
  ['message', 'Message'],
  ['build_nuke', 'Build warhead'],
  ['nuke', 'Nuclear strike'],
]

/**
 * Which kinds of order `factionId` could legally give right now, as short UI
 * labels ("Attack", "Recruit", ...). Each is proven by validating one probe
 * order, so the hint never suggests something the validator would refuse.
 */
export function availableActions(state: GameState, factionId: string): string[] {
  const faction = state.factions[factionId]
  if (!faction) return []
  const ids = Object.keys(state.map.territories)
  const others = (FACTION_IDS as readonly string[]).filter((f) => f !== factionId)
  const probes: Record<string, () => Order[]> = {
    attack: () => faction.units.flatMap((u) => (state.map.adjacency[u.territory] || []).map((target) => ({ action: 'attack', unit: u.id, target }))),
    move: () => faction.units.flatMap((u) => (state.map.adjacency[u.territory] || []).map((to) => ({ action: 'move', unit: u.id, to }))),
    recruit: () => ids.map((territory) => ({ action: 'recruit', type: 'infantry', territory })),
    fortify: () => ids.map((territory) => ({ action: 'fortify', territory })),
    research: () => ['military', 'economic', 'intelligence', 'nuclear'].map((tech) => ({ action: 'research', tech })),
    hire_mercenary: () => ids.map((territory) => ({ action: 'hire_mercenary', territory })),
    spy: () => [{ action: 'spy', target: ids[0] }],
    diplomacy: () => others.map((to) => ({ action: 'diplomacy', to, proposal: 'alliance' })),
    message: () => [{ action: 'message', message: 'probe' }],
    build_nuke: () => [{ action: 'build_nuke' }],
    nuke: () => ids.map((target) => ({ action: 'nuke', target })),
  }
  return ACTION_HINT_LABELS
    .filter(([action]) => probes[action]().some((o) => validateOrders(state, factionId, [o], 1).accepted.length === 1))
    .map(([, label]) => label)
}
