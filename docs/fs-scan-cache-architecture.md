# Filesystem Scan Cache Architecture Contract

This document defines the current contract for the shared filesystem scan cache implemented in Rust (`crates/pi-walker/src/cache.rs`, part of the `pi-walker` traversal crate) and consumed by native discovery APIs exposed to `packages/coding-agent`. The N-API DTO layer that bridges walker results to JavaScript lives in `crates/pi-natives/src/iofs.rs`; per its own header, "`pi-walker` owns traversal and cache policy" and `iofs.rs` keeps only the JS-facing shapes and conversions.

## What this cache is

The cache stores full directory-scan entry lists (`GlobMatch[]`-shaped entries: relative path, file type, optional mtime/size) keyed by scan root and traversal options. Higher-level operations (`glob` filtering, `fuzzyFind` scoring, and `astGrep`/`astEdit` candidate file discovery) run against those cached entries. Native `grep` is **not** a cache consumer: its `GrepOptions` has no `cache` option, and the directory walk it builds hard-codes `.cache(false)` (`crates/pi-natives/src/grep.rs`, `build_grep_walk_request`).

Primary goals:

- avoid repeated filesystem walks for repeated discovery calls
- keep consistency across native discovery flows when they share the same scan policy
- allow explicit staleness recovery for empty results and explicit invalidation after file mutations

## Ownership and public surface

- Cache implementation and policy: `crates/pi-walker/src/cache.rs` (shared `DashMap`; also hosts walker pool sizing via `PI_WALK_WORKERS`)
- Traversal and high-level request API: `crates/pi-walker/src/lib.rs` (`WalkRequest` builder, `WalkOptions`)
- Native consumers:
  - `crates/pi-natives/src/glob.rs` (`glob`; cache opt-in via `cache` option)
  - `crates/pi-natives/src/fd.rs` (`fuzzyFind`; cache opt-in via `cache` option)
  - `crates/pi-natives/src/ast.rs` (`astGrep`/`astEdit` file discovery; always cached)
  - `crates/pi-natives/src/grep.rs` (builds a `WalkRequest` with `.cache(false)`; never cached)
- N-API DTO/conversion module: `crates/pi-natives/src/iofs.rs` (exports `invalidateFsScanCache`, which forwards to `pi_walker::invalidate_path_string`/`pi_walker::invalidate_all`)
- JS binding/export:
  - `packages/natives/native/index.d.ts` (`invalidateFsScanCache`)
  - `packages/natives/native/index.js`
