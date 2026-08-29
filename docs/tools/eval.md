# eval

> Execute Python, JavaScript, Ruby, or Julia code in persistent per-language runtimes — one cell per call.

> **Notice:** Do not shell out to `python -c`/`python -e`, `bun -e`, or `node -e` via the `bash` tool for ad-hoc code execution. Use this tool instead — it gives you persistent state across calls, structured `display()` output, image/JSON capture, and proper cancellation/timeout handling that one-shot `-e`/`-c` invocations cannot provide.

## Source
- Entry: `packages/coding-agent/src/tools/eval.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/eval.md`
- Key collaborators:
  - `packages/coding-agent/src/eval/backend.ts` — backend execution contract
  - `packages/coding-agent/src/eval/agent-bridge.ts` — host-side `agent()` bridge into the subagent executor
  - `packages/coding-agent/src/eval/js/executor.ts` — JS backend adapter
  - `packages/coding-agent/src/eval/js/worker-core.ts` — JS execution, VM context, display/log capture
  - `packages/coding-agent/src/eval/js/shared/prelude.txt` — JS global helper installer
  - `packages/coding-agent/src/eval/js/shared/helpers.ts` — JS filesystem/text/env helper implementations
  - `packages/coding-agent/src/eval/py/index.ts` — Python backend adapter
  - `packages/coding-agent/src/eval/py/executor.ts` — kernel session retention, reset, cleanup
  - `packages/coding-agent/src/eval/py/kernel.ts` — subprocess NDJSON runner protocol, display capture
  - `packages/coding-agent/src/eval/py/prelude.py` — Python helper functions and status events
  - `packages/coding-agent/src/eval/rb/index.ts` — Ruby backend adapter (`kernel.ts`, `prelude.rb`)
  - `packages/coding-agent/src/eval/jl/index.ts` — Julia backend adapter (`kernel.ts`, `prelude.jl`)
  - `packages/coding-agent/src/session/streaming-output.ts` — truncation, artifacts, streamed chunks
  - `docs/python-repl.md` — Python kernel/runner internals

## Inputs

Tool parameters are a flat JSON object describing a **single cell** — one eval call runs one cell in one language (`evalSchema` in `packages/coding-agent/src/tools/eval.ts`). State persists within each language across eval calls, tool calls, and subagents, so a multi-step task is a sequence of eval calls that reuse earlier definitions, not one batched call. There is no `*** Cell` header parsing, no language sniffing, and no batched `cells` array.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `language` | `"py" \| "js" \| "rb" \| "jl"` | Yes | Backend selector. `"py"` maps to the IPython-style subprocess kernel (`python` backend); `"js"` maps to the persistent JavaScript VM; `"rb"` and `"jl"` map to the persistent Ruby and Julia kernels. |
| `code` | `string` | Yes | Cell body, verbatim. JSON-encoded — embed newlines, quotes, and indentation directly; no fences, no headers. |
| `title` | `string` | No | Short label rendered in the transcript (e.g. `"imports"`, `"load config"`). |
| `timeout` | `number` | No | Timeout for this eval call in seconds. Defaults to 30 when omitted; clamped to `1..3600` at runtime. |
| `reset` | `boolean` | No | Wipe this language's kernel before running. Reset is per-language: a `py` reset does not touch the JS VM and vice versa. Defaults to `false`. |

The wire schema is session-scoped: `buildEvalSchema()` narrows the `language` enum and field descriptions to the backends enabled for the session, so disabled runtimes are never advertised to the model. The static `evalSchema` carries the full four-language union as the type-level source of truth.

Minimal example matching the live schema:

```json
{ "language": "py", "title": "imports", "timeout": 10, "code": "import json\nfrom pathlib import Path" }
```

## Outputs

Final result from `EvalTool.execute()` is single-shot, but `onUpdate` streams partial text and `details` while the cell runs.

Returned shape:

- `content`: one text block containing the cell's output, `(displayed N image(s); no text output)` when only images exist, or `(no output)` when nothing visible was produced; image outputs are appended as additional image content blocks.
- `details` (`EvalToolDetails` from `packages/coding-agent/src/eval/types.ts`):
  - `cells`: per-cell results — for a single-cell call, one entry with the code, status (`pending`/`running`/`complete`/`error`), output, duration (`durationMs`), exit code, status events, and markdown flag
  - `language`: the backend used by this call
  - `languages`: backends used by this call, in first-use order (a single entry)
  - `jsonOutputs`: structured values emitted via `display(...)`
  - `statusEvents`: aggregated helper/tool status events
  - `notice`: backend fallback notice (currently unused; reserved for future notices)
  - `meta`: truncation metadata
  - `isError`: set on cell failure or cancellation

