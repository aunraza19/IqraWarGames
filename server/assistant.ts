/**
 * Action Assistant: what the human player can do, explained for beginners.
 *
 * One source of truth for how each engine action is presented (label, icon,
 * category, description, example prompts) - ACTION_HELP is keyed by the
 * engine's own OrderAction union, so a new action cannot be added without
 * help text, and nothing that is not an engine action can be advertised.
 *
 * Availability is never taken from this metadata: each action is proven
 * possible by running candidate orders through validateOrders() - the same
 * check the human's interpreted orders must pass. Lock reasons are short
 * explanations derived from the same rule constants.
 *
 * Everything here is deterministic and makes no model call. Templates are
 * plain-English commands for the existing interpreter; they never contain ids.
 */

import type { GameState, Order } from './types.js'
import { FACTION_IDS } from './config.js'
import { ORDER_ACTIONS, factionLabel, validateOrders, type OrderAction } from './orders.js'
import {
  FORTIFY_IRON_COST,
  MERCENARY_GOLD_COST,
  RESOURCE_IDS,
  TECH_IDS,
  UNIT_STATS,
  UNIT_TECH_REQUIRED,
  UNIT_TYPES,
  nukeBuildCost,
  researchCost,
  spyCost,
  type TechId,
  type UnitType,
} from './rules.js'

export type ActionCategory = 'military' | 'development' | 'intelligence' | 'diplomacy' | 'nuclear'

export const CATEGORY_ORDER: ActionCategory[] = ['military', 'development', 'intelligence', 'diplomacy', 'nuclear']
export const CATEGORY_LABELS: Record<ActionCategory, string> = {
  military: 'Military',
  development: 'Development',
  intelligence: 'Intelligence',
  diplomacy: 'Diplomacy',
  nuclear: 'Nuclear / Advanced',
}

export interface ActionHelp {
  label: string
  icon: string
  category: ActionCategory
  /** One beginner-friendly sentence describing what the engine actually does. */
  description: string
  /** Example commands for the interpreter. Plain English, no ids. */
  templates: string[]
  /** Shown in the Nuclear / Advanced group and never suggested. */
  advanced?: boolean
}

/** Help for every action the engine resolves. Typed by OrderAction, so it cannot drift. */
export const ACTION_HELP: Record<OrderAction, ActionHelp> = {
  attack: {
    label: 'Attack',
    icon: '⚔',
    category: 'military',
    description: 'Send a unit into a neighbouring enemy or neutral territory to fight for it and capture it.',
    templates: [
      'Attack the weakest nearby enemy territory with my strongest available unit.',
      'Expand aggressively: choose the best territory I can legally attack this turn.',
    ],
  },
  move: {
    label: 'Move',
    icon: '➔',
    category: 'military',
    description: 'Reposition a unit into a neighbouring territory - your own land, or empty land to claim.',
    templates: [
      'Move troops to strengthen my weakest frontline.',
      'Reposition my strongest available unit closer to the enemy.',
    ],
  },
  fortify: {
    label: 'Fortify',
    icon: '⛨',
    category: 'military',
    description: `Strengthen one of your territories so it is harder to capture (+2 defence, costs ${FORTIFY_IRON_COST} iron).`,
    templates: [
      'Fortify my most vulnerable territory.',
      'Strengthen the border most likely to be attacked next.',
    ],
  },
  recruit: {
    label: 'Recruit',
    icon: '➕',
    category: 'military',
    description: 'Spend gold and iron to raise a new unit in a territory you control.',
    templates: [
      'Recruit the strongest unit I can currently afford.',
      'Build more infantry in a safe territory.',
    ],
  },
  hire_mercenary: {
    label: 'Hire Mercenaries',
    icon: '💵',
    category: 'military',
    description: `Pay ${MERCENARY_GOLD_COST} gold to hire a mercenary in a nearby neutral territory - it joins your army and claims that land.`,
    templates: [
      'Hire mercenaries where they would help me most.',
      'Use mercenaries to grab a neutral territory next to mine.',
    ],
  },
  research: {
    label: 'Research',
    icon: '🔬',
    category: 'development',
    description: 'Spend knowledge to raise a technology level - better units, more income, cheaper spying or nuclear weapons.',
    templates: [
      'Research whichever technology would help my position the most right now.',
      'Prioritise military research this turn.',
    ],
  },
  spy: {
    label: 'Spy',
    icon: '🕵',
    category: 'intelligence',
    description: 'Send spies to a territory. It costs influence and is announced, but in this version it reveals nothing extra.',
    templates: [
      'Spy on the enemy territory that threatens me most.',
    ],
  },
  diplomacy: {
    label: 'Propose Alliance',
    icon: '🤝',
    category: 'diplomacy',
    description: 'Offer another faction an alliance. It only forms if they propose one to you too; allies share map vision.',
    templates: [
      'Propose an alliance to the faction that threatens me least.',
    ],
  },
  message: {
    label: 'Message',
    icon: '📨',
    category: 'diplomacy',
    description: 'Send another faction a diplomatic message. Words only - it creates no binding treaty.',
    templates: [
      'Warn my nearest rival not to attack my territory.',
      'Send a message proposing cooperation against our common opponent.',
    ],
  },
  trade: {
    label: 'Send Resources',
    icon: '💰',
    category: 'diplomacy',
    description: 'Give some of your resources to another faction as a gesture. One-way: nothing comes back automatically.',
    templates: [
      'Send a small gift of gold to the faction I want as an ally.',
    ],
  },
  break_alliance: {
    label: 'Break Alliance',
    icon: '🗡',
    category: 'diplomacy',
    description: 'End an alliance for a surprise-attack bonus this turn. You are marked Oathbreaker and can never ally again.',
    templates: [
      'Break my alliance and strike my former ally while they are unprepared.',
    ],
  },
  build_nuke: {
    label: 'Build Warhead',
    icon: '☢',
    category: 'nuclear',
    advanced: true,
    description: 'Build a nuclear warhead. Needs nuclear technology and gold plus uranium.',
    templates: [
      'Build a nuclear warhead.',
    ],
  },
  nuke: {
    label: 'Launch Nuke',
    icon: '☢',
    category: 'nuclear',
    advanced: true,
    description: 'Fire a warhead at a territory: every unit there is destroyed and the land is left neutral. Victims with nuclear level 3 strike back.',
    templates: [
      'Launch a nuclear strike against the strongest enemy territory in range.',
    ],
  },
}

