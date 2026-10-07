/**
 * Rule constants shared by the turn resolver (engine.ts), the order validator
 * (orders.ts) and the fallback planner (fallback.ts), so the three can never
 * disagree about what something costs.
 */

export type UnitType = 'infantry' | 'armor' | 'artillery'
export type TechId = 'military' | 'economic' | 'intelligence' | 'nuclear'
export type ResourceId = 'gold' | 'food' | 'iron' | 'influence' | 'knowledge' | 'uranium'

export const UNIT_STATS: Record<UnitType, { attack: number; defense: number; movement: number; cost: { gold: number; iron: number } }> = {
  infantry: { attack: 2, defense: 2, movement: 1, cost: { gold: 2, iron: 1 } },
  armor: { attack: 3, defense: 1, movement: 2, cost: { gold: 4, iron: 2 } },
  artillery: { attack: 4, defense: 1, movement: 1, cost: { gold: 5, iron: 3 } }
}

/** Military tech level needed to recruit each unit type. */
export const UNIT_TECH_REQUIRED: Record<UnitType, number> = { infantry: 0, armor: 1, artillery: 2 }

/** Short id prefix used for unit ids, matching game/initial-world.json (nato-inf-1). */
export const UNIT_ID_PREFIX: Record<UnitType, string> = { infantry: 'inf', armor: 'arm', artillery: 'art' }

export const TERRAIN_DEFENSE: Record<string, number> = {
  mountains: 2,
  plains: 0,
  coast: 0
}

export const UNIT_TYPES = Object.keys(UNIT_STATS) as UnitType[]
export const TECH_IDS: TechId[] = ['military', 'economic', 'intelligence', 'nuclear']
export const RESOURCE_IDS: ResourceId[] = ['gold', 'food', 'iron', 'influence', 'knowledge', 'uranium']
export const MAX_TECH_LEVEL = 3

/** Knowledge cost to reach level n+1, indexed by the current level. */
export const RESEARCH_KNOWLEDGE_COST = [3, 5, 8]
export const NUCLEAR_KNOWLEDGE_COST = [5, 8, 10]
export const NUCLEAR_URANIUM_COST = [3, 5, 8]

export const FORTIFY_IRON_COST = 2
export const MERCENARY_GOLD_COST = 5

export function isUnitType(v: unknown): v is UnitType {
  return typeof v === 'string' && v in UNIT_STATS
}

export function isTechId(v: unknown): v is TechId {
  return typeof v === 'string' && (TECH_IDS as string[]).includes(v)
}

export function researchCost(tech: TechId, currentLevel: number): { knowledge: number; uranium: number } | null {
  if (currentLevel >= MAX_TECH_LEVEL) return null
  if (tech === 'nuclear') {
    return { knowledge: NUCLEAR_KNOWLEDGE_COST[currentLevel], uranium: NUCLEAR_URANIUM_COST[currentLevel] }
  }
  return { knowledge: RESEARCH_KNOWLEDGE_COST[currentLevel], uranium: 0 }
}

export function spyCost(intelligenceLevel: number): number {
  return intelligenceLevel >= 1 ? 1 : 2
}

export function nukeBuildCost(nuclearLevel: number): { gold: number; uranium: number } {
  return nuclearLevel >= 2 ? { gold: 8, uranium: 3 } : { gold: 10, uranium: 5 }
}
