# pi-native (auth-gateway streaming transport)

**This document no longer describes a tool-call serialization.** omp's own in-band tool-call dialect — formerly called "pi-native" and specified here — has been removed. The name **pi-native** survives only as the *streaming transport* used to route model traffic through an `omp auth-gateway`. Both the removal history and today's transport are covered below.

## The removed tool-call dialect

The omp / pi coding agent once serialized tool calls **in-band** — as text inside the assistant turn — under the name pi-native:

- **XML dialect** (original): each call was an XML-flavored block named after the tool, `<call:NAME …> … </call:NAME>`, with schema-driven value coercion, attribute shorthand for scalar arguments, and a verbatim inline body for bulk string payloads. This document was that format's specification.
- **Sigil dialect** (replacement; v16.0.10, commit `f743ddc`, 2026-06-19): the XML was replaced by a sigil-delimited format built from single-token markers that never occur in source code — a `§` call header with inline `key=value` scalars, a `«…»` verbatim body fence (escalating to `««…»»` to avoid collisions with re-rendered history), `¤` reasoning, and `‡‡` tool results — at roughly 46% fewer tokens. Selected via `tools.format: "pi"` or `PI_DIALECT=pi`.
- **Removal** (v16.2.2, 2026-06-27, commit `053da98`): the pi dialect was deleted outright. `dialect/pi.ts`, `dialect/pi.md`, and both selection knobs (`tools.format: "pi"`, `PI_DIALECT=pi`) are gone, and nothing in `packages/ai` emits or parses either spelling. Models with native tool-calling APIs use those APIs directly; the in-band dialects that remain serve third-party model families and are documented per family in this folder (the live list is the table in `packages/ai/src/dialect/factory.ts`: glm, hermes, kimi, xml, anthropic, deepseek, minimax, harmony, qwen3, gemini, gemma).

If you hold old references to `<call:…>` blocks or `§` headers as "the omp tool-call format": they describe a format that no longer exists. There is no successor — omp no longer needs an owned tool-call dialect for its own models.

## The pi-native transport (today)

"pi-native" now names the **auth-gateway SSE transport**. A `Model` with `transport: "pi-native"` does not dispatch to a provider SDK at all: `streamSimple()` short-circuits the per-provider dispatch (`packages/ai/src/stream.ts`) into `streamPiNative` (`packages/ai/src/providers/pi-native-client.ts`), which talks to an auth gateway over HTTP.

- **Request** — `POST {model.baseUrl}/v1/pi/stream` with `{ modelId, context, options }`. The body carries pi-ai's canonical `Context` verbatim — no OpenAI/Anthropic wire-format round-trip — so first-class fields (thinking budgets, service tier, cache markers, tool choice) survive the hop without translation loss. `options.apiKey` is the *gateway bearer*, sent as the `Authorization` header; the real provider credential never reaches the client.
- **Gateway side** — `omp auth-gateway serve` (`packages/ai/src/auth-gateway/server.ts`, `handlePiNative`) resolves the requested `modelId`, obtains a provider credential, and re-dispatches through the ordinary per-provider streaming path. The gateway is itself a broker client: it holds no local credential store but pulls credential snapshots from an auth broker (`packages/ai/src/auth-broker/`, configured via `OMP_AUTH_BROKER_URL` or `auth.broker.url` in config.yml).
- **Response** — every `AssistantMessageEvent` is serialized verbatim and SSE-framed (`data: {…}\n\n`, terminated by `data: [DONE]`; see `packages/ai/src/providers/pi-native-server.ts`). The client feeds each parsed event straight into a local `AssistantMessageEventStream`, so downstream consumers cannot tell a gateway hop from a direct provider stream. First-event and idle watchdogs turn stalled streams into `StreamTimeoutError`s; an SSE close without a terminal event synthesizes a `done`/`error` event so `.result()` always resolves. Errors use an OpenAI-like `{"error": {"type", "message"}}` envelope. The gateway contract also has a non-streaming mode (`stream: false` → `{ message: AssistantMessage }`), but the bundled client always streams.
- **Tool calls** — there is **no in-band tool serialization** anywhere in this transport. Tool calls arrive exactly as the upstream provider emits them: structured `toolCall` blocks in the streamed `AssistantMessage` (`{ type: "toolCall", id, name, arguments }` in `packages/ai/src/types.ts`), in whatever wire format the gateway's resolved provider speaks.

### When a model gets `transport: "pi-native"`

It is a configuration override, not something model discovery infers: set `transport: "pi-native"` on a provider in `models.yml` (see the `Model.transport` field in `packages/catalog/src/types.ts`), with `baseUrl` pointing at the gateway host. Typical topology: containerized omp deployments (robomp slots, the swarm extension) route every LLM call through a credential-holding sidecar gateway so the slot itself stays credential-free. The model's other metadata (pricing, context window, thinking config) still resolves locally; only the streaming dispatch is redirected.