Renderer behavior in `packages/coding-agent/src/tools/eval.ts`:

- call preview renders the cell's `code` with syntax highlighting based on its declared `language`
- result view renders the cell's status, duration, and output
- markdown outputs are rendered with the Markdown component instead of plain text
- `jsonOutputs` render as a tree, collapsed or expanded depending on UI state
- timeout / truncation notices render as dim metadata lines
- images are returned as content image blocks; live updates may also carry `details.images` while execution is in progress

Side-channel artifacts:

- `session.allocateOutputArtifact?.("eval")` may allocate an `artifact://...` backing store for spilled output.
- Truncated output metadata points at that artifact when available.

## Flow

1. `EvalTool.execute()` in `packages/coding-agent/src/tools/eval.ts` receives the flat params already validated by the ArkType schema — no string parsing step.
2. `execute()` maps `params.language` to an `EvalLanguage` (`"py"` → `"python"`, `"rb"` → `"ruby"`, `"jl"` → `"julia"`, otherwise `"js"`) and calls `resolveBackend(session, language)`:
   - `python` is gated on `resolveEvalBackends(session).python` (the `eval.py` setting, overridden by the `PI_PY` env flag) and `pythonBackend.isAvailable(session)`.
   - `js` is gated on `resolveEvalBackends(session).js` (the `eval.js` setting, overridden by the `PI_JS` env flag).
   - `ruby` is gated on `resolveEvalBackends(session).ruby` (the `eval.rb` setting, overridden by the `PI_RB` env flag; default off) and `rubyBackend.isAvailable(session)`.
   - `julia` is gated on `resolveEvalBackends(session).julia` (the `eval.jl` setting, overridden by the `PI_JL` env flag; default off) and `juliaBackend.isAvailable(session)`.
   - A disabled or unavailable requested backend throws `ToolError`; there is no auto-fallback or sniffing.
3. The tool allocates an `OutputSink`, a `TailBuffer`, a per-cell result object, and a `sessionAbortController`. `session.trackEvalExecution?.(...)` can wrap the whole run for external cancellation tracking.
4. It resolves the executor session id from `session.getEvalSessionId?.()`, falling back to `defaultEvalSessionId(session)`. Subagents inherit the parent's id so both sides share the same runtime for each backend.
5. The single cell executes within the tool call. `execute()`:
   - clamps `params.timeout ?? 30` seconds through `clampTimeout("eval", ...)`
   - wraps the clamped budget in an `IdleTimeout` and combines its signal with the tool signal and the session abort controller (`AbortSignal.any`). The `timeout` is a runtime-work budget, not a wall clock: `EVAL_TIMEOUT_PAUSE_OP`/`EVAL_TIMEOUT_RESUME_OP` status events pause and resume the idle timer so host-side `agent()`/`parallel()`/`completion()` calls do not spend it
   - marks the cell `running` and emits an update
   - calls the backend's `execute()` with `cwd`, `sessionId`, `sessionFile`, `kernelOwnerId`, `session`, `idleTimeoutMs`, `reset` (defaults to `false`), the combined signal, and chunk/status callbacks
6. `js` dispatches through `packages/coding-agent/src/eval/js/index.ts` into `executeJs()`; `py` dispatches through `packages/coding-agent/src/eval/py/index.ts` into `executePython()`; `rb` and `jl` dispatch through the Ruby/Julia backend adapters in `packages/coding-agent/src/eval/rb/` and `packages/coding-agent/src/eval/jl/`.
7. Backend text chunks stream into the shared `OutputSink`; rich outputs are accumulated separately as JSON, images, markdown markers, and status events.
8. After the cell:
   - text output is trimmed and stored on the cell result
   - cancellations return early with `isError: true` and an abort message
   - non-zero exit codes return early with `isError: true` and `Command exited with code N`
9. On success, the tool returns the cell output, synthesizing `(no text output)` or `(no output)` when needed, and attaches truncation metadata from `summarizeFinal()`.
10. The renderer uses `details.cells`, `details.jsonOutputs`, and `details.statusEvents` to build notebook-style output. `mergeCallAndResult = true` and `inline = true`, so call and result render together in the transcript.

## Modes / Variants

