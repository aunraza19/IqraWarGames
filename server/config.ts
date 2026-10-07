/**
 * Event-mode settings for Human vs AI, in one place.
 *
 * Most are plain constants; the few an organiser may want to change without
 * editing code read an environment variable (see .env.example). Every value is
 * clamped so a typo in .env cannot produce a 0-turn game or a 10-minute timeout.
 */

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export const FACTION_IDS = ['nato', 'russia', 'china'] as const
export type FactionId = (typeof FACTION_IDS)[number]

export function isFactionId(value: unknown): value is FactionId {
  return typeof value === 'string' && (FACTION_IDS as readonly string[]).includes(value)
}

export const GAME_CONFIG = {
  /** Turns per event game. The game can still end earlier on a victory condition. */
  maxTurns: envInt('MAX_TURNS', 8, 1, 30),
  /** Orders per faction per turn - the same cap for the human and the AI opponents (game/rules.md). */
  maxOrdersPerTurn: 3,
  /** Natural-language command length, enforced server-side. */
  minCommandLength: 2,
  maxCommandLength: 500,
  /** Commander name shown on the end screen and leaderboard. */
  maxPlayerNameLength: 24,
  defaultPlayerName: 'Commander',
  /** Diplomatic message text an order may carry. */
  maxMessageLength: 200,
  /** Per-attempt timeout for one model request. */
  aiRequestTimeoutMs: envInt('AI_REQUEST_TIMEOUT_MS', 15000, 3000, 60000),
  /** Extra attempts after the first for 429 / 5xx / network failures. */
  aiMaxRetries: envInt('AI_MAX_RETRIES', 2, 0, 5),
} as const
