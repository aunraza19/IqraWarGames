/**
 * Deterministic turn summaries, built from the events the engine resolved.
 * This replaces the old narrator model call: no API request, no invented facts.
 */

import type { GameEvent, GameState, OrderSource } from './types.js'
import { factionLabel } from './orders.js'

export interface ReportLine {
  ok: boolean
  text: string
}

export interface FactionReport {
  faction: string
  label: string
  controller: OrderSource
  /** Short public plan summary (the interpreter's or the AI's), if any. */
  summary: string
  lines: ReportLine[]
}

export interface TurnReport {
  turn: number
  headline: string
  factions: FactionReport[]
}

/** Replace territory ids in engine text with display names. */
export function humanize(state: GameState, text: string): string {
  return text.replace(/\b[a-z]+(?:_[a-z]+)+\b|\b[a-z]+\b/g, (word) => state.map.territories[word]?.name ?? word)
}

/** Which faction acted to produce this event (combat events credit the winner in `faction`). */
export function actorOf(event: GameEvent): string {
  const actor = event.details?.actor
  return typeof actor === 'string' ? actor : event.faction
}

/** Engine text uses full faction names ("People's Republic of China"); reports use the short label. */
function shortNames(state: GameState, text: string): string {
  let out = text
  for (const [id, f] of Object.entries(state.factions)) out = out.split(f.name).join(factionLabel(id))
  return out
}

function eventLine(state: GameState, event: GameEvent, actor: string): ReportLine | null {
  const fName = state.factions[actor]?.name ?? actor
  const text = shortNames(state, humanize(state, event.description.startsWith(`${fName}: `) ? event.description.slice(fName.length + 2) : event.description))
  switch (event.type) {
    case 'forfeit':
      return null
    case 'invalid':
      return { ok: false, text: text.charAt(0).toUpperCase() + text.slice(1) }
    case 'combat':
      // The engine credits the winner; a repelled or drawn attack is a setback for the attacker.
      return { ok: event.faction === actor && !/draw|repel|mutual|losses/i.test(event.description), text }
    default:
      return { ok: true, text }
  }
}

function captured(state: GameState, events: GameEvent[], actor: string): string[] {
  return events
    .filter((e) => actorOf(e) === actor && e.to && (e.type === 'capture' || (e.type === 'combat' && e.faction === actor && e.from)))
    .map((e) => state.map.territories[e.to!]?.name ?? e.to!)
    .filter((name, i, all) => all.indexOf(name) === i)
}

function stalled(events: GameEvent[], actor: string): boolean {
  return events.some((e) => actorOf(e) === actor && e.type === 'combat' && (e.faction !== actor || /draw|repel/i.test(e.description)))
}

function list(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** A one-sentence, template-based headline for the turn. */
export function buildHeadline(state: GameState, events: GameEvent[], humanFaction: string | null, resolutionOrder: string[]): string {
  const nuke = events.find((e) => e.type === 'nuke')
  if (nuke) {
    return `NUCLEAR STRIKE: ${factionLabel(actorOf(nuke))} hits ${state.map.territories[nuke.to ?? '']?.name ?? 'a territory'}.`
  }
  const lead = humanFaction ?? resolutionOrder[0]
  const others = resolutionOrder.filter((f) => f !== lead)
  const leadCaps = captured(state, events, lead)
  const has = (type: GameEvent['type']) => events.some((e) => actorOf(e) === lead && e.type === type)
  let first: string
  if (leadCaps.length) first = `${factionLabel(lead)} captures ${list(leadCaps)}`
  else if (stalled(events, lead)) first = `${factionLabel(lead)}'s offensive stalls`
  else if (has('recruit') || has('hire_mercenary')) first = `${factionLabel(lead)} builds up its forces`
  else if (has('research')) first = `${factionLabel(lead)} invests in research`
  else if (has('fortify')) first = `${factionLabel(lead)} digs in`
  else first = `${factionLabel(lead)} holds position`

  for (const f of others) {
    const caps = captured(state, events, f)
    if (caps.length) return `${first} while ${factionLabel(f)} seizes ${list(caps)}.`
  }
  for (const f of others) {
    if (stalled(events, f)) return `${first} while ${factionLabel(f)}'s offensive stalls.`
  }
  return `${first}.`
}

export function buildTurnReport(
  state: GameState,
  turn: number,
  events: GameEvent[],
  resolutionOrder: string[],
  sources: Record<string, OrderSource>,
  summaries: Record<string, string>,
  humanFaction: string | null,
  humanRejected: string[] = []
): TurnReport {
  const ordering = humanFaction ? [humanFaction, ...resolutionOrder.filter((f) => f !== humanFaction)] : resolutionOrder
  const factions: FactionReport[] = ordering.map((fid) => {
    const lines = events
      .filter((e) => actorOf(e) === fid && e.type !== 'victory')
      .map((e) => eventLine(state, e, fid))
      .filter((l): l is ReportLine => l !== null)
    if (fid === humanFaction) lines.push(...humanRejected.map((text) => ({ ok: false, text })))
    if (lines.length === 0) lines.push({ ok: false, text: 'No orders carried out' })
    return {
      faction: fid,
      label: fid === humanFaction ? 'YOU' : factionLabel(fid).toUpperCase(),
      controller: sources[fid] ?? 'ai',
      summary: summaries[fid] ?? '',
      lines,
    }
  })
  return { turn, headline: buildHeadline(state, events, humanFaction, resolutionOrder), factions }
}