### Backend selection

Backend choice is **explicit per call** — there is no auto-detection.

- `language: "py"` → Python (IPython-style subprocess kernel) backend
- `language: "js"` → JavaScript VM backend
- `language: "rb"` → persistent Ruby kernel backend
- `language: "jl"` → persistent Julia kernel backend

Ruby and Julia are opt-in: the `eval.rb` / `eval.jl` settings default to `false` (overridden by the `PI_RB` / `PI_JL` env flags), while `eval.py` / `eval.js` default to `true`. If the requested backend is disabled or unavailable, the tool throws `ToolError` naming the enabled alternatives when any exist. The caller chooses; the tool does not silently substitute.

### JavaScript runtime

Implemented in `packages/coding-agent/src/eval/js/worker-core.ts`, `packages/coding-agent/src/eval/js/shared/prelude.txt`, and `packages/coding-agent/src/eval/js/shared/helpers.ts`.

- Persistent worker-backed VM sessions keyed by `js:${sessionId}`
- `reset: true` calls `resetVmContext(sessionKey)` before the cell executes; reset is destructive for all live runs on that JS session
- Top-level `await` and bare `return` are supported by wrapping code in an async IIFE when `wrapCode()` sees `await` or `return`
- Top-level static `import ... from ...` and dynamic `import(...)` calls are routed through `rewriteImports()`, which sends them via `__omp_import__` so the specifier resolves against the session cwd. Dynamic-import call sites are swapped for a guarded shim (`typeof __omp_import__ === "function" ? __omp_import__ : (s, o) => import(s, o)`) rather than the bare helper identifier: functions handed to puppeteer (`tab.evaluate`, `page.evaluate`, ...) are serialized with `Function.prototype.toString()` and re-evaluated inside the browser page, where the worker-injected helper does not exist, so the shim falls back to native dynamic import there
- Module cache is busted for **local** imports between calls so edits to source files are picked up without restarting the runtime. `__omp_import__` deletes `require.cache[absPath]` before re-importing whenever the original specifier is a filesystem path: relative (`./x`, `../x`, `.`, `..`), POSIX-absolute (`/...`), home-prefixed (`~/...`), or Windows drive-letter (`C:\...` / `C:/...`). Bare specifiers (`react`, `lodash/x`) and URL/scheme specifiers (`node:fs`, `file://...`, `https://...`) are left in cache so package identity stays stable across calls. The cache-bust only fires when the resolved target is an absolute path — unresolved bare-package fallbacks (`resolveImportSpecifier()` returning the original specifier) skip it.
- The prelude installs globals:
  - `display`, `print`, and a `console` bridge
  - `read`, `write`, `env`, `output`
  - `tool.<name>(args)` proxy for arbitrary session tool calls
  - `completion(prompt, opts?)` for oneshot, stateless model calls (see _Oneshot completion helper_ below)
  - `agent(prompt, opts?)` for a single subagent call, plus `parallel()` / `pipeline()` bounded-pool helpers (see _Subagent helper_ below)
  - `log(message)`, `phase(title)`, and `budget` (live token-budget view via async `budget.total()` / `budget.spent()` / `budget.remaining()` / `budget.hard()`)
- JS host/runtime helpers (`read`, `write`, `output`) are async and `await`able; `env` returns synchronously.
- JS helper options may be passed either positionally in the Python order or as a trailing options object. `null` and `undefined` skip positional slots:
  - `await read(path, offset?, limit?)` or `await read(path, { offset?, limit? })`
  - `await agent(prompt, agent?, model?, label?, schema?)` or `await agent(prompt, { agent?, model?, label?, schema?, handle? })`
  - `await parallel([() => agent("a"), () => agent("b")])`
  - `await pipeline(items, stage1, stage2)`
- `display(value)` behavior:
  - plain objects/arrays become JSON outputs
  - `{ type: "image", data, mimeType }` becomes an image output
  - scalars become text
- The VM runs in the host worker's global scope: user code gets the worker's real `process` (intentionally not subsetted — subsetting it segfaulted alongside puppeteer/worker_threads), the injected `fs`, `require`, `createRequire`, and `webcrypto`, plus host globals like `Buffer`, `fetch`, `Blob`, `File`, `Headers`, `Request`, and `Response`
- Concurrent runs on the same VM are not queued end-to-end. Synchronous JS still runs on the single event loop; awaited regions can interleave with sibling runs.

### Python runtime

