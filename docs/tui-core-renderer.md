# TUI core renderer — the append-only contract

What you are dealing with before you touch the rendering engine. This is the
companion to [`tui-runtime-internals.md`](./tui-runtime-internals.md): that doc
maps the *flow* (input → component tree → render); this doc explains the
**render contract, why it is shaped this way, and the invariants you must not
violate**. Scope is the core engine only:

- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts) — frame pipeline, commit/window math, committed-prefix audit, emitters, cursor placement.
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts) — `ProcessTerminal`, capability probes, private-CSI reassembly.
- [`packages/tui/src/terminal-capabilities.ts`](../packages/tui/src/terminal-capabilities.ts) — `TERMINAL` profile, sync-output / DECCARA / image detection.
- [`packages/tui/src/stdin-buffer.ts`](../packages/tui/src/stdin-buffer.ts) — escape-sequence reassembly.
- [`packages/tui/src/utils.ts`](../packages/tui/src/utils.ts) — width/slice/wrap (the width model).
- [`packages/tui/src/kitty-graphics.ts`](../packages/tui/src/kitty-graphics.ts) + [`components/image.ts`](../packages/tui/src/components/image.ts) — inline images.
- [`packages/tui/src/deccara.ts`](../packages/tui/src/deccara.ts) — rectangular-fill optimizer.

Application-layer renderers (transcript, tool calls, session tree, editor,
widgets) are **out of scope** — they live in `packages/coding-agent`. The one
app-layer file that is load-bearing for this contract is
[`transcript-container.ts`](../packages/coding-agent/src/modes/components/transcript-container.ts),
which implements the exactness seam described below.

---

## 1. The one thing to understand first

> **The renderer cannot observe the terminal's scroll position** (ConPTY's
> probe lies; POSIX has no API at all). Every past policy that *guessed* when
> it was safe to rewrite native scrollback traded one failure family for
> another (yank ↔ flash ↔ corruption ↔ invisible-until-resize — see the git
> history of this file for the full war journal). The current engine removes
> the guess entirely: **native scrollback is append-only, and it is the
> terminal's visual record.** Whatever scrolls above the window enters history
> exactly once, in order — nothing painted ever vanishes.

We keep the transcript on the **normal screen** (native scrollback, native
selection, transcript persists after exit). The engine maintains a small
ledger (tui.ts):

- **`committedRows` (C)** — frame rows `[0, C)` have been physically scrolled
  into terminal history. They are **immutable**: the engine never rewrites
  them, and components must never change them.
- **`committedPrefix`** — raw rows mirroring `[0, C)`: the engine's claim of
  what it committed, and the baseline the committed-prefix audit checks
  against (§2).
- **`windowTopRow` (W)** — the frame row mapped to grid row 0. The visible
  window is frame rows `[W, W + height)`, repainted in place with relative
  cursor moves. Monotonic between full paints: a shrink never re-exposes
  scrolled-off rows.
- **`committedPrefixAuditRows` (the mark, A ≤ C)** — the leading rows that
  were **hard-verified** as exact-final bytes. Rows in `[A, C)` are frozen
  visual snapshots of still-live content (see below).