- Coding-agent mutation invalidation helpers:
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts`

## Cache key partitioning (hard contract)

Each entry is keyed by the canonicalized `root` directory path plus the full `WalkOptions` used for the scan (with the cache flag itself excluded from the key):

- `include_hidden` boolean
- `use_gitignore` boolean
- `skip_git` boolean
- `skip_node_modules` boolean
- `follow_links` policy (`FollowLinks::Never`/`Always`)
- `detail` (`WalkDetail::Minimal` or `WalkDetail::Full`)
- remaining traversal knobs (`order`, `emit_root`, depth bounds, `contents_first`, `directory_errors`, `same_file_system`)

Implications:

- Hidden and non-hidden scans do **not** share entries.
- Gitignore-respecting and ignore-disabled scans do **not** share entries.
- Scans that prune `node_modules` (or `.git`) do **not** share entries with scans that include them.
- Minimal scans (path + file type only) do **not** share entries with full scans (mtime + regular-file size metadata).
- Unlike earlier fs_cache revisions, `follow_links` **is** part of the cache key: calls that differ only by symlink policy get separate entries.

Consumers must pass stable semantics for hidden/gitignore/node_modules/detail behavior; changing any keyed flag creates a different cache partition.

## Scan collection behavior

Cache population uses pi-walker's own traversal (`collect_entries_native` in `crates/pi-walker/src/lib.rs`); there is no `ignore::WalkBuilder` dependency anymore. Ignore/gitignore state is derived from each directory's own listing, and directory reading uses the platform-native scanner (`getattrlistbulk` on macOS, `getdents64`/`statx` on Linux, `NtQueryDirectoryFile` on Windows):

- entries are sorted by file path after collection
- `.git` is pruned at traversal time when `skip_git=true` (all current native consumers enable this)
- `node_modules` is pruned at traversal time when `skip_node_modules=true`
- cancellation is checked before the walk and every 128 visited entries per parallel visitor (`HEARTBEAT_INTERVAL`)
- `WalkDetail::Minimal` records normalized relative path and file type only
- `WalkDetail::Full` also records mtime and regular-file size

Search roots for cache scans are resolved by `pi_walker::resolve_search_path`:

- relative paths are resolved against current cwd
- target must be an existing directory
- root is canonicalized when possible

## Freshness and eviction policy

Global policy (environment-overridable, defined in `crates/pi-walker/src/cache.rs`):

- `FS_SCAN_CACHE_TTL_MS` (default `1000`)
- `FS_SCAN_EMPTY_RECHECK_MS` (default `200`)
- `FS_SCAN_CACHE_MAX_ENTRIES` (default `16`)

Behavior of the internal `get_or_scan` (private fn in `cache.rs`, reached via `pi_walker::collect_entries` when `options.cache=true`):

- if TTL is `0`: bypass cache entirely, always fresh scan (`cache_age_ms = 0`)
- on cache hit within TTL: return cloned cached entries + non-zero `cache_age_ms`
- on expired hit: evict key, rescan, store fresh entry
- max entry enforcement is oldest-first eviction by `created_at` after insert

Requests with cache disabled (`options.cache=false`, for example every grep walk or `cache=false` glob/fuzzyFind calls) collect fresh through the same walker without touching the cache. The former `force_rescan(..., store=...)` entrypoint no longer exists.

## Empty-result fast recheck (walker-side)

Normal cache hit:

- a cache hit inside TTL returns cached entries and does nothing else.

Empty-result fast recheck:

- this is now **walker-side** policy, expressed as the `WalkRequest`'s `EmptyRecheck` setting (`Never`, `Configured`, or `AfterMillis(ms)`; `Configured` is the default)
- when a cached scan yields zero accepted entries and the cache age is at least `empty_recheck_ms()`, the walker performs one fresh uncached rescan (bypassing the cache; the rescan result is not repopulated into it) and reports a fresh (`cache_age_ms = 0`) outcome
- intended to reduce stale-negative results when files were added while the cache is still inside TTL

Current consumers (all pass `EmptyRecheck::Configured`):

- `glob`: rechecks when the walker-side filtered scan (including the pushed-down glob filter) is empty and scan age exceeds threshold
- `fuzzyFind` (`fd.rs`): rechecks only when the scan itself collects zero entries; empty results caused by fuzzy scoring of non-empty entries do not trigger a rescan
- `astGrep`/`astEdit` (`ast.rs`): rechecks when the candidate file list is empty
- `grep`: never applies — its walks never read the cache

## Consumer defaults and cache usage

Cache is opt-in on `glob`/`fuzzyFind` (`cache?: boolean`, default `false`). `astGrep`/`astEdit` file discovery always uses the cache (there is no opt-in flag). `grep` cannot use the cache at all.

Current defaults in native APIs:

- `glob`: `hidden=false`, `gitignore=true`, `cache=false`, `follow_links=never`; `node_modules` is included only when `includeNodeModules=true` or the pattern mentions `node_modules`; full detail is used only when `sortByMtime=true`
- `fuzzyFind`: `hidden=false`, `gitignore=true`, `cache=false`, `node_modules` is skipped, `follow_links=always`, minimal detail
- `astGrep`/`astEdit` (file discovery): `hidden=true`, `gitignore=true`, always cached; `node_modules` is skipped unless the glob mentions `node_modules`; `follow_links=never`; minimal detail
- `grep` (directory mode): `hidden=true` default, `gitignore=true`, always uncached streaming walk; `node_modules` is skipped unless the glob mentions `node_modules`; minimal detail; symlink traversal disabled

Current callers:

- `@`-mention fuzzy file autocomplete enables cache (`fuzzyFind` with `cache: true`):
  - `packages/tui/src/autocomplete.ts`
- Mutation flows invalidate through `packages/coding-agent/src/tools/fs-cache-invalidation.ts`.
- Tool-level grep integration (`packages/coding-agent/src/tools/grep.ts`) calls native `grep`, which has no cache option; its directory scans are always fresh.

## Invalidation contract

Native invalidation entrypoint:

- `invalidateFsScanCache(path?: string)` (declared in `iofs.rs`, exported in `packages/natives/native/index.d.ts`)
  - with `path`: remove cache entries whose root is a prefix of the target path
  - without path: clear all scan cache entries

Path handling details:

- relative invalidation paths are resolved against cwd
- invalidation attempts canonicalization
- if target does not exist (for example after delete), fallback canonicalizes the parent and reattaches the filename when possible
- this preserves invalidation behavior for create/delete/rename where one side may not exist

## Coding-agent mutation flow responsibilities

Coding-agent code must invalidate after successful filesystem mutations.

Central helpers:

- `invalidateFsScanAfterWrite(path)`
- `invalidateFsScanAfterDelete(path)`
- `invalidateFsScanAfterRename(oldPath, newPath)` (invalidates both sides when paths differ)

Current mutation callsites include:

- `packages/coding-agent/src/tools/write.ts`
- `packages/coding-agent/src/edit/hashline/filesystem.ts`
- `packages/coding-agent/src/edit/modes/patch.ts`
- `packages/coding-agent/src/edit/modes/replace.ts`
- `packages/coding-agent/src/tools/acp-bridge.ts`

Rule: if a flow mutates filesystem content or location and bypasses these helpers, cache staleness bugs are expected.

## Adding a new cache consumer safely

When introducing cache use in a new scanner/search path:

1. **Use stable scan policy inputs**
   - decide hidden/gitignore/node_modules/detail/follow-links semantics first
   - pass them consistently to the `WalkRequest` builder so cache partitions are intentional

2. **Treat cache data as pre-filtered only by traversal policy**
   - apply tool-specific filtering (glob patterns, type filters, scoring) after retrieval
   - never assume cached entries already reflect your higher-level filters

3. **Rely on the walker's empty-result recheck for stale-negative risk**
   - keep `EmptyRecheck::Configured` (the default) or set an explicit `AfterMillis` threshold
   - the walker performs the single fresh rescan when a cached scan filters to empty

4. **Respect no-cache mode explicitly**
   - when a caller disables cache, build the `WalkRequest` with `.cache(false)`
   - do not populate shared cache in a no-cache request path

5. **Wire mutation invalidation for any new write path**
   - after successful write/edit/delete/rename, call the coding-agent invalidation helper
   - for rename/move, invalidate both old and new paths

6. **Do not add per-call TTL knobs**
   - the TTL is global policy only (env-configured), with no per-request TTL override

## Known boundaries

- Cache scope is process-local in-memory (`DashMap`), not persisted across process restarts.
- Cache stores scan entries, not final tool results.
- `glob`/`fuzzyFind`/`astGrep` share scan entries only when key dimensions (root + `WalkOptions`) match.
- `.git` pruning is traversal policy (`skip_git`), not a hard-coded behavior; every current native consumer enables it.