Implemented in `packages/coding-agent/src/eval/py/executor.ts`, `packages/coding-agent/src/eval/py/kernel.ts`, and `packages/coding-agent/src/eval/py/prelude.py`. See `docs/python-repl.md` for kernel and runner details.

- Default mode is retained `session` kernels keyed by `python:${sessionId}` plus normalized cwd and interpreter
- Optional `python.kernelMode = "per-call"` creates a fresh kernel for each cell and shuts it down afterward
- `reset: true` disposes the retained kernel for that session before the cell runs; the next Python call starts on the fresh kernel
- Startup path:
  - availability check
  - create/connect kernel
  - initialize cwd / env / `sys.path`
  - execute `PYTHON_PRELUDE`
- Python code runs in the runner's persistent asyncio event loop, so top-level `await` works; the prompt warns not to use `asyncio.run(...)`
- The Python prelude defines helpers with the same surface as JS where practical, including `tool.<name>(args)`, `completion(...)`, and `agent(...)` through a per-run loopback bridge
- Synchronous statement blocks run in the default executor with ContextVar state copied in; the GIL still serializes bytecode execution, but awaited regions can interleave with sibling runs
- Kernel `display` / `result` frames map to:
  - `application/x-omp-status` → status event
  - `image/png` → image output
  - `application/json` → JSON output
  - `text/markdown` → markdown output
  - `text/plain` → text output
  - `text/html` → HTML converted to markdown with `htmlToBasicMarkdown()`
- Interactive stdin is rejected: a stdin-flagged result returns exit code `1` with `Kernel requested stdin; interactive input is not supported.`

### Oneshot completion helper (`completion`)

All backends expose `completion()` — a single stateless completion against a model tier. It is intentionally minimal: no conversation history, no agent-visible tools, pure text in / text (or object) out. Implemented host-side in `packages/coding-agent/src/eval/completion-bridge.ts` and routed through the existing tool bridge under the reserved name `__completion__`; the Ruby and Julia kernels reach it through their loopback bridges.

- Signatures:
  - JS: `await completion(prompt, { model?, system?, schema? })`
  - Python: `completion(prompt, *, model="default", system=None, schema=None)`
- `model` selects a tier (default `"default"`):
  - `"smol"` → `pi/smol` role (fast / cheap)
  - `"default"` → the session's active model, falling back to the `pi/default` role
  - `"slow"` → `pi/slow` role; requests high reasoning effort only on reasoning-capable models
- `system` (optional) supplies a system prompt.
- `schema` (optional) is a plain JSON-Schema object. When present, the model is forced to call a single synthetic `respond` tool with that schema (loose, non-strict), and the helper returns the parsed object. When absent, the helper returns the completion string.
- Errors surface as exceptions: unresolved tier, missing API key, an `error`/`aborted` stop reason, or empty output each raise.

### Subagent helper (`agent`)

All backends expose `agent()` — a single subagent invocation routed through `packages/coding-agent/src/eval/agent-bridge.ts` into the same `runSubprocess(...)` path used by the `task` tool. It uses the current eval session's spawn policy and inherits the parent eval executor id, so parent and subagent code share runtime state.

- Signatures:
  - JS: `await agent(prompt, agent?, model?, label?, schema?)` or `await agent(prompt, { agent?, model?, label?, schema?, handle? })`
  - Python: `agent(prompt, *, agent="task", model=None, label=None, schema=None, handle=False)`
- `agent` defaults to the bundled `task` agent and resolves through normal agent discovery, so project and user agents work.
- `model` overrides the selected agent's model. Without it, normal per-agent settings and the agent frontmatter model apply.
- Shared background is passed via files: write a `local://` file and reference it in the prompt. `label` controls the `agent://<id>` output label prefix.
- `schema` passes a JSON Schema to the subagent structured-output path. When present, the helper parses the final JSON text and returns an object.
- `handle` (default off) returns a DAG node dict — `{ text, output, handle: "agent://<id>", id, agent }`, plus a parsed `data` field when `schema` is set — instead of the bare output, so a downstream stage can reference the transcript by handle.
- Spawn restrictions use `session.getSessionSpawns()` exactly like the `task` tool. Eval-driven subagent recursion is capped at depth 3.
- All backends expose `parallel(thunks)` and `pipeline(items, ...stages)`; both use a bounded async/threaded pool whose width tracks the `task.maxConcurrency` setting (the same ceiling the `task` tool uses; `0` = run every item at once), preserve item order, and propagate rejections. The width is fetched live from the host via the `__concurrency__` bridge, so the helpers no longer take a `concurrency` argument.
- Errors surface as exceptions: unknown or disabled agent, disallowed spawn, recursion cap, subagent failure, or invalid structured output all fail the eval cell.

