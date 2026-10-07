/**
 * The Express app, separate from server/index.ts (which validates the AI
 * provider and listens) so the API can be exercised in tests without a key.
 */

import express from 'express'
import cors from 'cors'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { GameEngine, TurnRejectedError } from './engine.js'
import { isAllowedOrigin, isBadRequest, parseCommandBody, parseStartBody } from './http.js'

export function createApp(engine: GameEngine, opts: { serveDist?: boolean } = {}) {
  const app = express()

  // Reject cross-site browser requests outright (a text/plain form POST skips the
  // CORS preflight), then allow CORS only for the local UI.
  app.use((req, res, next) => {
    if (!isAllowedOrigin(req.headers.origin)) {
      res.status(403).json({ error: 'origin not allowed' })
      return
    }
    next()
  })
  app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) }))
  app.use(express.json({ limit: '16kb' }))

  // Current game state plus the Human vs AI session (phase, turn, report, ...)
  app.get('/api/state', (_req, res) => {
    res.json({ ...engine.state, recentEvents: engine.recentEvents, session: engine.sessionInfo() })
  })

  // Get chat log (index-based to avoid duplicates)
  app.get('/api/chat', (req, res) => {
    const since = parseInt(req.query.since as string) || 0
    const messages = engine.chatLog.slice(since)
    res.json({ messages, total: engine.chatLog.length })
  })

  // Get turn history
  app.get('/api/turns', (req, res) => {
    const since = parseInt(req.query.since as string) || 0
    const turns = since > 0
      ? engine.turnHistory.filter(t => t.turn > since)
      : engine.turnHistory
    res.json(turns)
  })

  // Start a game: the player picks one faction; the other two are AI.
  app.post('/api/start', (req, res) => {
    const parsed = parseStartBody(req.body)
    if (isBadRequest(parsed)) {
      res.status(parsed.status).json({ error: parsed.error, code: parsed.code })
      return
    }
    const { gameId, turn } = engine.start(parsed.playerName, parsed.humanFaction)
    res.json({ status: 'started', gameId, turn, humanFaction: parsed.humanFaction, playerName: parsed.playerName })
  })

  // The human's orders for the current turn. Nothing advances without this call.
  app.post('/api/player-command', async (req, res) => {
    const parsed = parseCommandBody(req.body)
    if (isBadRequest(parsed)) {
      res.status(parsed.status).json({ error: parsed.error, code: parsed.code })
      return
    }
    try {
      const result = await engine.submitCommand(parsed)
      res.json({ status: 'resolved', ...result, session: engine.sessionInfo() })
    } catch (err) {
      if (err instanceof TurnRejectedError) {
        res.status(err.status).json({ error: err.message, code: err.code, ...err.extra })
      } else {
        console.error('player-command failed:', err)
        res.status(500).json({ error: 'Game server error. Please restart the round.', code: 'server_error' })
      }
    }
  })

  // Back to faction selection with a fresh world; any turn still in flight is discarded.
  app.post('/api/reset', (_req, res) => {
    engine.reset()
    res.json({ status: 'reset' })
  })

  // Production: serve the built client (npm run build) from the same origin.
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
  if (opts.serveDist !== false && existsSync(resolve(distDir, 'index.html'))) {
    app.use(express.static(distDir))
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile('index.html', { root: distDir }))
  }

  return app
}