There is exactly **one commit boundary**, reported by the component tree per
frame (`NativeScrollbackLiveRegion`, tui.ts) as a single number — the
**exactness boundary**: `getNativeScrollbackLiveRegionStart()` returns the
first row that may still mutate. Rows below it are declared **FINAL** —
byte-stable at the current width for the component's lifetime — and commit as
exact, audited bytes. Rows at/after the boundary repaint in place inside the
window; when they scroll above the window top they **still commit** — the tape
records what was on screen — but as **frozen visual snapshots** that are
permanently audit-exempt while their source stays live: later re-layout of
their source never re-anchors or recommits them. A root that reports no seam
commits everything that scrolls as final (**shell semantics**). When several
root children report a seam, the **topmost one wins** (exactness is
prefix-only; a lower sibling's seam must never move the boundary down over an
earlier child's still-mutable rows).

The one mark A derives **three audit zones** per frame:

| Zone | Rows | Status |
|---|---|---|
| verified | `[0, A)` | hard-verified exact-final bytes |
| newly-final | `[A, min(C, boundary))` | frozen snapshots whose source *just* became final — strict-scanned **exactly once** when the boundary rose past them; unchanged rows join the verified zone, a divergence re-anchors so the final content recommits below the frozen fragment (**duplication, never loss**) |
| frozen | `[A, C)` past the boundary | still-live frozen snapshots — audit-exempt, so a collapsing preview can never spray re-anchors mid-run |

Per ordinary frame: `W' = max(C, L − height, 0)`, and the only bytes that ever
touch history are the **chunk** `frame[C, W')` written at the scrollback seam —
whatever scrolls above the window commits. Scrollback therefore equals
`frame[0..C)` with each row's content at commit time. There is nothing to
guess, nothing to defer, and nothing to reconcile: the scroll position is
irrelevant because ordinary updates never rewrite anything a scrolled reader
could be looking at.

### What this costs (the accepted tradeoffs)

- A live block that scrolls past the window top freezes its scrolled-off rows
  as visual snapshots. A later re-layout of an already-recorded row is a
  stale frozen row in history (duplication never loss); when the block
  finalizes, the boundary rises past its frozen rows, the one-time strict
  scan repairs any divergence once, and the block never touches history
  again.
- A component tree that reports **no seam** gets shell semantics: whatever
  scrolls off is final. Shrinking such a frame re-anchors at the first
  divergence against the recorded prefix and leaves the stale copy in history
  (§2).
- Inside multiplexers, a resize leaves the pane history wrapped at the old
  width (same as any shell output).

---

## 2. The frame pipeline (what you are editing)

`#doRender` per frame:

1. **Compose the frame** (`render(width)`), collecting the live-region seam
   and the stable-prefix report from the root children (absolute row indices).
   Component-scoped frames skip the compose of unchanged root subtrees and
   reuse their previous rows and seam report. Before each child renders, the
   engine feeds it the committed-row count (`NativeScrollbackCommittedRows`)
   so it can replay already-committed blocks without re-deriving them.
2. **Derive the exactness boundary**: `min(frameLength, liveRegionStart ??
   frameLength)`. The whole frame is final when no seam is reported.
3. **Audit the committed prefix** (`findCommittedPrefixResync`, skipped on
   geometry and clear-scrollback frames, and skipped when the composed
   frame's stable prefix covers every verified row and no rows newly became
   final). The audit works purely over the three zones of §1: a **hard scan**
   (no tolerance) of the newly-final zone — a finalized row that changed must
   re-anchor — followed, only when that is clean, by a **tail sample** of the
   verified zone (up to 8 non-blank rows in the last 24, SGR-stripped): an
   in-place edit or restyle disturbs only the touched rows (≤1 mismatch ⇒
   aligned ⇒ ignored — stale styling in history is the accepted artifact),
   while any insertion/deletion shifts every row below it including the tail
   (⇒ re-anchor C at the first changed row and recommit from there: history
   keeps the stale copy and gains a fresh one — **duplication, never loss**).
   The exactness boundary can also **retreat** (a markdown rewind, a mermaid
   fence appearing): rows verified under the old boundary are demoted to
   frozen snapshots instead of auditing content that is expected to change;
   their committed bytes stay as the visual record and the next boundary rise
   strict-verifies them once like any other frozen row.
4. **Re-base on shrink**: a frame shorter than C (a live suffix collapsing on
   abort/result) re-bases the commit index at the first divergence against
   the recorded prefix — frozen snapshots included; a collapse is precisely
   when the record and the frame part ways — so the surviving exact prefix
   stays recognized and is never re-shown or re-committed. Only genuinely new
   content repaints below it.
5. Classify: **fullPaint** (first paint, `clearScrollback` session replace, or
   geometry change outside a multiplexer / alt-screen-loop terminal — all user
   gestures) or **update**.
6. Window math as in §1. Three special rules:
   - **Overlays freeze commits** (`C' = C`): composited rows must never enter
     history; the hidden gap backfills via the chunk after the overlay closes.
   - **Shrink into the committed prefix** (`L ≤ C`): re-show the frame tail —
     `W = max(0, L − height)`, `C = W`, prefix re-sliced. The stale history
     above stays (no gesture, no erase); re-showing a committed row on the
     grid is preferable to a live editor gap.
   - **Geometry frames commit nothing**: a multiplexer resize repaints in
     place (pane history keeps its old wrap) and re-slices the audit prefix at
     the new width so the accepted wrap drift does not read as a violation.
7. Extract the cursor marker (strip-first: markers never reach the terminal,
   the committed prefix, or the audit), prepare lines (width fitting), slice
   the window, composite overlays **into the window slice only** (screen
   coordinates — an overlay never touches the frame or the ledger).
8. Emit:

| Emitter | Bytes | When |
|---|---|---|
| `#emitFullPaint` | clears + committed prefix `frame[0, C')` + window rows | gestures only. `clearScrollback` ⇒ `\x1b[2J\x1b[H\x1b[3J`; otherwise ED22 (when supported) + `\x1b[2J\x1b[H` |
| `#emitUpdate` scroll-append | `\r\n` + new bottom rows + changed-row range | the rows leaving the screen are exactly the chunk, content untouched since painted |
| `#emitUpdate` in-window diff | relative move + changed-row range rewrite | nothing scrolls, nothing commits (cursor-only when nothing changed) |
| `#emitUpdate` seam rewrite | chunk rows + full window rewrite | commit advance, window re-anchor, hidden-gap backfill, mux resize |

9. **Advance the audit mark**: a re-slice re-bases it outright; otherwise it
   moves to the exactness boundary only when this frame verified the
   newly-final span (step 3 ran its hard scan) or no such span existed — rows
   committed below the boundary are fresh exact bytes.

**ED3 (`CSI 3 J`) is emitted in exactly one place** — `#emitFullPaint` with
`clearScrollback: true` — and is reached only by user gestures: session
replace/branch/resume (`requestRender(true, { clearScrollback: true })`),
resize outside a multiplexer, `resetDisplay()` (Ctrl+L). A gesture pins the
user to the tail, so the snap is acceptable; multiplexers never get ED3 (it is
a no-op there and a replay would duplicate pane history).

The ordinary update path never emits ED2/ED3 or an absolute cursor home —
several terminal families snap a scrolled reader to the bottom on those.

### The exactness seam (the load-bearing app contract)

`NativeScrollbackLiveRegion` (tui.ts) is a **single method**:
`getNativeScrollbackLiveRegionStart()` — the first row that may still mutate.
Everything below it must be final: byte-stable at the current width for the
component's lifetime. That is the entire engine-facing contract; there are no
deeper safe-end hooks (the old `getNativeScrollbackCommitSafeEnd` /
`getNativeScrollbackSnapshotSafeEnd` pair and the heuristic promotion
machinery they fed were removed in 16.3.6).

Three opt-in interfaces complete the plumbing (all tui.ts):

- `NativeScrollbackCommittedRows` — `setNativeScrollbackCommittedRows(rows)`:
  the engine feeds each root child its committed-row count before render so it
  can skip re-deriving blocks that already live in immutable scrollback.
- `RenderStablePrefix` — `getRenderStablePrefixRows()`: for components that
  mutate their render array in place, the leading rows byte-identical to what
  the engine last observed. Reading **consumes** the report (the baseline
  re-bases), so the count covers every render since the previous read and
  out-of-band renders can only lower it. The engine uses it to reuse the
  composed frame's prefix — skipping marker extraction, line preparation, and
  the committed-prefix audit for those rows.
- `ViewportTailProvider` — `renderViewportTail(width, maxRows)`: during a
  non-multiplexer resize drag the engine paints only the viewport and asks
  each tall root child for the bottom `maxRows` of its render, state-isolated,
  so a SIGWINCH burst does not re-lay-out the whole history per event. The
  authoritative full paint replays once the drag settles.

`TranscriptContainer` implements all four for the coding agent
(transcript-container.ts). Its seam is the frame row below which every
rendered row is final, computed each render as:

- the leading run of **finalized blocks** (`isTranscriptBlockFinalized?.()`
  — a foreground tool awaiting its result or an assistant message mid-stream
  reports `false`), plus
- the first still-live block's **declared settled rows**
  (`getTranscriptBlockSettledRows?.()`): the leading rows of its current
  render that are byte-stable until finalize, monotone non-decreasing under
  streaming growth, re-derived per render. The one blank separator before the
  live block stays committed; the boundary extends through its settled rows.
  Absent = 0: nothing commits past the finalized run until the block
  finalizes.

A non-finalized block **gates the whole boundary at its position** even when
it has rendered nothing yet: out-of-band inserts (todo/tool-retry cards) can
append a finalized block *below* a tool that is still awaiting its result, and
committing rows there would strand the tool's history rows on a mid-stream
preview the late result never reaches.

Settled rows are honest, not heuristic — implementers report only rows whose
bytes provably cannot change:

- `AssistantMessageComponent` (assistant-message.ts): completed content blocks
  render in final form and settle in full; the actively streaming markdown
  contributes its rendered **frozen-token prefix** via
  `Markdown.getLastRenderSettledRows()` (markdown.ts — top padding plus the
  rendered largest blank-line-bounded token prefix, hard-monotone per text
  lineage: a rewind/wholesale rewrite resets the exposure to 0 and re-earns
  it). Frozen-prefix code blocks syntax-highlight during streaming so their
  bytes match the finalized render. The walk stops at the first child not
  declared byte-stable (the animated thinking pulse, extension components,
  images, error rows), and mermaid anywhere defers settling wholesale (its
  ASCII rendering resolves asynchronously and can re-layout settled-looking
  rows).
- `ToolExecutionComponent` reports no settled rows while live, and anchors its
  own seam at 0 when mounted standalone (harnesses that put a tool component
  directly under `TUI` — without a container the engine would otherwise treat
  its mutating preview as shell output and commit it).
- `AnchoredLiveContainer` (interactive-mode.ts — the HUD/status rows between
  transcript and editor) pins its seam at 0 while non-empty so those
  rebuilt-in-place rows never enter history.

Two auxiliary queries keep app behavior consistent with the ledger:

- `TranscriptContainer.isBlockUncommitted(component)` — whether none of the
  block's rows have entered scrollback. Callers that retract ephemeral blocks
  (displaceable todo/job cards, IRC cards) must gate on it: removing a block
  whose rows are already on the tape is an interior deletion of committed
  history the engine cannot express — the block seals in place as history
  instead.
- `TranscriptContainer.isBlockInLiveRegion(component)` — whether the block
  sits at/after the first still-mutating block, exactly as `render` computes
  it. Self-animating finalized blocks poll it to stop animating (and settle
  on static bytes) the moment they sit above the seam, where their rows become
  commit-eligible history.

Freezing is unconditional — it is the engine's required guarantee, not a
per-terminal optimization.

---

## 3. Invariants — MUST / NEVER

1. **NEVER add a new `CSI 3 J` (ED3) callsite.** ED3 flows only through
   `#emitFullPaint({ clearScrollback: true })`, only for gestures, never inside
   multiplexers.
2. **NEVER rewrite a committed row.** No emitter may touch frame rows `< C`,
   and `W ≥ C` always (re-showing a committed row on the grid duplicates it
   for a scrolling reader — the historical corruption family). When a
   *component* violates finality, the audit (§2) degrades to duplication —
   never silently skip rows, never erase history.
3. **Commits are exactly the chunk.** Any byte shape that scrolls the screen
   must scroll *only* rows accounted for by `C' − C` — that is what makes
   scrollback provably `frame[0..C)`.
4. **NEVER probe the viewport position or fork on platform in the update
   path.** win32 behaves like POSIX. The probe APIs are gone; do not
   reintroduce them.
5. **Mutable content stays inside the live region.** App-layer renderers must
   declare their exactness seam honestly (finalized blocks + provably settled
   rows); the engine trusts the seam and clamps it — it does not verify
   content, and a false FINAL declaration strands a stale row in history.
6. **Park the hardware cursor at real content bottom**, not the padded window
   bottom, or height shrinks scroll live rows into history and duplicate them
   per resize step.
7. **Cursor writes live inside the synchronized-output frame**, before ESU —
   never as a second frame after it.
8. **NEVER throw in the render hot path.** Clamp over-wide lines
   (`truncateToWidth`); a width mismatch is cosmetic, not fatal.
9. **Multiplexers get no destructive clear and no history rewrap on resize** —
   repaint the window in place; pane history keeps its old wrap.
10. **Any change to the ledger math, the audit zones, the emitters, or the
    seam must be validated by the stress harness (§6)** across its full
    scenario matrix, not by a single-terminal smoke test.

---

## 4. Terminal capability detection

`TERMINAL` (`terminal-capabilities.ts`) is resolved once at import from
`TERMINAL_ID` plus environment sniffing; detection helpers are pure over
`(env, platform)` and unit-testable.

- `shouldEnableSynchronizedOutputByDefault(env, id)` → DEC 2026 default.
  Precedence: user opt-out (`PI_NO_SYNC_OUTPUT`/`PI_TUI_SYNC_OUTPUT=0`) → user
  force-on (`PI_FORCE_SYNC_OUTPUT=1`/`PI_TUI_SYNC_OUTPUT=1`) → `TERM_FEATURES`
  advertises `Sy` → `WT_SESSION` → known direct terminals → off for risky
  multiplexers and unknowns. Reconciled at runtime by the DECRQM mode-2026
  report; a user override still wins.
- `detectRectangularSgrSupport(id, env)` → DECCARA fills: kitty only, off in
  multiplexers and under `PI_NO_DECCARA`.
- `supportsScreenToScrollback` → kitty's ED22, emitted on a full paint that
  does *not* clear scrollback (best-effort push of the pre-paint screen into
  history before the `\x1b[2J\x1b[H` viewport clear).

The old ED3-risk classifier (`eagerEraseScrollbackRisk`, `PI_TUI_ED3_SAFE`,
`submitPinsViewportToTail`) is gone: behavior no longer depends on which
terminal is rendering, so there is no risk class to detect. Env sniffing now
only selects *optimizations* (sync output, DECCARA, images), where a miss is
cosmetic, not corrupting.

---

## 5. Width model

`visibleWidth` / `truncateToWidth` / `sliceByColumn` / `wrapTextWithAnsi`
(`utils.ts`) all agree on **one UAX#11 width model**. Slicing, truncation,
wrapping, and segment extraction run on the native engine
(`@oh-my-pi/pi-natives`, Rust `unicode-width`); `visibleWidth` measures with
`Bun.stringWidth` **pinned to that same model** (`STRING_WIDTH_OPTS`:
`countAnsiEscapeCodes: false`, `ambiguousIsNarrow: true`) — a JSC builtin that
shares the native width tables without the per-call N-API box the native
scanner traps on under Bun 1.3.x. The two must never disagree; mixing unpinned
width models in measure-vs-slice produced crashes.

- Fast path: printable ASCII is one cell per code unit.
- Anything past the ASCII prefix measures through `Bun.stringWidth` (CSI/OSC
  stripped to zero); tabs are added back at the fixed `DEFAULT_TAB_WIDTH` columns.
- OSC 66 sized spans are added back as `scale × (explicit w ?? payload width)` —
  `Bun.stringWidth` would otherwise strip the whole span to zero.

**Rule:** any new measuring code routes through these helpers, and the hot
path clamps instead of throwing. Known residual: combining-heavy scripts
(Arabic harakat) survive painting verbatim, but ghostty-web's cell readback can
migrate non-spacing marks across cells — the stress harness compares those rows
with marks stripped (`sameLinesAllowingMarkDrift`).

---

## 6. The fidelity gate (use it)

`packages/tui/test/render-stress-harness.ts` drives the renderer's **real
emitted ANSI** into a ghostty-web `VirtualTerminal` across randomized op
sequences and parameterized terminal shapes, and validates the contract with a
**shadow commit ledger**: an independent reimplementation of §1's math —
including the engine's own `findCommittedPrefixResync`, which it imports so
the zone semantics can never drift — fed only by observed frames (a `render`
wrap) and observed bytes (a `write` wrap). Per op it asserts:

- the whole tape (scrollback + grid) equals `shadowTape + window slice`, row
  for row, including across resizes;
- scrolled readers stay pinned and visible history rows are never rewritten;
- multiplexer pane history grows by exactly the committed chunk;
- sync-output/autowrap bracket discipline, cursor parking, background columns,
  duplicate accounting.

Run it — plus `render-regressions.test.ts`,
`streaming-scrollback-defer.test.ts`, and the `issue-*-repro.test.ts` files —
before changing ledger math, emitters, or the seam. A change that passes one
terminal and one seed is not verified.

---

## 7. Capability probes & stdin reassembly

`ProcessTerminal` fuses capability queries with a bare DA1 (`CSI c`) sentinel so
a non-answering terminal is detected when DA1 returns first. Replies can arrive
**split across a stdin flush**, so:

- `#privateCsiResponseBuffer` accumulates `\x1b[?…` partials while a sentinel is
  outstanding, rejoins on the terminator byte, then runs the handlers on the
  **complete** reply. A new `\x1b` mid-reassembly or >256 bytes abandons the
  partial so real keys still reach input.
- `#da1SentinelOwners` is a **typed FIFO** discriminated by `kind` so a
  keyboard DA1 cannot be mistaken for an OSC 11 / DECRQM / graphics-probe
  sentinel.
- DECRQM probes (2026/2048/2031) drive runtime feature gating.

**Rule:** any new probe must own a typed sentinel and survive a split reply
(feed the reply byte-by-byte in a test and assert nothing leaks to input).

---

## 8. Inline images & memory

Kitty images are **transmit-once, place-many** (`kitty-graphics.ts`).
`ImageBudget` keeps only the most-recent N images live; when the cap is
exceeded the demoted image's pixels are deleted by id (`a=d,d=I`) and its
visible rows re-render as the text fallback through the ordinary window diff —
**no destructive replay**. A demoted placement already committed to history
simply loses its pixels (committed rows are immutable), and the text fallback
is **height-preserving** once a graphic has rendered (reserved rows + fallback
line), so demotion never shrinks the block and never shifts committed content
below it.

**Rule:** never re-emit full base64 per frame. Kitty Unicode placeholders are
default-on only for kitty/ghostty (`PI_NO_KITTY_PLACEHOLDERS` /
`PI_KITTY_PLACEHOLDERS`).

---

## 9. Escape hatches (env vars)

| Var | Effect |
|---|---|
| `PI_NO_SYNC_OUTPUT=1` | Disable DEC 2026 BSU/ESU wrappers (autowrap discipline stays on). |
| `PI_TUI_SYNC_OUTPUT=0\|1` / `PI_FORCE_SYNC_OUTPUT=1` | Force sync output off / on. |
| `PI_NO_DECCARA` | Disable Kitty DECCARA rectangular-fill optimization. |
| `PI_FORCE_IMAGE_PROTOCOL=kitty\|iterm2\|sixel\|off` | Override image protocol detection. |
| `PI_NO_KITTY_PLACEHOLDERS=1` / `PI_KITTY_PLACEHOLDERS=1` | Force Kitty Unicode placeholders off / on. |
| `PI_HARDWARE_CURSOR=1` | Show the real hardware cursor instead of a rendered one. |
| `PI_NOTIFICATIONS=off\|0\|false` | Suppress terminal notifications. |
| `PI_DEBUG_REDRAW=1` | Log the chosen render intent + ledger state per frame to the debug log. |
| `PI_TUI_RESIZE_IN_PLACE=1\|0` | Force resize to repaint in place (no alt-screen borrow, no ED3 rewrap) on / off. Default-on for terminals that re-report size on alt-screen toggles (Warp). |

Removed with the old engine: `PI_TUI_ED3_SAFE` (no ED3-risk lever exists),
`PI_CLEAR_ON_SHRINK` (shrinks always clear exactly), `PI_TUI_DEBUG` (per-render
dump superseded by `PI_DEBUG_REDRAW` ledger logging and the stress harness
replay/reduce tooling).

---

## 10. Before you touch the render core — checklist

- [ ] Are you about to emit `CSI 3 J` anywhere other than the gesture-driven
      `clearScrollback` full paint? **Stop.**
- [ ] Could any code path rewrite, or re-show on the grid, a frame row below
      `committedRows`? **Stop.**
- [ ] Does your byte shape scroll rows that are not the commit chunk? That
      breaks `scrollback == frame[0..C)`.
- [ ] Are you adding a viewport probe, a platform fork, or a terminal-brand
      branch to the update path? The contract exists so none are needed.
- [ ] New mutable UI above the editor? It must report (or live inside) the
      live-region seam, or it will freeze at first commit.
- [ ] Extending the audit or the zone math? The verified/newly-final/frozen
      split must stay derivable from the one hard-verified mark
      (`committedPrefixAuditRows`) plus the seam — no second boundary, no
      per-frame heuristics.
- [ ] Did you run the stress harness and the repro suite across the full
      scenario matrix — not just one terminal and one seed?
- [ ] New probe? Typed sentinel owner + split-reply test.
- [ ] New width path? Routed through the shared native engine, clamped (never
      thrown) in the hot path.
