# 🔔 Dinner Bell

[![CI](https://github.com/salman-khan03/Dinnerbell/actions/workflows/ci.yml/badge.svg)](https://github.com/salman-khan03/Dinnerbell/actions/workflows/ci.yml)

**A kitchen conductor.** Dinner Bell plans a multi-dish meal — Thanksgiving, a Sunday roast, a Hanukkah dinner — so every dish is ready at the same moment, and re-plans instantly when the turkey runs long or a guest count changes. It's not a recipe app and not a timer app: it's a scheduler that understands ovens have two racks, gravy needs the turkey's drippings, and pie wants to be made the night before.

This is the portfolio fork of a project originally built for the Alexa+ track of Amazon's Build, Ship, Shape hackathon (that submission lives at [`../dinner-bell`](../dinner-bell)). The scheduling engine, MCP server, and Alexa+ integration are unchanged; this fork adds a **first-party web app** — normal email/password accounts, a dashboard, a public dish gallery people can fork from, and shareable plan links — so the product stands on its own without an MCP client or a hackathon judge in the loop.

## What's new in this fork

- **`web/app/`** — the actual product: sign up, plan a meal, report progress, watch it replan live, all through a normal web UI (`src/server/webapp.ts` is the REST API behind it, cookie-session auth, no OAuth dance).
- **Public dish gallery** (`#/discover`): publish a dish you've added, anyone can fork it into their own kitchen (`DinnerBell.forkDish` in `src/server/service.ts`).
- **Shareable plans** (`/p/:slug`): a no-login-required read-only link to a live plan — the fastest way to show this project to someone.
- The MCP server, `/sim` Alexa+ simulator, and OAuth/PKCE linking flow are **still here**, untouched, at `/mcp` and `/sim` — same engine, same data, different front door.

**131 tests** (117 inherited + 14 new, covering auth, plan creation without elicitation, sharing, and publish/fork).

## Running it

```bash
npm install
npm run dev
```

Opens on `http://localhost:8787`. Sign up, plan a meal, explore `#/discover`. The Alexa+ side (`/sim`, `/mcp`) still works exactly as documented below.

## Deploying

The one thing this fork deliberately did **not** change: `src/server/store.ts` is still a JSON file on disk (`DATA_DIR`), the same dependency-free choice that made sense for a hackathon judge running it locally. For a real deployment:

1. **Swap the store for Postgres.** `Store` is a small class with an explicit method surface (`ensureHousehold`, `savePlan`, `createUser`, `publishDish`, `sharePlan`, ...) — that's the one file to rewrite against a real driver (Neon and Supabase both have generous free tiers). Nothing outside `store.ts` needs to change.
2. **Host it.** It's one Node process (`node --run start` after `npm run build:ui`) — Render, Railway, or Fly all work with zero config beyond `PORT`, `PUBLIC_URL`, and `DATA_DIR`.
3. **Set `PUBLIC_URL`** to your real domain so cookies get marked `Secure` and OAuth discovery advertises the right issuer.

I stopped short of doing this myself in this pass so the fork stays a clean, reviewable diff from the hackathon submission rather than mixing "new feature" with "infra migration" in one shot.

---

Everything below this line is the original hackathon README, describing the Alexa+/MCP side that's still fully intact in this fork.

---

Built for the **Alexa+** track of the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/), with a working **AWS Builder** (Amazon Bedrock) integration.

- **MCP server**: `src/server/mcp.ts` — spec **2025-11-25+**, Streamable HTTP, served alongside the 2026-07-28 era from one tool factory.
- **Try it live**: `npm run dev`, then open `/sim` — a real OAuth-linked, real MCP-client, real [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)-hosted simulator standing in for an Alexa+ device.
- **117 automated tests**, all against real protocol implementations (a real `@modelcontextprotocol/client`, real HTTP, real OAuth) — no mocks of the interesting parts.

## Why this, and why it's hard

Alexa+ is good at *one* request → *one* action. A holiday meal is the opposite: eight dishes, one oven, contradictory constraints (the turkey needs the whole oven for three hours; the sides need that same oven for the last forty minutes of the turkey's rest), and it all falls apart the moment reality disagrees with the plan — which it always does. The interesting engineering problem isn't the voice interface; it's the scheduler underneath it, and making that scheduler fast and honest enough to re-run on every "the gravy needs ten more minutes" without the person noticing a pause.

`src/engine/planner.ts` does that: a backward serial-schedule generator with conflict-directed reordering, degrading gracefully (margin → relaxed rest windows → "here's the earliest we can honestly serve") instead of either lying about the timeline or grinding to a halt. It's the one piece of this project I'd point a reviewer at first.

## Quickstart

```bash
npm install
npm run dev
```

Opens on `http://localhost:8787` with anonymous demo mode on (no account linking needed locally). Two things to try:

- **The simulator**, a real device stand-in: `http://localhost:8787/sim`. Sign in (or use "Try a demo kitchen"), then say things like *"plan Thanksgiving dinner for 10 at 5"*, *"the turkey is in the oven"*, *"the gravy needs ten more minutes"*. The 🕐 badge fast-forwards the simulated clock to real Thanksgiving Day so you don't have to wait for it.
- **The MCP server directly**, from any MCP-capable client: `http://localhost:8787/mcp`. `npm run dev` leaves auth off, so `npx @modelcontextprotocol/inspector http://localhost:8787/mcp` connects immediately.

```bash
npm run typecheck   # tsc --noEmit, zero errors
npm test             # vitest, 117 tests
```

See [`.env.example`](.env.example) for every environment variable (production OAuth, Alexa+ account-linking client, AWS Builder / Bedrock, host hardening).

## Architecture

```
src/engine/     Pure scheduling logic. No I/O, no MCP, no HTTP — just data in, a Schedule out.
  types.ts        The data model: dishes, tasks, kitchens, plans, schedules.
  library.ts      ~25 dishes across American/Jewish/South Asian/Chinese/Italian tables, with
                   real cross-dish constraints (gravy needs the turkey; potatoes must be mashed
                   within minutes of draining; pie wants to be made the day before).
  time.ts         Time-zone-correct minute math and a lenient spoken-time parser
                   ("6pm", "thursday at 5", "thanksgiving at 5").
  planner.ts      The scheduler. See below.
  progress.ts     Turns "the turkey's done" into a progress record; diffs two schedules to say
                   what moved.
  voice.ts        Renders a Schedule as short, markup-free sentences.

src/server/     MCP + HTTP + OAuth. Talks to the engine; never does scheduling math itself.
  mcp.ts          The 9 MCP tools, an MCP Apps resource, a resource, a prompt.
  service.ts      Domain operations (plan_meal, whats_next, report_progress, ...), independent
                   of MCP — takes an injected `ask` function for elicitation.
  auth.ts         OAuth 2.1 authorization server: PKCE-only, RFC 8707 resource indicators,
                   RFC 8414/9728 discovery, its own sign-in page.
  http.ts         The HTTP front door. Serves 2025-11-25 (stateful sessions, for elicitation)
                  and 2026-07-28 (stateless) from one tool factory.
  store.ts        Persistence (JSON file, atomic writes) — households, plans, tokens.
  views.ts        The JSON shape a plan takes on the wire (tool structuredContent + the UI's
                   data source).
  sim-routes.ts   Static hosting + intent endpoint for the simulator SPA.

src/app/timeline/   The MCP App: a Gantt-style cooking timeline, rendered inside Alexa+ (or any
                     MCP Apps host) via the ui:// resource the tools declare.

src/sim/orchestrators/   Turns one utterance into one tool call.
  bedrock.ts        AWS Builder path: Amazon Bedrock's Converse API, given the server's live
                     tool list as native tool-use config.
  rules.ts          Offline fallback: a small, auditable intent grammar. No API key needed.

web/sim/         The simulator SPA: real OAuth (PKCE), a real MCP client with real elicitation,
                 a real MCP Apps host (AppBridge) mounting the timeline in a sandboxed iframe.
```

### The scheduler, briefly

`computeSchedule(input, progress, now)` builds a task graph from the chosen dishes (dependencies with min/max gaps — a turkey's 30–60 minute rest is exactly a `{minGap: 30, maxGap: 60}` edge to carving), then places tasks backward from the serve time with a priority-ordered greedy pass. Resource conflicts (oven rack slots, oven-temperature compatibility, burner count, cook attention) are tracked on per-minute timelines. When a task can't be placed, the *specific task that blocked it* gets boosted in priority and the pass reruns — conflict-directed backjumping, not blind retries — and if that still doesn't fit, hold windows relax in three steps before the plan is honestly reported `late` with a new achievable time. Make-ahead dishes (pie, cranberry sauce) get pre-placed the evening before, but never during the household's sleeping hours. It's deterministic and runs in single-digit milliseconds even for a 9-dish, 24-task Thanksgiving plan, so replanning after every voice report is free.

`test/engine.test.ts` includes an **independent constraint checker** (`test/helpers.ts:violations`) that re-derives every hard constraint from the raw dish data rather than reusing planner internals — a scheduler bug can't hide behind a matching checker bug — and runs it across every built-in menu × 1/2/3 cooks × 1/2 ovens × four start times × two guest counts × two "now" values (`test/engine.test.ts:184`), on top of targeted tests for the Thanksgiving happy path, replanning mid-cook, and honest failure.

## Alexa+ / MCP specifics

- **Protocol**: `createMcpHandler` (SDK v2) serves 2026-07-28 directly and 2025-11-25 — what Alexa+ speaks today — through a hand-wired, *stateful* Streamable HTTP session (`src/server/http.ts`). Elicitation needs statefulness: the server asks a question on an open response stream, and the answer arrives as a separate POST that has to reach the same server instance, which the SDK's default per-request legacy handling can't do. Sessions are bound to the household that opened them (`test/http.test.ts`: *"a stolen session id cannot be used by another household"*).
- **Elicitation**: every "which dishes, what time, how many guests, how many cooks" gap is asked through real MCP elicitation — flat-primitive JSON Schema forms only, as Alexa+ requires (`test/mcp.test.ts`: *"every elicitation schema is flat primitives"*). Clients that can't elicit (older clients, the 2026-07-28 era) get a `needs_input` field instead, so the calling model can ask in its own words rather than the tool call failing.
- **MCP Apps**: `plan_meal`, `whats_next`, `report_progress`, `change_plan`, `show_timeline`, and `get_prep_checklist` all declare `_meta.ui.resourceUri`, rendering the cooking timeline inline. The simulator hosts it exactly as a real device would — `AppBridge` + `PostMessageTransport` into a sandboxed iframe, not a shortcut.
- **Account linking**: OAuth 2.1, PKCE with S256 mandatory, `resource` (RFC 8707) on both `/authorize` and `/token`, RFC 8414 + RFC 9728 discovery documents, bearer tokens in the header only (query-string tokens are explicitly rejected — `test/http.test.ts`: *"ignores tokens in the query string"*), refresh-token rotation, single-use authorization codes, `/.well-known/oauth-protected-resource` on 401.
- **Tool descriptions** are written for the model that picks them (Alexa+'s own orchestrator), not for a human reading docs: each says *when* to use it, with example phrasings, per `src/server/mcp.ts`.

## AWS Builder mini-challenge

Set `BEDROCK_MODEL_ID` (and standard AWS credentials) and the simulator's intent step — "which tool should this utterance call?" — is decided by a real **Amazon Bedrock** model over the Converse API's native tool-use, given the server's *live* tool list as `toolConfig` (`src/sim/orchestrators/bedrock.ts`). This is the same decision Alexa+'s own orchestrator makes in production, made here by a real model instead of a hand-written grammar. Without a model ID it falls back to `rules.ts`, an offline, auditable intent grammar, so the whole demo still works with zero API keys — and so the fallback path is exactly as testable (`test/rules.test.ts`, 20 tests) as the Bedrock path is real.

## Open Source mini-challenge

MIT-licensed (`LICENSE`), public repository, built during the hackathon window.

## Testing philosophy

No test in this repo mocks the interesting part. `test/mcp.test.ts` and `test/http.test.ts` run a real `@modelcontextprotocol/client` — with a real elicitation handler — against the real server, over a real in-memory-linked transport and then over real HTTP with real sessions. `test/http.test.ts` runs the OAuth flow as an actual PKCE client would: fetch discovery metadata, drive `/authorize`, exchange the code, verify the code is bound to *that* verifier and is single-use, verify a stolen session id can't cross households. The one thing genuinely hard to unit-test — the browser-side `AppBridge`/iframe host handshake — was instead verified live end-to-end in a real browser against the real running server (sign-up → elicitation modal → real-time replanning visibly updating the mounted MCP App); see the friction log for what that surfaced.

## Known limitations

- The MCP Apps host handshake (`web/sim/app.ts`'s `mountApp`) is exercised live but not under an automated browser test — jsdom doesn't implement cross-window `postMessage`/`contentWindow` well enough to drive `AppBridge` realistically. It's a small, isolated function; a Playwright pass would be the natural next step.
- The dish library covers ~25 dishes across seven cuisines; `add_family_recipe` lets a household teach it a new one on the fly, but it isn't a general recipe importer.
- Persistence is a single JSON file with atomic writes — correct and dependency-free for a hackathon deployment, not a production datastore. `src/server/store.ts` isolates it behind a small interface so swapping in DynamoDB is a one-file change.

See [`FRICTION_LOG.md`](FRICTION_LOG.md) for specific friction hit against the MCP SDK v2 and MCP Apps documentation while building this.

---

*Track: Alexa+. Mini-challenges: AWS Builder, Open Source.*
