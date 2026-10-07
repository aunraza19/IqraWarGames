/**
 * Event leaderboard in this browser's localStorage - one booth machine, no
 * server or database. Entries are validated on every read so a corrupt or
 * hand-edited value can never break the page; storage errors (private mode,
 * blocked storage) just mean an empty board.
 */

export type LeaderboardFaction = 'nato' | 'russia' | 'china'

export interface LeaderboardEntry {
  /** The server's game id, so one game is never recorded twice. */
  id: string
  name: string
  faction: LeaderboardFaction
  score: number
  outcome: 'victory' | 'defeat' | 'draw'
  turns: number
  territories: number
  at: string
}

const KEY = 'wargames.leaderboard.v1'
const MAX_ENTRIES = 200
const FACTIONS: LeaderboardFaction[] = ['nato', 'russia', 'china']
const OUTCOMES = ['victory', 'defeat', 'draw']

function valid(e: unknown): e is LeaderboardEntry {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return typeof r.id === 'string' && r.id.length <= 64 &&
    typeof r.name === 'string' && r.name.length <= 40 &&
    FACTIONS.includes(r.faction as LeaderboardFaction) &&
    OUTCOMES.includes(r.outcome as string) &&
    Number.isFinite(r.score) && Number.isFinite(r.turns) && Number.isFinite(r.territories) &&
    typeof r.at === 'string'
}

export function loadLeaderboard(): LeaderboardEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter(valid) : []
  } catch {
    return []
  }
}

/** Add an entry (ignored if that game is already recorded). Returns its 1-based rank within its faction, or null. */
export function recordResult(entry: LeaderboardEntry): number | null {
  if (!valid(entry)) return null
  const all = loadLeaderboard()
  if (!all.some((e) => e.id === entry.id)) {
    all.push(entry)
    // Keep the best scores if the board ever fills up.
    all.sort((a, b) => b.score - a.score)
    try {
      localStorage.setItem(KEY, JSON.stringify(all.slice(0, MAX_ENTRIES)))
    } catch {
      return null
    }
  }
  const rank = topScores(entry.faction, MAX_ENTRIES).findIndex((e) => e.id === entry.id)
  return rank === -1 ? null : rank + 1
}

export function topScores(faction: LeaderboardFaction, limit = 10): LeaderboardEntry[] {
  return loadLeaderboard()
    .filter((e) => e.faction === faction)
    .sort((a, b) => b.score - a.score || a.at.localeCompare(b.at))
    .slice(0, limit)
}

export function clearLeaderboard(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable - nothing to clear */
  }
}
