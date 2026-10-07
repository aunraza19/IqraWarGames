# Contributing

Thanks for your interest. War Games: Human vs AI is a small strategy game: a human commands
one faction in natural language (an AI interpreter turns that into orders), two LLM-driven
factions play the others, and a deterministic turn engine decides every outcome. The bar for
a good PR is "it type-checks, a full game still runs end to end, and the AI contract survives".

## Getting set up

```sh
npm install                 # Node >= 20
cp .env.example .env        # add ONE provider key - Gemini is the cheapest default
npm run dev                 # client on :3000, server on 127.0.0.1:3001
```

Open http://localhost:3000, pick a faction and type your orders. If a turn never resolves,
the problem is almost always the provider key or a model reply that failed validation -
check the server console (it logs the interpreter's proposed orders and the per-turn model
call count) before anything else.

## Before you open a PR

1. **`npm run typecheck`, `npm run lint`, `npm test` and `npm run build` must pass** (CI runs
   all four). `npm test` covers the turn resolver (`server/engine.test.ts`) and the Human vs
   AI turn lifecycle (`server/turn.test.ts`) with the provider mocked, so it needs no API
   key; a rules change should come with a test. Do not add `any` (lint rejects it) or an `eslint-disable` to get
   past them.
2. **Play a full game.** Turn resolution, combat, research, diplomacy and the nuke path all
   live in `server/engine.ts`, and a change to one of them routinely breaks another. Watching
   a whole game resolve catches more than any amount of reading will.
3. **Touched the AI layer?** Run at least two providers. `server/ai-provider.ts` abstracts
   Gemini, OpenAI and Anthropic behind one `generate(prompt)` call, and they disagree about
   JSON, refusals and token limits. A change validated on Gemini alone is half-validated.
4. **Docs move with code.** New env var, new order type, new faction behaviour? Update the
   matching table in `README.md` in the same PR.

## Ground rules that bite newcomers

- **Model output and player commands are untrusted input.** Everything a model returns is
  parsed into orders and validated (`server/orders.ts`) before the engine sees it. Any new
  order type needs a schema variant in `server/ai.ts`, a check in `validateOrders()` and a
  resolver case, and must fail closed on a malformed or hostile response.
- **Every turn costs quota.** A turn is at most 3 model calls (interpreter + two AI
  factions) and only when the player submits - no timer, no narrator call. The cheap
  default models, compact JSON and the timeouts in `server/config.ts` are cost controls,
  not style choices. A PR that adds a model call per turn needs to say why.
- **Providers are configured per role.** `NATO_AI_PROVIDER`, `RUSSIA_AI_PROVIDER`,
  `CHINA_AI_PROVIDER` and `INTERPRETER_AI_PROVIDER` each fall back to the global `AI_PROVIDER`.
  Code that reads the global directly instead of the resolved per-faction value will look
  correct and behave wrongly in mixed-provider games.
- **`OPENAI_BASE_URL` is a supported path, not a hack.** Local models via Ollama, LM Studio
  or vLLM go through it. Don't hard-code `api.openai.com`.
- **State is in-memory and server-owned.** There is no database. A restart is a new game,
  and anything you need across turns belongs in the game state object rather than in a
  module-level variable. The browser never sends state, results or scores.

## Faction personas

The personas in `game/factions/` are prompt material, not decoration. They are written as
strategic doctrine because the models follow them; edits there change how the game plays far
more than an engine tweak usually does. Say so in the PR description if you touch one.

## Reporting bugs

Use the issue templates. The single most useful thing you can include is **which provider
each faction was running** and the server console output for the turn that broke - "the AI
did something weird" and "the parser rejected the AI's response" are different bugs here.

## Security

Never commit a `.env` or paste an API key into an issue. See
[SECURITY.md](https://github.com/NoblerWorks-HQ/.github/blob/main/SECURITY.md) for how to
report a vulnerability privately.
