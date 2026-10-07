/**
 * Scoring, in one place.
 *
 * factionScore() is the game's existing score (game/rules.md): territories x 3
 * + total resources / 5 + non-nuclear tech levels x 2. The engine recomputes it
 * every turn and uses it to pick the winner when the turn limit is reached.
 *
 * eventScore() turns the human's final position into the leaderboard number.
 * It is derived only from server state - never from a model.
 */

import type { GameState } from './types.js'

export type Outcome = 'victory' | 'defeat' | 'draw'

/** Leaderboard bonuses on top of factionScore x EVENT_SCORE_MULTIPLIER. */
export const EVENT_SCORE_MULTIPLIER = 100
export const VICTORY_BONUS = 2500
export const DRAW_BONUS = 1000
/** Per turn left unplayed when a victory condition ends the game early. */
export const EARLY_VICTORY_BONUS_PER_TURN = 250

export function factionScore(state: GameState, factionId: string): number {
  const f = state.factions[factionId]
  const territories = Object.values(state.map.territories).filter((t) => t.owner === factionId).length
  const r = f.resources
  return territories * 3 +
    Math.floor((r.gold + r.food + r.iron + r.influence + r.knowledge) / 5) +
    (f.tech.military + f.tech.economic + f.tech.intelligence) * 2
}

/** The human's result once the game is finished; null while it is still running. */
export function outcomeFor(state: GameState, humanFaction: string | null): Outcome | null {
  if (state.game.status !== 'finished' || !humanFaction) return null
  if (!state.game.victor) return 'draw'
  return state.game.victor === humanFaction ? 'victory' : 'defeat'
}

export function eventScore(state: GameState, humanFaction: string | null): number | null {
  const outcome = outcomeFor(state, humanFaction)
  if (!outcome || !humanFaction) return null
  let score = state.factions[humanFaction].score * EVENT_SCORE_MULTIPLIER
  if (outcome === 'victory') {
    score += VICTORY_BONUS + Math.max(0, state.game.maxTurns - state.game.turn) * EARLY_VICTORY_BONUS_PER_TURN
  } else if (outcome === 'draw') {
    score += DRAW_BONUS
  }
  return score
}
