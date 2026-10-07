import 'dotenv/config'
import { GameEngine } from './engine.js'
import { createApp } from './app.js'
import { GAME_CONFIG } from './config.js'

// Validate AI provider on startup
import { validateProviders, logProviderConfig } from './ai-provider.js'
try {
  logProviderConfig()
  await validateProviders()
} catch (err) {
  console.error(`\n${'='.repeat(60)}`)
  console.error('AI PROVIDER NOT CONFIGURED')
  console.error('='.repeat(60))
  console.error(err instanceof Error ? err.message : String(err))
  console.error('\nCopy .env.example to .env and add your API key.')
  console.error('See README.md for setup instructions.')
  console.error('='.repeat(60) + '\n')
  process.exit(1)
}

const PORT = 3001
// Loopback only by default: every game spends the user's provider key.
// Set HOST=0.0.0.0 to expose it on the LAN deliberately.
const HOST = process.env.HOST || '127.0.0.1'

const engine = new GameEngine()
engine.reset()
const app = createApp(engine)

app.listen(PORT, HOST, () => {
  console.log(`War Games: Human vs AI running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
  console.log(`Event mode: ${GAME_CONFIG.maxTurns} turns, ${GAME_CONFIG.maxOrdersPerTurn} orders per turn, no automatic turns, no narrator calls`)
  console.log('Endpoints:')
  console.log('  GET  /api/state           - Game state + session')
  console.log('  GET  /api/chat            - Chat log')
  console.log('  GET  /api/turns           - Turn history')
  console.log('  POST /api/start           - Start a game { playerName, humanFaction }')
  console.log('  POST /api/player-command  - Submit orders { gameId, turn, command }')
  console.log('  POST /api/reset           - Back to faction selection')
})