### Multi-language call behavior

Each eval call runs in exactly one language, but persistence is per language runtime across calls:

- `reset: true` on a Python call does not touch JS, Ruby, or Julia state
- `reset: true` on a JS call does not touch Python, Ruby, or Julia state
- each backend keeps its own retained session keyed from the same session-derived ID
- mixing languages means alternating eval calls (e.g. a `py` call, then a `js` call), each reusing that language's retained state

## Side Effects

- Filesystem
  - JS/Python prelude helpers can read and write filesystem paths under the session cwd or absolute paths.
  - JS helper `read()` auto-delegates any non-`local://` scheme URI (`agent://`, `artifact://`, `https://`, ...) to `tool.read(...)` (honoring an `offset`/`limit` line selector), resolves `local://` under its mapped root, reads plain/absolute filesystem paths directly, and rejects directory paths.
  - Output may spill to an artifact file via `OutputSink`.
- Network
  - Python backend speaks NDJSON to a local `python3` subprocess over stdin/stdout (no network).
  - JS runtime exposes `fetch` and `tool.<name>()`; those tools may perform additional network I/O.
- Subprocesses / native bindings
  - Python availability check runs `<python> -c ...`.
  - Python backend spawns one `python -u runner.py` subprocess per kernel; cancellation sends `SIGINT`. Details in `docs/python-repl.md`.
  - `agent()` runs one in-process subagent via the task executor; that subagent may use its configured tools.
- Session state
  - `session.assertEvalExecutionAllowed?.()` can block execution.
  - `session.trackEvalExecution?.(...)` can register cancellable eval work.
  - `session.getSessionFile?.()`, `session.getEvalSessionId?.()`, and `session.getEvalKernelOwnerId?.()` influence VM/kernel reuse and artifact lookup.
  - JS VM contexts persist across eval calls until reset/disposal.
  - Python retained kernels persist until reset, owner cleanup, or process exit.
  - `agent()` allocates `agent://<id>` output artifacts and reuses the parent's eval executor id.
- User-visible prompts / interactive UI
  - none; stdin requests are rejected programmatically
- Background work / cancellation
  - Python retained kernels have no heartbeat or idle timer; they are cleaned up by owner disposal (`disposeKernelSessionsByOwner`, keyed by `kernelOwnerId`, in `packages/coding-agent/src/session/agent-session.ts`), reset, or process exit.
  - Cancellation hard-kills/resets the shared executor for that backend: JS terminates the worker, Python sends SIGINT and may escalate to subprocess shutdown.

## Limits & Caps

