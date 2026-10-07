/** Request validation and other small pure helpers for the HTTP layer, kept separate so they can be unit-tested. */

import { GAME_CONFIG, isFactionId, type FactionId } from './config.js'
import { isStrategyFocus, type StrategyFocus } from './fallback.js'
import { cleanText } from './orders.js'

/**
 * Only the local UI may call the API from a browser: the Vite dev server (:3000)
 * or this server itself when it serves dist/ (:3001). Requests without an Origin
 * header (curl, server-to-server) are allowed - the server binds to 127.0.0.1.
 */
export function isAllowedOrigin(origin: string | undefined, ports: number[] = [3000, 3001]): boolean {
  if (!origin) return true
  try {
    const u = new URL(origin)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
    return u.protocol === 'http:' && local && ports.includes(Number(u.port))
  } catch {
    return false
  }
}

/** A request the server refuses before it reaches the engine. */
export interface BadRequest {
  error: string
  code: string
  status: number
}

export function isBadRequest(v: unknown): v is BadRequest {
  return !!v && typeof v === 'object' && 'error' in v && 'status' in v
}

function body(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

/** POST /api/start - { playerName?, humanFaction } */
export function parseStartBody(raw: unknown): { playerName: string; humanFaction: FactionId } | BadRequest {
  const b = body(raw)
  if (!isFactionId(b.humanFaction)) {
    return { error: 'Choose NATO, Russia or China.', code: 'invalid_faction', status: 400 }
  }
  if (b.playerName !== undefined && typeof b.playerName !== 'string') {
    return { error: 'Commander name must be text.', code: 'invalid_name', status: 400 }
  }
  const playerName = cleanText(b.playerName, GAME_CONFIG.maxPlayerNameLength) || GAME_CONFIG.defaultPlayerName
  return { playerName, humanFaction: b.humanFaction }
}

/** Letters or digits in any script - "🍕🍕🍕" and "!!" have none. */
function meaningfulChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) || []).length
}

/**
 * POST /api/player-command - { gameId, turn, command } or { gameId, turn, quick }.
 * Only these fields are read: faction, state, results and scores always come
 * from the server, whatever else the body contains.
 */
export function parseCommandBody(raw: unknown): { gameId: string; turn: number; command?: string; quick?: StrategyFocus } | BadRequest {
  const b = body(raw)
  if (typeof b.gameId !== 'string' || !b.gameId || b.gameId.length > 64) {
    return { error: 'Missing game id. Start a new game.', code: 'invalid_game', status: 400 }
  }
  if (typeof b.turn !== 'number' || !Number.isInteger(b.turn) || b.turn < 1) {
    return { error: 'Missing turn number.', code: 'invalid_turn', status: 400 }
  }
  const base = { gameId: b.gameId, turn: b.turn }
  if (b.quick !== undefined) {
    if (!isStrategyFocus(b.quick)) return { error: 'Unknown quick strategy.', code: 'invalid_quick', status: 400 }
    return { ...base, quick: b.quick }
  }
  if (typeof b.command !== 'string') {
    return { error: 'Type your orders first.', code: 'invalid_command', status: 400 }
  }
  if (b.command.trim().length > GAME_CONFIG.maxCommandLength) {
    return { error: `Orders are limited to ${GAME_CONFIG.maxCommandLength} characters.`, code: 'command_too_long', status: 400 }
  }
  const command = cleanText(b.command, GAME_CONFIG.maxCommandLength)
  if (meaningfulChars(command) < GAME_CONFIG.minCommandLength) {
    return {
      error: 'I couldn\'t determine valid military orders. Try something like: "Recruit infantry and defend Eastern Europe."',
      code: 'not_understood',
      status: 422,
    }
  }
  return { ...base, command }
}