export interface StrategyIdea {
  label: string
  template: string
}

/** Multi-action starting points. Static, and deliberately non-nuclear. */
export const STRATEGY_IDEAS: StrategyIdea[] = [
  { label: 'Aggressive', template: 'Play aggressively this turn: attack the best available target with conventional forces and use my other orders to strengthen the offensive.' },
  { label: 'Defensive', template: 'Play defensively: fortify my weakest territory, reinforce my forces, and avoid unnecessary attacks.' },
  { label: 'Economic', template: 'Focus on long-term growth: prioritise economic research and recruit efficiently.' },
  { label: 'Expansion', template: 'Expand into valuable nearby territories while keeping my borders reasonably defended.' },
  { label: 'Diplomatic', template: 'Seek an alliance with the faction that threatens me least, and strengthen my border with the other.' },
]

/** Actions never offered as a "suggested for this turn" shortcut. */
const NEVER_SUGGESTED: OrderAction[] = ['nuke', 'build_nuke', 'break_alliance', 'trade', 'spy']
/** Order in which available actions are suggested. */
const SUGGESTION_PRIORITY: OrderAction[] = ['attack', 'recruit', 'fortify', 'research', 'move', 'hire_mercenary', 'diplomacy', 'message']
export const MAX_SUGGESTIONS = 5

export interface ActionOption {
  label: string
  template: string
  available: boolean
  reason?: string
}

export interface ActionStatus {
  action: OrderAction
  label: string
  icon: string
  category: ActionCategory
  description: string
  advanced: boolean
  available: boolean
  /** Why it is unavailable right now (only when !available). */
  reason?: string
  /** Example commands; a state-specific one first when possible. */
  templates: string[]
  /** Sub-choices: unit types for Recruit, technology tracks for Research. */
  options: ActionOption[]
}

export interface ActionAssistant {
  actions: ActionStatus[]
  suggested: OrderAction[]
  strategies: StrategyIdea[]
}

const UNIT_NAME: Record<UnitType, string> = { infantry: 'infantry', armor: 'armor', artillery: 'artillery' }
const TECH_HELP: Record<TechId, { label: string; template: string }> = {
  military: { label: 'Military', template: 'Prioritise military research to unlock stronger units.' },
  economic: { label: 'Economic', template: 'Invest in economic research to grow my income.' },
  intelligence: { label: 'Intelligence', template: 'Improve my intelligence capabilities.' },
  nuclear: { label: 'Nuclear', template: 'Research nuclear technology.' },
}