- Per-call timeout default: 30s (applied when `timeout` is omitted — `params.timeout ?? 30` in `EvalTool.execute()`; clamped through `TOOL_TIMEOUTS.eval` in `packages/coding-agent/src/tools/tool-timeouts.ts`)
- Schema-level `timeout` is a plain `number` with no range constraint; the `1..3600` second bounds are applied at runtime by `clampTimeout` (`timeoutSecondsFromMs` in `packages/coding-agent/src/tools/eval.ts`)
- Timeout clamp at runtime: 1s minimum, 3600s maximum (`TOOL_TIMEOUTS.eval` in `packages/coding-agent/src/tools/tool-timeouts.ts`)
- Transcript code/output preview: 10 lines by default (`EVAL_DEFAULT_PREVIEW_LINES` in `packages/coding-agent/src/tools/eval-render.ts`, re-exported from `eval.ts`)
- Output truncation window: 50KB default (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`)
- Output line cap inside truncation helpers: 3000 lines (`DEFAULT_MAX_LINES` in `packages/coding-agent/src/session/streaming-output.ts`)
- Streaming tail buffer for live updates: `DEFAULT_MAX_BYTES * 2` = 100KB (`packages/coding-agent/src/tools/eval.ts`)
- JS/Python `parallel()` / `pipeline()` helper pool width: the `task.maxConcurrency` setting (default 32; `0` = unbounded), resolved live via the `__concurrency__` bridge (`packages/coding-agent/src/eval/concurrency-bridge.ts`)
- Eval-driven `agent()` recursion cap: task depth 3 (`EVAL_AGENT_MAX_DEPTH`)
- Python kernel startup wait: 10s (`STARTUP_TIMEOUT_MS` in `packages/coding-agent/src/eval/py/kernel.ts`)
- Python kernel shutdown grace per escalation step (`exit` request → `SIGTERM` → `SIGKILL`): 1000ms (`SHUTDOWN_GRACE_MS` in `packages/coding-agent/src/eval/py/kernel.ts`)
- Python SIGINT escalation window: 5s without a `done` frame before the subprocess is killed (`INTERRUPT_ESCALATION_MS` in `packages/coding-agent/src/eval/py/kernel.ts`)
- Python auto-restart budget: a dead retained kernel is replaced and the cell retried once per execution (`executeOnSession` in `packages/coding-agent/src/eval/py/executor.ts`)

## Errors

- Schema validation rejects a malformed call before `execute()` runs (missing `language` or `code`); `timeout` has no schema-level range and is clamped at runtime instead.
- Missing session without proxy executor throws `ToolError("Eval tool requires a session when not using proxy executor")`.
- Disabled/unavailable backends throw `ToolError` from `resolveBackend()`:
  - `eval.py = false` (or `PI_PY=0`) and `language: "py"` is requested
  - `eval.js = false` (or `PI_JS=0`) and `language: "js"` is requested
  - `eval.rb = false` (or `PI_RB=0`) and `language: "rb"` is requested
  - `eval.jl = false` (or `PI_JL=0`) and `language: "jl"` is requested
  - Python kernel unavailable and `"py"` is requested (the error names the enabled alternative languages)
  - Ruby/Julia runtime unavailable and `"rb"`/`"jl"` is requested
- JS runtime exceptions are converted into text output plus `exitCode: 1`; cancellations return `cancelled: true` and may append `Command timed out`.
- Python execution errors from the kernel become text output and `exitCode: 1`.
- Python stdin requests are treated as errors with the message `Kernel requested stdin; interactive input is not supported.`
- Cancellation is returned, not thrown, once backend execution has started. The tool formats it as a cell failure and sets `details.isError = true`.
- If output truncates, the tool still succeeds; truncation is surfaced through `details.meta` and artifact-backed full output when available.

## Shared executor trade-offs

- Parent agents and subagents share eval state bidirectionally when a subagent inherits the parent's executor id. Mutations in either direction are visible to the other participant.
- Async regions of concurrent runs can interleave. Synchronous JS still blocks the VM event loop; synchronous Python still contends on the GIL.
- Cancelling one run is destructive to the shared backend executor. This is intentional: JS worker termination and Python SIGINT/subprocess shutdown are the only reliable way to interrupt arbitrary user code.
- `reset: true` is destructive for every live run on that backend session id. Concurrent Python resets coalesce — a reset already in flight is awaited rather than duplicated, and runs queued behind it proceed on the freshly-restarted kernel.

## Notes

- Backend selection is strictly explicit: `language` must be `"py"`, `"js"`, `"rb"`, or `"jl"`, and each call runs exactly one cell. The previous `*** Cell` header parser, the `eval.lark` constrained grammar, the sniffer-based fallback, and the batched `cells[]` schema have all been removed.
- `EvalTool.customFormat` no longer exists. Tool calls flow through the standard JSON schema; there is no Lark-constrained sampling path.
- `tool.<name>()` exists in all four backends. Python/Ruby/Julia calls route through a per-run loopback bridge keyed by the current cell id.
- `read()` delegates non-`local://` scheme URIs to `tool.read`, resolves `local://` under its injected root, and resolves plain paths against the session cwd or an absolute filesystem path; `resolveRegularFile()` rejects directory paths. `write()` accepts `local://` and plain paths but rejects any other `scheme://` via `resolveHelperPath()` (`Protocol paths are not supported by write()`).
- Python helper `output(...)` depends on `PI_ARTIFACTS_DIR` or `PI_SESSION_FILE`; it fails outside a session-backed run.
- `display()` can produce text and structured outputs from the same value; the renderer prefers markdown over `text/plain` when both exist.
- JS static imports are rewritten only at top level. Nested imports stay invalid and surface normal JS syntax/runtime errors.
- `EvalTool` is `concurrency = "exclusive"` within one agent session, but parent and subagent sessions can run eval concurrently when they share an inherited executor id.
- The tool description shown to the model is templated by backend availability (`getEvalToolDescription()`); if Python is unavailable, the prompt omits Python-specific instructions.
