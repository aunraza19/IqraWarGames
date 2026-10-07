/**
 * Retry with exponential backoff for AI provider calls.
 *
 * A turn makes up to three model calls at once (human interpreter + two AI
 * opponents). Without this, one 429 (rate limit) or 5xx (provider overloaded)
 * loses that call outright. Retried: HTTP 429, any 5xx, and network-level
 * failures (fetch threw before a response). NOT retried: other 4xx (a bad key
 * or bad request will not fix itself) and our own timeouts (a player is waiting).
 *
 * The delay honours the provider's hint - a Retry-After header, or Gemini's
 * RetryInfo.retryDelay - when there is one. A hint longer than maxDelayMs
 * means "your quota is gone for a while": retrying sooner would only fail
 * again, so we give up at once and let the caller fall back instead of making
 * the player wait. Retries are bounded (GAME_CONFIG.aiMaxRetries).
 */

import { GAME_CONFIG } from './config.js'

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}

export interface RetryOptions {
  /** Extra attempts after the first. */
  retries: number
  baseDelayMs: number
  maxDelayMs: number
  sleep: (ms: number) => Promise<void>
  /** Called before each retry's sleep. */
  onRetry?: (attempt: number, delayMs: number) => void
}

/** Mutable so tests can swap `sleep` for an instant recorder. */
export const retryDefaults: RetryOptions = {
  retries: GAME_CONFIG.aiMaxRetries,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** Parse Retry-After (delta-seconds or an HTTP date) to milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const secs = Number(value)
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

/** Build a ProviderHttpError from a non-OK response, keeping the old message shape. */
export async function httpError(label: string, res: Response): Promise<ProviderHttpError> {
  const body = await res.text().catch(() => '')
  return new ProviderHttpError(
    `${label} API error ${res.status}: ${body.slice(0, 200)}`,
    res.status,
    parseRetryAfter(res.headers.get('retry-after'))
  )
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof ProviderHttpError) return err.status
  // The Gemini SDK's GoogleGenerativeAIFetchError carries `status`.
  const s = (err as { status?: unknown })?.status
  return typeof s === 'number' ? s : undefined
}

/** Parse a protobuf Duration string ("37s", "1.5s") to milliseconds. */
function parseDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
  return m ? Math.round(Number(m[1]) * 1000) : undefined
}

/** The provider's own "retry after" hint, if the error carries one. */
export function retryHintMs(err: unknown): number | undefined {
  if (err instanceof ProviderHttpError) return err.retryAfterMs
  // GoogleGenerativeAIFetchError: errorDetails[] may hold a google.rpc.RetryInfo.
  const details = (err as { errorDetails?: unknown })?.errorDetails
  if (!Array.isArray(details)) return undefined
  for (const d of details) {
    if (d && typeof d === 'object' && String((d as Record<string, unknown>)['@type'] ?? '').includes('RetryInfo')) {
      return parseDuration((d as Record<string, unknown>).retryDelay)
    }
  }
  return undefined
}

export function isRetryable(err: unknown): boolean {
  const status = statusOf(err)
  if (status !== undefined) return status === 429 || status >= 500
  // fetch() rejects with a TypeError on DNS/connection failures.
  return err instanceof TypeError
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {}
): Promise<T> {
  const { retries, baseDelayMs, maxDelayMs, sleep, onRetry } = { ...retryDefaults, ...opts }
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err
      const reason = statusOf(err) ?? (err instanceof Error ? err.message : String(err))
      const hinted = retryHintMs(err)
      if (hinted !== undefined && hinted > maxDelayMs) {
        console.warn(`[${label}] attempt ${attempt + 1} failed (${reason}); provider asks to wait ${hinted}ms - giving up`)
        throw err
      }
      const backoff = baseDelayMs * 2 ** attempt
      // Half jitter on the computed backoff; a server hint is taken as-is.
      const delay = Math.min(maxDelayMs, hinted ?? Math.round(backoff / 2 + Math.random() * (backoff / 2)))
      console.warn(`[${label}] attempt ${attempt + 1} failed (${reason}); retrying in ${delay}ms`)
      onRetry?.(attempt + 1, delay)
      await sleep(delay)
    }
  }
}
