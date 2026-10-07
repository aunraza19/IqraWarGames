# War Games: Human vs AI

**Choose your faction. Command it in plain English. Outthink two autonomous AI opponents.**

A fresher-week edition of [War Games](https://github.com/NoblerWorks-HQ/WarGames) by Nobler Works. Three great powers - NATO, Russia and China - fight for territory, resources and global dominance on an interactive world map. In the original, all three factions are AI. Here **one faction is you**: pick it on the start screen, type your strategy in natural language ("Take Ukraine with my Polish infantry, fortify Western Europe and research the economy"), and an AI command interpreter turns that intent into legal game orders. The other two factions stay autonomous AI. A deterministic game engine decides every outcome.

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)
![Leaflet](https://img.shields.io/badge/Leaflet-199900?logo=leaflet&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?logo=googlegemini&logoColor=white)
![License MIT](https://img.shields.io/badge/License-MIT-green)

![Nuclear Launch Detected](screenshots/wargames-nuclear-launch-detected.png)

## How a game goes

1. **Start screen** - enter a commander name (optional), choose **NATO**, **Russia** or **China**, press **BEGIN**. The roster shows `YOU` for your faction and `AI` for the other two.
2. **Your orders** - each turn, type what you want in the box under the map and press **EXECUTE ORDERS** (or Enter). Not sure what to type? The **Action Assistant** below the box suggests 4-5 actions you can take right now, and **ALL ACTIONS** opens every action in the game - what it does, whether you can use it this turn (and why not), and example orders. Clicking an example only writes it into the box, so you can edit it, combine several, then execute.
3. **AI interpretation** - the interpreter reads your faction's current briefing and maps your intent to up to 3 legal orders (the same limit the AI factions have). Impossible parts ("send aliens", "launch nukes" without warheads) are replaced with the closest legal action or dropped, with a short note.
4. **Resolution** - the two AI factions plan from the same snapshot of the board; the engine resolves all three factions' orders, the map animates, and a turn report shows what worked (✓) and what didn't (✕).
5. **Next turn** - nothing happens until you act. There is no timer.
6. **End** - after 8 turns (or earlier, on a victory condition) you get **VICTORY**, **DEFEAT** or **DRAW**, your final score, and a place on the per-faction leaderboard. **PLAY AGAIN** returns to the start screen.

If your command can't be turned into any legal order ("asdfgh", "hello", a request that is impossible right now), you get a friendly explanation and **your turn is not used**.

## Quick start

Requires **Node.js 20+** (developed on Node 24 / npm 11) and one AI provider key - a free [Gemini API key](https://aistudio.google.com/apikey) is enough.

```bash
npm ci                    # install exact locked dependencies
cp .env.example .env      # then put your key in .env: GEMINI_API_KEY=...
npm run dev               # client on http://localhost:3000, API on 127.0.0.1:3001
```

Open http://localhost:3000.

For a booth machine you can serve the built client from the API server instead:

```bash
npm run build && npm start   # everything on http://localhost:3001
```

The API listens on 127.0.0.1 only. Set `HOST=0.0.0.0` to expose it on your network deliberately - every turn spends your provider key.

## Configuration

`.env` (copy from `.env.example`). Only one provider key is required.

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | - | Google Gemini key (default provider) |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Gemini model |
| `AI_PROVIDER` | `gemini` | Default provider: `gemini`, `openai` or `anthropic` |
| `NATO_AI_PROVIDER` / `RUSSIA_AI_PROVIDER` / `CHINA_AI_PROVIDER` | _(default)_ | Provider for that faction **when it is AI-controlled** |
| `INTERPRETER_AI_PROVIDER` | _(default)_ | Provider for the human command interpreter |
| `MAX_TURNS` | `8` | Turns per game (1-30). The game can end earlier on a victory condition |
| `AI_REQUEST_TIMEOUT_MS` | `15000` | Timeout for one model request |
| `AI_MAX_RETRIES` | `2` | Retries for a 429 / 5xx / network failure |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_REASONING_EFFORT` | - | Optional OpenAI (or OpenAI-compatible) provider |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | - | Optional Anthropic provider |
| `SKIP_MODEL_CHECK` | _(unset)_ | `1` skips the startup model-id check |
| `HOST` | `127.0.0.1` | Interface the server binds to |

Other event settings (500-character command limit, 3 orders per turn, name length) live in [`server/config.ts`](server/config.ts).

**Startup model check.** On boot the server asks each configured provider whether its model id exists (a metadata request - no tokens). An unknown model or a rejected key stops the server with a message naming the variable to fix; an unreachable provider is a warning only.

## The AI, and what it is allowed to do

```
  player's words ──► AI command interpreter ──► proposed orders
                                                     │
                                                     ▼
                     server-side validation (ids, ownership, adjacency, tech, costs, limits)
                                                     │
                                                     ▼
                            deterministic game engine ──► game state ──► map
```

- **The model proposes, the engine decides.** The interpreter returns JSON constrained by a per-turn schema: one variant per action, and every id field is an enum of the ids your faction may use this turn. The server then validates every order again ([`server/orders.ts`](server/orders.ts)): your own units only, real territories, adjacency, ownership, tech requirements, costs counted across all your orders, one order per unit, at most 3 orders. Invalid orders are dropped with a reason; the rest still execute.
- **Your command is untrusted text.** It is fenced off in the prompt and the interpreter is told it cannot change rules, reveal prompts or keys, grant anything, or act for another faction. Even if a model obeyed an injection, the validator would still refuse anything illegal.
- **Nuclear weapons** follow the existing engine rules (research, build, range, second strike). The interpreter only uses them when the player explicitly asks.
- **The Action Assistant is help, not a second control system.** Its list of actions is built from the engine's own action set, availability is checked with the same validator the interpreter's orders must pass, and every button just writes plain English into the orders box. It makes no model call; nuclear actions are never suggested and only appear under Nuclear / Advanced.
- **No hidden reasoning is shown.** Models return a one-sentence public summary, not chain-of-thought.
- **Nothing a model writes is executed or rendered as HTML.** Player names, commands and model text are displayed as plain text.

### Model calls per turn

| Call | Count |
|------|-------|
| Human command interpreter | 1 (0 for a quick strategy) |
| AI opponents | 2 (one per AI faction, run in parallel with the interpreter) |
| Narrator | **0** - turn reports and headlines are built from resolved events |

So a normal turn is **at most 3 model calls**, and only when the player submits. If your command is refused (not understood, or the interpreter is down), a retry of the same turn reuses the opponents' already generated orders and costs only the one interpreter call. The server logs the count for every turn:

```
[turn 3] model calls: interpreter=1 opponents=2 narrator=0 total=3 (resolved)
```

### Free tier and failures

The Gemini free tier allows about 15 generation requests per minute, so a game paced by a human player stays well under it. When a call still fails:

- **429 / 5xx / dropped connection** - retried at most twice with jittered exponential backoff (1s, 2s; capped at 8s), honouring `Retry-After` and Gemini's `retryDelay`. If the provider asks for a longer wait than the cap, we stop retrying at once instead of freezing the game. The UI shows "AI COMMAND NETWORK BUSY - RETRYING" while it happens.
- **An AI opponent fails** (after retries, timeout, malformed JSON, safety block) - that faction plays a deterministic fallback strategy for the turn ([`server/fallback.ts`](server/fallback.ts)): sensible attacks, recruitment, research or fortification, all validated, never nuclear. The report shows "AI FALLBACK STRATEGY ACTIVE".
- **The interpreter fails** - your turn is not used. Try again, or pick a **quick strategy** (aggressive push, hold the line, build economy, balanced), which the same deterministic planner turns into legal orders without any model call.

## Fairness

Factions are deliberately asymmetric (NATO starts with the most territory and tech, China with the biggest army but two territories). The leaderboard is therefore kept **per faction**. Order resolution rotates every turn (turn 1: NATO, Russia, China; turn 2: Russia, China, NATO; ...) so no faction - and so no choice of human faction - always moves first.

## Scoring

The game's existing score - territories × 3 + total resources ÷ 5 + (military + economic + intelligence tech) × 2 - decides the winner at the turn limit; a shared top score is a draw. Victory conditions (domination, economic, diplomatic) can end the game earlier. Your leaderboard score is `final score × 100`, plus 2,500 for a victory (and 250 per unplayed turn if it came early) or 1,000 for a draw - see [`server/scoring.ts`](server/scoring.ts). The leaderboard lives in the browser's `localStorage` on the booth machine; organisers can clear it with the small "clear scores" link on the start screen. Starting a new game never clears it.

## Architecture

- **Frontend** - Vite + TypeScript + Leaflet. The world map (country borders drawn from `public/countryborders.json`, no tile server), the start screen, the command dock, turn reports, effects and the end screen. It never holds authoritative state; it sends only the player name, faction choice, command text, game id and expected turn.
- **Backend** - Express on 127.0.0.1:3001. One in-memory game at a time (a server restart drops it; there is no save/load).
- **AI** - direct provider calls (Gemini by default, OpenAI and Anthropic optional) through [`server/ai-provider.ts`](server/ai-provider.ts). No agent framework, no MCP.

### API

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| `GET` | `/api/state` | - | World state + `session` (game id, phase, turn, your faction, AI status, report, outcome, score) |
| `GET` | `/api/chat` | `?since=n` | Intelligence feed |
| `GET` | `/api/turns` | `?since=n` | Turn history (command, interpretation, orders, events, model calls) |
| `POST` | `/api/start` | `{ playerName?, humanFaction }` | New game; `humanFaction` is `nato`, `russia` or `china` |
| `POST` | `/api/player-command` | `{ gameId, turn, command }` or `{ gameId, turn, quick }` | Play the current turn |
| `POST` | `/api/reset` | - | Back to faction selection; any turn in flight is discarded |

A submission for the wrong game or turn, a second submission while a turn is processing, or any command after the game ends is refused with `409`. More detail: [`docs/HUMAN_VS_AI.md`](docs/HUMAN_VS_AI.md).

### Project structure

```
server/
  index.ts         - boots: provider check, then the app on 127.0.0.1:3001
  app.ts           - Express routes
  http.ts          - origin check and request validation
  config.ts        - event settings (turns, limits, timeouts)
  engine.ts        - game session, turn lifecycle, resolver, combat, victory
  orders.ts        - order normalisation and legality checks
  assistant.ts     - Action Assistant: action catalogue, availability, lock reasons, suggestions
  ai.ts            - interpreter and AI-opponent calls, response schemas, JSON parsing
  ai-provider.ts   - Gemini / OpenAI / Anthropic behind one generate() call
  retry.ts         - bounded retry with backoff
  fallback.ts      - deterministic fallback / quick-strategy planner
  summary.ts       - deterministic turn reports and headlines
  scoring.ts       - faction score, outcome, leaderboard score
  rules.ts         - shared rule constants (unit stats, costs)
  types.ts
  *.test.ts        - vitest suites (provider mocked; no key or quota used)
src/
  main.ts          - UI controller: start screen, orders, reports, end screen
  leaderboard.ts   - localStorage leaderboard
  prompt.ts        - how an Action Assistant example is inserted into the orders box
  flatmap.ts       - Leaflet map and territory overlays
  effects/         - map and screen animations
  style.css
game/
  factions/        - AI persona prompts (NATO / Russian / Chinese Command)
  initial-world.json, rules.md, tech-tree.json
docs/
  HUMAN_VS_AI.md   - technical notes for maintainers
```

### Modding

[`game/initial-world.json`](game/initial-world.json) holds the map, adjacency, resources and starting units; [`game/factions/`](game/factions/) the AI personas; [`game/rules.md`](game/rules.md) and [`game/tech-tree.json`](game/tech-tree.json) describe the rules. The numbers that are actually enforced are in [`server/rules.ts`](server/rules.ts) and [`server/engine.ts`](server/engine.ts), so change both when you rebalance.

### Nuclear exchange

Unchanged from the original: research the `nuclear` track (5/8/10 knowledge + 3/5/8 uranium); `build_nuke` from nuclear 1 (10 gold + 5 uranium, or 8 + 3 from nuclear 2; at nuclear 3 each build costs every other faction 5 influence); `nuke` needs a warhead and, below nuclear 2, a target next to your territory. A strike destroys every unit there and leaves the territory neutral with no yield. If the victim has nuclear 3 and a warhead, it fires back automatically at a random territory of the attacker.

## Development

```bash
npm run dev        # client + server with hot reload
npm test           # vitest - provider mocked, no API key or quota used
npm run typecheck  # tsc --noEmit for client + server
npm run lint       # eslint
npm run build      # production client build into dist/
npm start          # API + built client on http://localhost:3001
```

CI runs typecheck, lint, test and build on pushes to `main` and on pull requests.

## Credits and licence

Based on [War Games](https://github.com/NoblerWorks-HQ/WarGames) by [Nobler Works](https://noblerworks.com/), MIT licensed. This fork keeps the original licence - see [LICENSE](LICENSE).
