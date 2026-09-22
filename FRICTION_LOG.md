# Friction log

Specific, reproducible friction hit while building Dinner Bell against the MCP TypeScript SDK v2, MCP Apps (`ext-apps`), and the Alexa+ MCP Toolkit docs. Each entry is something that cost real time; I've noted what would have saved it.

## 1. `AppBridge`/`App` initialization order is a documented pattern, but not a documented *hazard*

The SDK's own example (`app-bridge.examples.ts#AppBridge_basicUsage`) shows the correct pattern — set `bridge.oninitialized` before `connect()`, and only call `sendToolInput`/`sendToolResult` from inside it. What isn't called out anywhere is *why this order matters*: calling `sendToolInput`/`sendToolResult` right after `bridge.connect()` resolves (which only means the *host's* transport is listening, not that the View has finished its own `ui/initialize` handshake) silently drops the notifications, because the View hasn't registered its handlers yet. I built this the "obvious" way first — `await bridge.connect(transport); await bridge.sendToolResult(result)` — and it consistently rendered an empty view with the initial tool call, with no error, no warning, nothing in the returned promises. The console log line order was the only signal (`Sending message tool-result` appeared *before* `Parsed message ui/initialize`).

**Would have saved ~40 minutes**: one sentence in the `AppBridge` class doc — "notifications sent before `oninitialized` fires are dropped; the View has not yet registered handlers" — or better, having `sendToolInput`/`sendToolResult` themselves queue until after the initialize handshake instead of firing into the void.

## 2. Server-request-shaped elicitation vs. multi-round-trip `inputRequired` is a hard fork, discovered by trial, not by warning

Building the elicitation flow, I initially wrote `ctx.mcpReq.elicitInput(...)` per the `servers/elicitation.html` guide, which documents it as the primary API. Only while reading `protocol-versions.html` separately did I learn this throws on a 2026-07-28-era connection (`elicitInput` is fully deprecated on that wire, replaced by returning `inputRequired(...)` from the handler). Since Alexa+ specifically requires 2025-11-25, this ended up being the right call either way — but the elicitation guide doesn't mention the fork at all, and I only found it because I happened to also read the protocol-versions page for an unrelated reason. Since my server needed to serve *both* eras from one tool factory (so a non-Alexa+ MCP client can also connect), I had to write the same "ask a question" logic twice under one `Ask` abstraction (`src/server/service.ts`), catching the throw on the modern era and falling back to a `needs_input` field.

**Would have saved ~25 minutes and one design iteration**: a "Protocol version differences" callout directly on the elicitation page (the SDK site does have this pattern elsewhere — `protocol-versions.html` exists — it's just not cross-linked from the page where a builder would actually be standing when they hit it).

## 3. `createMcpHandler`'s legacy path is deliberately stateless, and that's the correct behavior — but it's a hard stop for elicitation, discovered only by writing the session logic myself

`createMcpHandler`'s docstring is admirably precise about this ("each legacy request is answered by a fresh instance... GET and DELETE are answered with 405"), so this isn't a documentation gap so much as a note that the *natural* first implementation of an Alexa+-facing MCP server (`createMcpHandler` straight out of the quickstart) cannot support elicitation at all, since a question-then-answer round trip needs the second POST to land on the same server instance a session ID ties it to. I ended up hand-wiring `NodeStreamableHTTPServerTransport` with `sessionIdGenerator`/`onsessioninitialized` myself (`src/server/http.ts`), which is exactly the pattern the SDK docs point to for "an existing sessionful streamable HTTP wiring" — but a builder coming from the Alexa+ MCP Toolkit quickstart (which doesn't mention this at all) would reasonably assume `createMcpHandler`'s defaults are sufficient, since elicitation is a headline Alexa+ feature.

**Would have saved a design iteration**: the Alexa+ MCP Toolkit quickstart could say, in one line, "elicitation requires a stateful legacy session; `createMcpHandler`'s default stateless fallback does not support it" — this is Alexa+-specific guidance that belongs in Amazon's docs, not just the generic SDK's.

## 4. Bedrock Converse's `DocumentType` rejects a plain `Record<string, unknown>` with an unhelpful structural-diff error

Passing a JSON Schema object (from an MCP tool's `inputSchema`, itself `Record<string, unknown>`) as `toolSpec.inputSchema.json` fails to typecheck against `DocumentType`, and the TS error is a multi-line structural diff against `DocumentType[]` (`Type 'Record<string, unknown>' is missing the following properties from type 'DocumentType[]': length, pop, push, concat, and 35 more`) that doesn't mention `DocumentType` is a recursive JSON-value type until several lines down. `DocumentType` isn't re-exported from `@aws-sdk/client-bedrock-runtime` either — it's on `@smithy/types`, an unlisted transitive dependency, so it took a `grep -r` through `node_modules` to find the actual cast target.

**Would have saved ~10 minutes**: re-export `DocumentType` from `@aws-sdk/client-bedrock-runtime` itself (it's the type every `toolConfig`/`toolResult` caller needs), or accept `unknown` at the SDK boundary and validate internally.

## 5. A self-authored CSP silently broke my own inline script — worth flagging as a general trap, not an SDK issue

Not an SDK friction point, but worth recording since it cost real debugging time and is a mistake other MCP-server-plus-OAuth-page builders will make identically: I set a strict `Content-Security-Policy: default-src 'none'` on the `/authorize` sign-in page (reasonable — it's a credential-entry page) and separately included a small inline `<script>` to auto-fill the browser's time zone into a hidden field. `default-src 'none'` silently blocks `script-src` too (no `script-src` directive means it falls back to `default-src`), so the script never ran and the field stayed empty — no console error surfaced during a plain HTTP fetch-based test; it only showed up once I drove the flow in an actual browser and read the console. Fixed with a per-response nonce (`src/server/auth.ts`), but it's a reminder that **HTTP-request-level tests cannot catch CSP breakage** — only a real browser render does, which is exactly why the browser-driven verification pass mattered for this project (see `README.md`'s testing-philosophy note) and would matter for any MCP-Apps-adjacent hackathon entry that ships a login or consent page.

---

None of these blocked shipping — every one was worked around within the session — but each cost real time that a one-sentence doc addition, a re-exported type, or a cross-link between two already-written pages would have saved.