/** Build the full assistant for one faction from the current state. Pure; no model calls. */
export function buildActionAssistant(state: GameState, factionId: string): ActionAssistant {
  const faction = state.factions[factionId]
  const { territories, adjacency } = state.map
  const ids = Object.keys(territories)
  const others = FACTION_IDS.filter((f) => f !== factionId && state.factions[f])
  const name = (id: string) => territories[id]?.name ?? id
  const legal = (o: Order) => validateOrders(state, factionId, [o], 1).accepted.length === 1
  const owned = ids.filter((id) => territories[id].owner === factionId)
  const enemyUnits = (id: string) =>
    Object.entries(state.factions).reduce((n, [fid, f]) => n + (fid === factionId ? 0 : f.units.filter((u) => u.territory === id).length), 0)
  const frontline = (id: string) =>
    (adjacency[id] || []).some((a) => (territories[a]?.owner && territories[a].owner !== factionId) || enemyUnits(a) > 0)
  const value = (id: string) => Object.values(territories[id]?.resources ?? {}).reduce((a, b) => a + b, 0)
  const unitMoves = (action: 'attack' | 'move') =>
    faction.units.flatMap((u) => (adjacency[u.territory] || []).map((dest) =>
      action === 'attack' ? { action, unit: u.id, target: dest } : { action, unit: u.id, to: dest }))
  /** Distinct destination ids of the legal orders, best first. */
  const best = (orders: Order[], score: (dest: string) => number) =>
    [...new Set(orders.filter(legal).map((o) => (o.target ?? o.to ?? o.territory)!))].sort((a, b) => score(b) - score(a))
  // Factions sorted by how much of their land touches ours: the "nearest rival" first.
  const rivals = [...others].sort((a, b) => border(b) - border(a))
  function border(f: string) {
    return ids.filter((id) => territories[id].owner === f && (adjacency[id] || []).some((x) => territories[x]?.owner === factionId)).length
  }

  const statuses: ActionStatus[] = []
  for (const action of ORDER_ACTIONS) {
    const help = ACTION_HELP[action]
    let available = false
    let reason: string | undefined
    let contextual: string | undefined
    let options: ActionOption[] = []

    switch (action) {
      case 'attack': {
        const targets = best(unitMoves('attack'), (d) => value(d) - 4 * enemyUnits(d) - 2 * (territories[d].mercenaries || 0))
        available = targets.length > 0
        if (available) contextual = `Attack ${name(targets[0])} with the strongest unit that can reach it.`
        else reason = faction.units.length ? 'None of your units can reach a territory to attack.' : 'You have no units left.'
        break
      }
      case 'move': {
        const moves = unitMoves('move')
        const reinforce = best(moves.filter((o) => owned.includes(o.to!) && frontline(o.to!)), (d) => -faction.units.filter((u) => u.territory === d).length)
        available = moves.some(legal)
        if (reinforce.length) contextual = `Move a unit to reinforce ${name(reinforce[0])}.`
        if (!available) reason = faction.units.length ? 'None of your units has anywhere to move.' : 'You have no units left.'
        break
      }
      case 'fortify': {
        const sites = best(owned.map((territory) => ({ action, territory })), (d) => (frontline(d) ? 100 : 0) + value(d))
        available = sites.length > 0
        if (available) contextual = `Fortify ${name(sites[0])} against attack.`
        else if (!owned.length) reason = 'You hold no territory to fortify.'
        else if (faction.resources.iron < FORTIFY_IRON_COST) reason = `Needs ${FORTIFY_IRON_COST} iron (you have ${faction.resources.iron}).`
        else reason = 'All your territories are already fortified.'
        break
      }
      case 'recruit': {
        const site = [...owned].sort((a, b) => (frontline(b) ? 1 : 0) - (frontline(a) ? 1 : 0))[0]
        options = UNIT_TYPES.map((type) => {
          const cost = UNIT_STATS[type].cost
          const ok = !!site && legal({ action, type, territory: site })
          const why = !site ? 'You hold no territory to recruit in.'
            : faction.tech.military < UNIT_TECH_REQUIRED[type] ? `Needs military tech ${UNIT_TECH_REQUIRED[type]}.`
            : `Costs ${cost.gold} gold + ${cost.iron} iron.`
          return { label: UNIT_NAME[type].replace(/^./, (c) => c.toUpperCase()), template: `Recruit ${UNIT_NAME[type]} in a safe territory I control.`, available: ok, ...(ok ? {} : { reason: why }) }
        })
        const strongest = [...UNIT_TYPES].reverse().find((t) => options[UNIT_TYPES.indexOf(t)].available)
        available = !!strongest
        if (strongest) contextual = `Recruit ${UNIT_NAME[strongest]} in ${name(site)}.`
        else reason = site ? `Not enough resources - infantry costs ${UNIT_STATS.infantry.cost.gold} gold + ${UNIT_STATS.infantry.cost.iron} iron (you have ${faction.resources.gold} gold, ${faction.resources.iron} iron).` : 'You hold no territory to recruit in.'
        break
      }
      case 'hire_mercenary': {
        const sites = best(ids.map((territory) => ({ action, territory })), value)
        available = sites.length > 0
        if (available) contextual = `Hire mercenaries in ${name(sites[0])}.`
        else if (faction.resources.gold < MERCENARY_GOLD_COST) reason = `Costs ${MERCENARY_GOLD_COST} gold (you have ${faction.resources.gold}).`
        else reason = 'No neutral territory with mercenaries borders your land.'
        break
      }
      case 'research': {
        options = TECH_IDS.map((tech) => {
          const cost = researchCost(tech, faction.tech[tech])
          const ok = legal({ action, tech })
          const why = !cost ? 'Already at maximum level.'
            : `Next level costs ${cost.knowledge} knowledge${cost.uranium ? ` + ${cost.uranium} uranium` : ''}.`
          return { label: `${TECH_HELP[tech].label} ${Math.min(3, faction.tech[tech] + 1)}`, template: TECH_HELP[tech].template, available: ok, ...(ok ? {} : { reason: why }) }
        })
        available = options.some((o) => o.available)
        if (!available) {
          const costs = TECH_IDS.map((t) => researchCost(t, faction.tech[t])).filter((c) => c !== null)
          reason = costs.length
            ? `Not enough knowledge - the cheapest research needs ${Math.min(...costs.map((c) => c!.knowledge))} (you have ${faction.resources.knowledge}).`
            : 'All technology is at maximum level.'
        }
        break
      }
      case 'spy': {
        const targets = best(ids.filter((id) => territories[id].owner && territories[id].owner !== factionId).map((target) => ({ action, target })), (d) => enemyUnits(d) * 2 + value(d))
        available = targets.length > 0
        if (available) contextual = `Send spies to ${name(targets[0])}.`
        else reason = `Costs ${spyCost(faction.tech.intelligence)} influence (you have ${faction.resources.influence}).`
        break
      }
      case 'diplomacy': {
        const partner = rivals.slice().reverse().find((to) => legal({ action, to, proposal: 'alliance' }))
        available = !!partner
        if (partner) contextual = `Propose an alliance with ${factionLabel(partner)}.`
        else reason = faction.oathbreaker ? 'Oathbreakers can never form alliances.' : 'No faction can accept an alliance from you right now.'
        break
      }
      case 'message': {
        available = legal({ action, message: 'probe' })
        if (rivals[0]) contextual = `Warn ${factionLabel(rivals[0])} not to attack my territory.`
        break
      }
      case 'trade': {
        const to = others.find((f) => legal({ action, to: f, offer: { gold: 2 } }))
        available = others.some((f) => RESOURCE_IDS.some((r) => legal({ action, to: f, offer: { [r]: 1 } })))
        if (to) contextual = `Send 2 gold to ${factionLabel(to)} as a goodwill gesture.`
        if (!available) reason = 'You have no resources to give.'
        break
      }
      case 'break_alliance': {
        const ally = faction.alliances.find((to) => legal({ action, to }))
        available = !!ally
        if (ally) contextual = `Break our alliance with ${factionLabel(ally)} and strike while they are unprepared.`
        else reason = 'You have no alliance to break.'
        break
      }
      case 'build_nuke': {
        available = legal({ action })
        if (!available) {
          const cost = nukeBuildCost(faction.tech.nuclear)
          reason = faction.tech.nuclear < 1 ? 'Research nuclear technology first.'
            : `Needs ${cost.gold} gold + ${cost.uranium} uranium (you have ${faction.resources.gold} gold, ${faction.resources.uranium} uranium).`
        }
        break
      }
      case 'nuke': {
        const targets = best(ids.filter((id) => territories[id].owner && territories[id].owner !== factionId).map((target) => ({ action, target })), (d) => value(d) + 3 * enemyUnits(d))
        available = targets.length > 0
        if (available) contextual = `Launch a nuclear strike on ${name(targets[0])}.`
        else if ((faction.nukes || 0) < 1) reason = faction.tech.nuclear < 1 ? 'Research nuclear technology, then build a warhead.' : 'You have no warheads - build one first.'
        else reason = 'No enemy territory is in range - nuclear level 2 (ICBM) reaches anywhere.'
        break
      }
    }

    statuses.push({
      action,
      label: help.label,
      icon: help.icon,
      category: help.category,
      description: help.description,
      advanced: !!help.advanced,
      available,
      ...(available ? {} : { reason }),
      templates: contextual && available ? [contextual, ...help.templates] : help.templates,
      options,
    })
  }

  return { actions: statuses, suggested: getSuggestedActions(statuses), strategies: STRATEGY_IDEAS }
}

/** Up to MAX_SUGGESTIONS available, beginner-friendly actions, most useful first. Never nuclear. */
export function getSuggestedActions(statuses: ActionStatus[]): OrderAction[] {
  const available = new Set(statuses.filter((s) => s.available && !s.advanced).map((s) => s.action))
  return SUGGESTION_PRIORITY.filter((a) => available.has(a) && !NEVER_SUGGESTED.includes(a)).slice(0, MAX_SUGGESTIONS)
}
