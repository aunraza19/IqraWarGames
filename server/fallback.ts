/**
 * Deterministic fallback planner. No model call, no randomness.
 *
 * Used when an AI opponent's model request fails after retries (so the turn
 * still has three factions acting) and for the human's "quick strategy"
 * buttons when the natural-language interpreter is unavailable.
 *
 * It ranks a few candidate orders per category from the current state, then
 * keeps each one only if the whole list still passes validateOrders() - so it
 * can never produce an order the human interpreter would not be allowed to.
 * It never researches nuclear tech, builds warheads or launches them.
 */

import type { GameState, Order } from './types.js'
import { GAME_CONFIG } from './config.js'
import { validateOrders } from './orders.js'
import { TERRAIN_DEFENSE, UNIT_STATS, UNIT_TECH_REQUIRED, researchCost, type TechId, type UnitType } from './rules.js'

export const STRATEGY_FOCUSES = ['aggressive', 'defensive', 'economic', 'balanced'] as const
export type StrategyFocus = (typeof STRATEGY_FOCUSES)[number]

export function isStrategyFocus(v: unknown): v is StrategyFocus {
  return typeof v === 'string' && (STRATEGY_FOCUSES as readonly string[]).includes(v)
}

/** Each AI opponent's fallback leans the way its persona does. */
export const FALLBACK_FOCUS: Record<string, StrategyFocus> = {
  nato: 'balanced',
  russia: 'aggressive',
  china: 'economic',
}

type Category = 'attack' | 'expand' | 'recruit' | 'research' | 'fortify'

const PLANS: Record<StrategyFocus, Category[]> = {
  aggressive: ['attack', 'attack', 'attack', 'recruit', 'research'],
  defensive: ['fortify', 'recruit', 'fortify', 'research', 'recruit'],
  economic: ['research', 'expand', 'recruit', 'research', 'attack'],
  balanced: ['attack', 'recruit', 'research', 'fortify', 'expand'],
}

const RESEARCH_PREFERENCE: Record<StrategyFocus, TechId[]> = {
  aggressive: ['military', 'intelligence', 'economic'],
  defensive: ['military', 'economic', 'intelligence'],
  economic: ['economic', 'military', 'intelligence'],
  balanced: ['military', 'economic', 'intelligence'],
}

function resourceValue(res: Record<string, number>): number {
  return Object.values(res).reduce((a, b) => a + b, 0)
}

export function planFallbackOrders(
  state: GameState,
  factionId: string,
  focus: StrategyFocus = 'balanced',
  maxOrders: number = GAME_CONFIG.maxOrdersPerTurn
): Order[] {
  const faction = state.factions[factionId]
  if (!faction) return []
  const { territories, adjacency } = state.map
  const enemyUnitsAt = (id: string) =>
    Object.entries(state.factions).flatMap(([fid, f]) => (fid === factionId ? [] : f.units.filter((u) => u.territory === id)))
  const ownsT = (id: string) => territories[id]?.owner === factionId
  const isFrontline = (id: string) =>
    (adjacency[id] || []).some((adj) => (territories[adj]?.owner && territories[adj].owner !== factionId) || enemyUnitsAt(adj).length > 0)

  // --- candidate generators, best first ---

  const offensive = (neutralOnly: boolean): Order[] => {
    const scored: { order: Order; score: number }[] = []
    for (const unit of faction.units) {
      const atk = UNIT_STATS[unit.type].attack + (faction.tech.military >= 3 ? 1 : 0) + (unit.xp || 0)
      for (const dest of adjacency[unit.territory] || []) {
        const ter = territories[dest]
        if (!ter || ter.owner === factionId) continue
        if (neutralOnly && ter.owner) continue
        const defenders = enemyUnitsAt(dest)
        const terrain = TERRAIN_DEFENSE[ter.terrain] || 0
        let def = 0
        if (defenders.length > 0) {
          const fort = ter.fortified && !(unit.type === 'artillery' && faction.tech.military >= 2) ? 2 : 0
          def = Math.min(...defenders.map((d) => UNIT_STATS[d.type].defense)) + terrain + fort
        } else if (!ter.owner && ter.mercenaries > 0) {
          def = UNIT_STATS.infantry.defense + terrain - 2 // mercenaries fall on a lower roll (>= 5)
        }
        const margin = atk - def
        if (defenders.length > 0 && margin < 0) continue // long odds against real units: skip
        const score = resourceValue(ter.resources) * 2 + margin * 3 - defenders.length * 2 + (defenders.length === 0 && !ter.mercenaries ? 6 : 0)
        scored.push({ order: { action: 'attack', unit: unit.id, target: dest }, score })
      }
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.order)
  }

  const recruits = (): Order[] => {
    const types = (Object.keys(UNIT_STATS) as UnitType[])
      .filter((u) => faction.tech.military >= UNIT_TECH_REQUIRED[u])
      .sort((a, b) => UNIT_STATS[b].attack + UNIT_STATS[b].defense - (UNIT_STATS[a].attack + UNIT_STATS[a].defense))
    const owned = Object.keys(territories).filter(ownsT)
    const sites = [...owned.filter(isFrontline), ...owned.filter((id) => !isFrontline(id))]
    return types.flatMap((type) => sites.slice(0, 3).map((territory) => ({ action: 'recruit', type, territory })))
  }

  const fortifies = (): Order[] =>
    Object.keys(territories)
      .filter((id) => ownsT(id) && !territories[id].fortified && isFrontline(id))
      .sort((a, b) => resourceValue(territories[b].resources) - resourceValue(territories[a].resources))
      .map((territory) => ({ action: 'fortify', territory }))

  const researches = (): Order[] =>
    RESEARCH_PREFERENCE[focus]
      .filter((tech) => researchCost(tech, faction.tech[tech]) !== null)
      .map((tech) => ({ action: 'research', tech }))

  const candidates: Record<Category, () => Order[]> = {
    attack: () => offensive(false),
    expand: () => offensive(true),
    recruit: recruits,
    research: researches,
    fortify: fortifies,
  }

  const chosen: Order[] = []
  for (const category of PLANS[focus]) {
    if (chosen.length >= maxOrders) break
    for (const candidate of candidates[category]()) {
      const { accepted } = validateOrders(state, factionId, [...chosen, candidate], maxOrders)
      if (accepted.length === chosen.length + 1) {
        chosen.push(candidate)
        break
      }
    }
  }
  return chosen
}
