<!-- /autoplan restore point: /Users/matthewschrager/.gstack/projects/matthewschrager-orchestra/orchestra-orchestra-zib3gbghz0n-autoplan-restore-20260413-210853.md -->

# Codex App-Server Migration Plan

**Current Branch:** `orchestra/orchestra-zib3gbghz0n`

## Problem

Orchestra's Codex integration currently uses `@openai/codex-sdk`, which wraps the Codex CLI JSONL event stream. That stream is good enough for assistant text, tool events, and turn completion, but it does not expose the richer thread state the Codex app/CLI uses internally.

The immediate user-visible bug is context usage. Orchestra can only see aggregate turn token totals from `turn.completed.usage`, so the StickyRunBar sometimes shows absurd numbers that are not actual context occupancy. The local Codex app-server protocol exposes `thread/tokenUsage/updated` with `tokenUsage.last` and `modelContextWindow`, which is the right signal.

This is not just a metrics bug. The SDK path is the wrong abstraction level for a host app like Orchestra. If we want long-term parity with the Codex app, we should integrate against the Codex app-server protocol directly.

## Goal

Replace the current SDK-backed Codex adapter with an app-server-backed Codex adapter that:

1. Preserves Orchestra's current Codex functionality.
2. Surfaces accurate per-request token usage and context-window data.
3. Supports resume, interrupt, and streaming updates cleanly.
4. Keeps the rest of Orchestra's adapter/session architecture mostly unchanged.
5. Removes the need for heuristic interpretation of Codex turn metrics.

## Non-Goals

- Rewriting the Claude adapter.
- Reworking Orchestra's general session manager architecture.
- Adding a product feature flag for old-vs-new Codex transports.
- Building a full Codex desktop-app feature clone beyond what Orchestra needs.

## Desired Outcome

After this change:

- Codex threads in Orchestra show the same kind of context-fill signal the Codex app/CLI shows.
- StickyRunBar no longer needs special-case hiding for Codex due to missing context-window data.
- Codex transport becomes a real host-app integration, not a thin CLI wrapper.
- Future Codex-only capabilities can be added from app-server notifications instead of guessed from terminal output.

## Current State

### Transport

- `server/src/agents/codex.ts` starts a `Codex` SDK client and consumes `thread.runStreamed()`.
- The adapter implements `AgentAdapter.start()` only. It is resume-capable but not persistent.
- `StartOpts.resumeSessionId` is passed into `codex.resumeThread(...)`.

### Parsing

- `CodexParser` maps SDK events like `thread.started`, `item.started`, `item.updated`, `item.completed`, and `turn.completed` into Orchestra `ParseResult`.
- Tool rendering, AskUserQuestion extraction, Todo snapshots, command previews, and file-change diffs are already working here.

### UX limitation

- Orchestra cannot derive Codex context occupancy from the SDK stream.
- The app-server schema exposes:
  - `thread/tokenUsage/updated`
  - `tokenUsage.last`
  - `tokenUsage.total`
  - `modelContextWindow`

That is the correct source of truth for the run-bar context meter.

## Proposed Design

### 1. Introduce a Codex app-server transport layer

Add a transport module dedicated to the app-server protocol, for example:

- `server/src/agents/codex-app-server/client.ts`
- `server/src/agents/codex-app-server/protocol.ts`

Responsibilities:

- launch `codex app-server` as a subprocess over stdio
- send typed requests and correlate responses
- consume server notifications as an async stream
- expose lifecycle helpers for start/resume/send/interrupt/close

Important constraint:

- Keep all raw protocol method names, IDs, and JSON-RPC-ish framing inside this layer.
- The rest of Orchestra should not know app-server method strings.

### 2. Keep the existing `AgentAdapter` shape

Do not make session manager app-server-aware.

Instead, keep the boundary:

- `CodexAdapter.start()` or `startPersistent()`
- `AgentSession.messages`
- `parseMessage(msg)`
- `abort()`
- optional persistent operations like `injectMessage()` / `close()`

That lets the session manager stay focused on thread lifecycle and persistence.

### 3. Upgrade Codex to a persistent session model

The app-server protocol is stateful. We should use that rather than emulating per-turn CLI runs.

Target behavior:

- Codex adapter supports `supportsPersistent(): true`
- `startPersistent()` creates or resumes an app-server-backed thread session
- follow-up user messages are sent through the live app-server connection instead of creating a fresh SDK thread wrapper each turn
- interrupt uses app-server turn interruption rather than local process abort only

This brings Codex closer to the Claude adapter's operational model, even if implementation details differ.

### 4. Preserve the existing parser boundary, but adapt inputs

Do not rewrite all Codex UI parsing from scratch unless necessary.

Instead:

- translate app-server notifications into a normalized internal event shape
- update `CodexParser` to consume that shape
- keep the current message/delta outputs for:
  - assistant text
  - command execution
  - file changes
  - MCP tool calls
  - AskUserQuestion extraction
  - todo snapshots

If app-server item payloads differ materially, do the translation in a dedicated normalization layer so parser logic stays readable.

### 5. Add first-class token usage and context-window handling

Use `thread/tokenUsage/updated` as the source of truth for the StickyRunBar metrics.

Map:

- `tokenUsage.last.inputTokens`
- `tokenUsage.last.cachedInputTokens`
- `tokenUsage.last.outputTokens`
- `tokenUsage.last.reasoningOutputTokens`
- `modelContextWindow`

Decision:

- The displayed "context usage" metric should represent one model request against one context window.
- For Codex, the visible filled-token total includes reasoning output tokens because the user wants the run bar to reflect total per-request context occupancy, not just user-visible output.
- Aggregate turn totals remain useful, but if retained, they should be separate from context occupancy.

### 6. Decide how Orchestra models Codex token metrics

Introduce an explicit distinction in Orchestra's shared types between:

- per-request context occupancy
- aggregate turn usage

Minimum acceptable change:

- enough type clarity that the client cannot accidentally render aggregate turn usage as context usage again.

Preferred shape:

- keep the existing context widget fed only by per-request + context-window data
- optionally add a separate raw turn-usage field later if we still want that number

### 7. Support resume and restart semantics cleanly

The adapter must handle:

- new thread start
- existing thread resume from persisted Codex thread/session ID
- Orchestra server restart while Codex thread exists on disk
- user stop / interrupt
- failed turn / failed app-server subprocess

Required behavior:

- persisted thread IDs remain the resume anchor
- session manager still persists session IDs on first thread creation
- a failed app-server process should degrade predictably, not orphan the Orchestra thread forever

### 8. Keep approval/sandbox mapping intact

Current Codex adapter maps Orchestra permission modes into Codex sandbox/approval settings through `toCodexPermissionConfig(...)`.

That mapping should remain intact in the app-server transport:

- `bypassPermissions`
- `acceptEdits`
- `default`

No behavior regression here. If app-server expresses these differently, adapt in the transport layer.

### 9. Make accurate metrics restore after refresh

Once app-server token usage is available, Codex should persist the same thread-level metrics path Orchestra already uses for refresh-safe run-bar hydration.

Result:

- idle Codex threads show the last request's context usage correctly
- running Codex threads recover after refresh with the latest known context snapshot

## Implementation Phases

### Phase A: Protocol discovery and mapping

Deliverables:

- inventory of the exact app-server requests/notifications Orchestra needs
- mapping table from app-server events to current `CodexParser` inputs
- decision on stdio process model and whether one app-server process serves one Orchestra session or one adapter instance

Output artifact:

- protocol mapping section in this plan updated with concrete method names and payloads

### Phase B: App-server client

Build:

- subprocess launcher for `codex app-server`
- request/response dispatcher
- notification stream
- connection shutdown handling
- typed wrappers for start/resume/send/interrupt

### Phase C: Adapter swap

Build:

- replace SDK-backed `CodexAdapter` transport with app-server transport
- preserve existing parsing outputs
- support resume and interrupt
- decide whether Codex becomes persistent immediately in this phase

### Phase D: Metrics correctness

Build:

- token usage notification handling
- context-window plumbing into Orchestra `StreamDelta` / persisted thread metrics
- client rendering updated to trust the new context data
- remove temporary Codex hiding behavior once accurate data is present

### Phase E: Hardening

Build:

- restart/resume tests
- interrupt tests
- malformed notification handling
- cleanup / subprocess-exit handling
- compatibility notes for older Codex versions if needed

## Files Likely Affected

### Server

- `server/src/agents/codex.ts`
- `server/src/agents/types.ts`
- `server/src/sessions/manager.ts`
- new files under `server/src/agents/codex-app-server/`

### Shared

- `shared/src/types.ts`

### Client

- `client/src/components/StickyRunBar.tsx`
- `client/src/App.tsx` if metrics shape changes

### Tests

- `server/src/agents/__tests__/codex.test.ts`
- new tests for transport/protocol mapping
- session manager tests for Codex resume/interrupt/metrics
- client tests for Codex context display

## Architecture Decisions To Lock In

1. **Transport scope**
   - Option A: one app-server process per Orchestra Codex session
   - Option B: shared app-server process multiplexing multiple Orchestra sessions

   Recommendation: start with A. It is simpler, isolates failures, and matches current adapter/session boundaries.

2. **Persistence model**
   - Option A: keep Codex non-persistent in Orchestra, but use app-server only within a turn
   - Option B: make Codex persistent in Orchestra using the live app-server connection

   Recommendation: B. The app-server is stateful. Not using that would leave value on the table and complicate token usage handling.

3. **Metric semantics**
   - Option A: display only per-request context occupancy
   - Option B: display per-request context occupancy and separate aggregate turn usage

   Recommendation: A in this migration. Get the correct metric in first. Add separate turn-usage UI later if still useful.

## Risks

1. **App-server protocol churn**
   - It is labeled experimental.
   - Mitigation: isolate protocol details in one module and add focused tests.

2. **Lifecycle complexity**
   - Resume and interrupt behavior may differ from SDK assumptions.
   - Mitigation: add transport tests and session-manager integration tests before deleting old assumptions.

3. **Process overhead**
   - Per-session app-server processes may consume more resources than the SDK wrapper.
   - Mitigation: choose per-session first for correctness, then optimize if needed after measuring.

4. **Parser mismatch**
   - App-server item payloads may not match SDK event shapes exactly.
   - Mitigation: normalize before parsing instead of mixing transport and UI logic together.

5. **Version coupling**
   - Orchestra may become more sensitive to Codex CLI version changes.
   - Mitigation: detect version at adapter startup and fail with a clear message if unsupported.

## Failure Modes and Rescue Plan

| Failure mode | User impact | Detection | Rescue |
|---|---|---|---|
| App-server fails to launch | Codex threads cannot start | startup error | surface clear adapter error with command/version context |
| Resume ID accepted by Orchestra but rejected by Codex | existing thread cannot continue | resume response error | mark thread errored and offer restart with preserved history |
| Token usage notifications stop arriving | context meter stale or absent | missing metrics during active turn | degrade gracefully, keep thread functional, show no context widget |
| Interrupt semantics differ | stop button appears unreliable | interrupt test failure / runtime mismatch | fall back to process abort while logging the gap |
| Protocol fields change between Codex versions | adapter breaks after CLI upgrade | parser/transport tests | version guard plus clear unsupported-version message |

## Test Plan

1. Transport unit tests for request correlation and notification dispatch.
2. Adapter tests for:
   - new thread start
   - resume existing thread
   - interrupt active turn
   - token usage notification mapping
3. Parser tests covering app-server-normalized item events.
4. Session manager tests for Codex persistent-session behavior if we enable it.
5. StickyRunBar/client tests verifying Codex now receives real `contextWindow`-backed usage.
6. Restart test: persist thread ID, reconstruct session, continue a thread after Orchestra restart.

## Rollout

Big bang. No feature flag.

Sequence:

1. Land transport layer and adapter swap.
2. Land token usage/context-window plumbing.
3. Update client to trust app-server-backed context metrics.
4. Remove any temporary Codex-specific UI suppression tied to missing context-window data.
5. Run targeted Codex transport/session/UI tests.

## Open Questions

1. Does app-server provide everything we need for AskUserQuestion-style events, or will some current Codex tool-routing logic need adaptation?
2. Which exact notification should drive assistant text streaming, item notifications, and turn state transitions?
3. Should reasoning-output tokens count toward the same visible total as output tokens in the context meter, or remain separate?
4. Do we want to retain aggregate turn totals anywhere in Orchestra after this migration?

## Recommendation

Move Codex to app-server now, not later. It is the correct integration layer for a host app like Orchestra, and it is the only local protocol surface we have found that exposes the context-window-backed token usage signal users actually expect.

## AUTOPLAN REVIEW

### Phase 1: CEO Review

#### Premise Challenge

- The core premise is valid. The real problem is not "Codex numbers look weird." The real problem is that Orchestra is integrating a host app through the lowest-fidelity Codex surface and then guessing at product state.
- Doing nothing keeps a user-visible bug alive and blocks future Codex parity work. The current SDK path cannot expose the same thread/token state the Codex app-server protocol exposes.
- The better framing is: **promote Codex from a CLI wrapper integration to a first-class host-app integration**. The context meter bug is just the forcing function.

#### What Already Exists

| Sub-problem | Existing code | Reuse decision |
|---|---|---|
| Adapter boundary | `server/src/agents/types.ts` | Reuse. Keep `AgentAdapter` stable. |
| Current Codex parsing | `server/src/agents/codex.ts` | Reuse parser semantics, add normalization layer ahead of it. |
| Persistent-session lifecycle | `server/src/sessions/manager.ts` | Reuse. Codex should plug into the same persistent path Claude already uses. |
| Persisted run metrics | `server/src/db/index.ts`, `shared/src/types.ts`, `client/src/App.tsx`, `client/src/components/StickyRunBar.tsx` | Reuse. Feed these with real app-server token/context data. |
| Resume storage | `threads.session_id` persistence in DB/session manager | Reuse. Do not invent a second resume anchor. |
| Permission/sandbox mapping | `toCodexPermissionConfig(...)` in current adapter | Reuse conceptually. Adapt only transport-specific wiring. |

#### Dream State Delta

```text
CURRENT STATE                  THIS PLAN                         12-MONTH IDEAL
CLI JSONL wrapper       --->   app-server-backed adapter   --->  host-grade Codex integration
wrong context metric           real context-window data          feature parity with Codex surfaces
non-persistent Codex           persistent Codex sessions         transport-agnostic agent runtime
```

#### Implementation Alternatives

**APPROACH A: Patch the metric only**
  Summary: Keep SDK transport, hide or hack around token semantics, ship no transport change.
  Effort: S
  Risk: Low
  Pros: smallest diff, fastest ship
  Cons: still wrong abstraction, no future Codex parity, more heuristics later
  Reuses: all current Codex code

**APPROACH B: App-server transport, non-persistent Codex**
  Summary: Replace SDK transport but still treat Codex as per-turn in Orchestra.
  Effort: M
  Risk: Medium
  Pros: gets correct token source, smaller lifecycle change
  Cons: leaves app-server value on the table, duplicates lifecycle logic, weak long-term shape
  Reuses: current session manager plus legacy restart assumptions

**APPROACH C: App-server transport plus persistent Codex**
  Summary: Move Codex onto app-server and the persistent-session path from the start.
  Effort: L
  Risk: Medium
  Pros: correct architecture, fixes the bug at the right layer, unlocks future Codex capabilities
  Cons: more moving parts in one migration, needs better lifecycle tests
  Reuses: persistent-session machinery, existing parser semantics, existing metrics persistence

**RECOMMENDATION:** Choose `Approach C` because this repo already has a persistent-session runtime, and bolting app-server onto the old non-persistent Codex model would be extra migration work with worse long-term shape.

#### Vision

- Codex threads behave like real long-lived Orchestra sessions, not disposable CLI calls.
- The run bar shows the same kind of context-fill signal users already trust in Claude threads.
- Future Codex host-state features arrive by subscribing to app-server notifications, not by reverse-engineering terminal text.

#### Scope Decisions

##### Accepted Scope

- Replace `@openai/codex-sdk` transport usage with a Codex app-server transport layer.
- Make Codex a persistent Orchestra adapter in the same architectural class as Claude.
- Normalize app-server notifications into the current parser boundary instead of rewriting all tool rendering.
- Feed persisted thread metrics from `thread/tokenUsage/updated` and `modelContextWindow`.
- Add version/compatibility handling and restart/resume/interrupt tests as part of the migration, not after it.

##### NOT in Scope

- Rewriting the Claude adapter. It already has the right host-level lifecycle.
- Building a shared multi-thread app-server multiplexer in v1. Too much blast radius.
- Shipping a separate aggregate turn-usage UI in the same PR. Fix the correct metric first.
- Broad product/UI redesign beyond the existing StickyRunBar/context semantics.
- Repairing unrelated docs drift around `staging` vs `main` in the same migration.

#### Error & Rescue Registry

| Codepath | Failure | Rescued? | Rescue action | User impact |
|---|---|---|---|---|
| `CodexAppServerClient.start()` | process launch fails | Y | surface adapter error, leave thread recoverable | thread never starts |
| `thread/start` or `thread/resume` request | resume rejected / protocol error | Y | mark thread errored, preserve history, allow fresh restart | follow-up cannot continue |
| notification stream pump | malformed/unknown notification | Y | log and ignore unknown shape, fail only on critical protocol corruption | degraded Codex UX, not server crash |
| token usage mapping | `thread/tokenUsage/updated` missing | Y | omit context widget, keep thread functional | no context meter |
| interrupt path | turn interrupt unsupported/ignored | Y | fall back to subprocess abort and explicit user message | stop button less graceful |
| persistent session end | app-server exits unexpectedly mid-turn | Y | transition thread to resumable error state | user must retry |

#### Failure Modes Registry

| CODEPATH | FAILURE MODE | RESCUED? | TEST? | USER SEES? | LOGGED? |
|---|---|---|---|---|---|
| app-server launch | missing binary / bad version | Y | planned | explicit thread error | yes |
| resume | stored session ID invalid | Y | planned | explicit "send follow-up to restart" path | yes |
| token metrics | wrong field semantics | Y | planned | no/stale context meter | yes |
| parser normalization | item payload mismatch | Y | planned | broken tool rendering | yes |
| persistent queueing | follow-up inject during idle/waiting broken | Y | planned | queued or failed follow-up | yes |
| shutdown/restart | orphaned process or stale state | Y | planned | unexpected session ended message | yes |

#### CEO Dual Voices

- Primary review: this migration is strategically right, but only if it commits fully to app-server as the Codex host interface instead of carrying old per-turn assumptions forward.
- Codex outside voice: attempted, but the CLI did not return a usable summary on a reasonable timeline in this session. Treat as unavailable for this run.

#### CEO Consensus Table

| Dimension | Primary Review | Codex Voice | Consensus |
|---|---|---|---|
| Right problem? | Yes | unavailable | CONFIRMED by primary evidence |
| Reuse existing architecture? | Yes | unavailable | CONFIRMED by code read |
| Need full app-server migration? | Yes | unavailable | CONFIRMED by protocol gap |
| Keep scope tight? | Yes | unavailable | CONFIRMED by review |
| Shared multiplexer now? | No | unavailable | CONFIRMED by review |
| Separate raw turn-usage UI now? | No | unavailable | CONFIRMED by review |

#### CEO Completion Summary

- Mode selected: `SELECTIVE EXPANSION`
- Key decision: expand only where the expansion is load-bearing for correctness, namely persistent Codex lifecycle and compatibility/error handling
- Scope proposals: 3 considered, 1 accepted architecture path, 2 explicitly deferred
- Verdict: the plan is pointed in the right direction after tightening scope around protocol ownership and lifecycle correctness

### Phase 2: Design Review

#### System Audit

- UI scope exists, but it is narrow. This plan does not create a new screen. It changes the semantics of the existing Codex context display in `StickyRunBar`.
- `DESIGN.md`: not found.
- Existing design leverage: reuse current `StickyRunBar` affordance and avoid introducing a second token widget unless the product later chooses to expose aggregate turn usage explicitly.

#### Design Scores

| Pass | Initial | Final | Notes |
|---|---:|---:|---|
| Information Architecture | 6 | 8 | The plan now clearly says this is a transport/lifecycle migration, not a UI redesign. |
| States Coverage | 5 | 8 | Added explicit degraded state: no token-usage notification means no context widget, not a fake number. |
| Journey / Emotional Arc | 6 | 8 | User outcome is clearer: Codex threads stop lying about context usage. |
| AI Slop / Specificity | 5 | 8 | Replaced generic "future capabilities" language with concrete app-server notifications and lifecycle hooks. |
| Design System Alignment | 7 | 8 | Reuses existing run bar rather than adding a parallel widget. |
| Responsive / Accessibility | 7 | 8 | No new layout surface. Existing component semantics remain intact. |
| Unresolved Design Decisions | 6 | 8 | One real decision remains: whether reasoning tokens count toward the displayed total. |

#### Design Decisions

- Decision: keep the existing context widget shape, but only feed it genuine per-request plus `modelContextWindow` data.
- Decision: do not add a second raw "turn tokens" number in this migration.
- Decision: degraded state is absence of the widget, not fallback to misleading totals.

#### Design Litmus Scorecard

| Dimension | Primary Review | Codex Voice | Consensus |
|---|---|---|---|
| Specific UI described? | Yes, narrowly | unavailable | CONFIRMED |
| Missing states handled? | Mostly, with one token ambiguity | unavailable | CONFIRMED |
| Responsive strategy intentional? | Existing component reused | unavailable | CONFIRMED |
| Accessibility regressions introduced? | No obvious new risk | unavailable | CONFIRMED |
| Generic patterns instead of specifics? | Reduced after edits | unavailable | CONFIRMED |
| Design system alignment? | Reuse existing widget | unavailable | CONFIRMED |
| Unresolved UX ambiguity? | reasoning-token display remains | unavailable | DISAGREE deferred to gate |

#### Design Completion Summary

- Overall design score: `6/10 -> 8/10`
- Key issue fixed: the plan now treats the user-facing change as semantic correction of an existing UI, not an invitation to invent new UI
- Resolved at approval gate: include `reasoningOutputTokens` in the visible context-fill total

### Phase 3: Eng Review

#### Architecture

```text
Codex app-server process
        |
        v
server/src/agents/codex-app-server/client.ts
        |
        v
server/src/agents/codex-app-server/normalize.ts
        |
        v
server/src/agents/codex.ts (adapter + parser boundary)
        |
        v
server/src/sessions/manager.ts
        |
        +--> persisted thread/session/metrics state in server/src/db/index.ts
        |
        +--> stream deltas to client/src/App.tsx
                               |
                               v
                     client/src/components/StickyRunBar.tsx
```

#### Engineering Findings

1. The plan must explicitly own a normalization layer between app-server protocol payloads and `CodexParser`. Mixing raw protocol parsing into existing UI mapping code will turn `server/src/agents/codex.ts` into a 600-line trap.
2. The plan must treat version compatibility as part of startup, not a cleanup task. The protocol is marked experimental. Failing late after a thread starts is bad product behavior.
3. The migration should land with persistent Codex support immediately. The session manager already has the right primitives. Doing transport first and persistent-lifecycle later is an artificial split.
4. The plan should avoid a shared app-server multiplexer in v1. That is a separate concurrency and fault-isolation problem, not part of fixing Codex host fidelity.

#### Code Quality

- Reuse over rebuild is strong here. `AgentAdapter`, persistent session handling, persisted metrics, and parser outputs already exist.
- The main quality risk is boundary slippage. Keep transport, normalization, adapter semantics, and UI mapping in separate files.
- The shared metric types are currently documented as per-request occupancy. The migration must preserve that contract or rename/add fields so a future regression is harder to write.

#### Test Diagram

```text
User starts Codex thread
  -> adapter launches app-server
     -> thread started notification
        -> session_id persisted
           -> assistant/item/tool deltas stream
              -> metrics notification arrives
                 -> DB thread metrics update
                    -> client hydrates + StickyRunBar renders context

Branches:
  A. new thread
  B. resumed thread
  C. interrupt active turn
  D. follow-up on idle persistent session
  E. app-server exits mid-turn
  F. token usage notification missing
  G. malformed notification ignored
  H. persisted session ID rejected on resume
```

#### Test Plan Artifact

- Written to: `/Users/matthewschrager/.gstack/projects/matthewschrager-orchestra/matthewschrager-orchestra-orchestra-zib3gbghz0n-test-plan-20260413-212420.md`

#### Deployment and Rollback

- Deployment sequence:
  1. ship new app-server transport files
  2. wire Codex adapter to app-server
  3. enable persistent path for Codex
  4. map token usage notifications into existing persisted metrics
  5. run targeted server/client tests
- Rollback:
  - restore `server/src/agents/codex.ts` to SDK-backed transport
  - keep client-side Codex context widget hidden until accurate context data exists again
  - do not leave mixed SDK/app-server semantics in the same adapter

#### Eng Dual Voices

- Primary review: architecture is good if the transport boundary is explicit and persistent Codex is part of the same migration.
- Codex outside voice: attempted, but the CLI review did not converge to a usable summary in this session. Marking external voice unavailable.

#### ENG DUAL VOICES — CONSENSUS TABLE

| Dimension | Primary Review | Codex Voice | Consensus |
|---|---|---|---|
| Architecture sound? | Yes, with normalization layer | unavailable | CONFIRMED |
| Test coverage sufficient? | Not yet, needs transport + restart cases | unavailable | CONFIRMED |
| Performance risks addressed? | Partially, multiplexer deferred | unavailable | CONFIRMED |
| Security threats covered? | Mostly, version/launch failure needs explicit handling | unavailable | CONFIRMED |
| Error paths handled? | Good direction, needs startup/resume failure specifics | unavailable | CONFIRMED |
| Deployment risk manageable? | Yes, if rollback restores SDK path cleanly | unavailable | CONFIRMED |

#### Eng Completion Summary

- Architecture: `8/10`
- Code quality plan: `8/10`
- Test plan: `7/10`, now made concrete by the external test-plan artifact
- Biggest gap closed: the migration now explicitly separates transport, normalization, adapter, and UI semantics

### Phase 3.5: DX Review

#### Product Type

- Primary product type for this plan: `CLI Tool / Platform`
- Why: the user is a developer running Orchestra locally to orchestrate agent sessions; this migration changes the reliability and clarity of the developer-facing agent transport

#### Developer Persona Card

```text
TARGET DEVELOPER PERSONA
========================
Who:       Solo developer dogfooding Orchestra locally
Context:   Running Codex and Claude in worktrees, watching live session state
Tolerance: Very low for misleading metrics or flaky resume/interrupt behavior
Expects:   Existing threads keep working, context meters mean what they say, failures are obvious and recoverable
```

#### Developer Empathy Narrative

I open Orchestra because I want one place to drive local agent work. I do not want to think about whether Codex is coming from a CLI wrapper, an SDK, or some internal protocol. I just want the thread to behave like a serious tool. When the run bar says a context number, I assume it means the same kind of thing it means for Claude. If it shows nonsense, I stop trusting the whole strip. Then I stop trusting resume, stop, and recovery too. For this migration to feel good, I need zero ambiguity: start a Codex thread, see accurate state, interrupt it cleanly, refresh the page, and keep going. If the app-server fails, tell me in plain English what failed and what to do next. No mystery meat.

#### Competitive DX Benchmark

| Tool | TTHW | Notable DX Choice | Source |
|---|---|---|---|
| Codex app/CLI | immediate | first-party thread state feels internally consistent | local product behavior |
| Claude Code | immediate | persistent sessions + accurate context semantics in Orchestra | repository behavior |
| Orchestra current Codex path | immediate but misleading | easy start, weak state fidelity | current codebase |
| Target after this plan | immediate and trustworthy | Codex should feel like a first-class Orchestra runtime | reviewed plan |

#### Magical Moment Specification

- Magical moment: start a Codex thread in Orchestra, watch real tool activity stream, and trust the context strip because it matches what Codex itself knows.
- Delivery vehicle: existing live thread UI, no new onboarding surface needed.

#### Developer Journey Map

| Stage | Current experience | After this plan |
|---|---|---|
| Start thread | Works | Works |
| Watch thread state | Partial | Accurate Codex host-state |
| Interpret context meter | Misleading today | Correct per-request context occupancy |
| Interrupt turn | Legacy/non-persistent semantics | Real persistent interrupt semantics |
| Refresh/reconnect | Limited | Better continuity of Codex session truth |
| Debug failures | Mixed | Explicit app-server failure/resume states |

#### DX Scorecard

| Dimension | Score |
|---|---:|
| Getting Started | 9/10 |
| API/CLI/SDK clarity | 7/10 |
| Error Messages | 7/10 |
| Documentation | 6/10 |
| Upgrade Path | 5/10 |
| Dev Environment | 8/10 |
| Community / supportability | 6/10 |
| DX Measurement | 7/10 |

- TTHW: `~1 min`, target remains `~1 min`
- Competitive Rank: `Competitive`
- Overall DX: `6.9/10`

#### DX Implementation Checklist

- [x] Time to hello world stays effectively unchanged
- [x] Installation remains one command for the repo
- [x] First run continues to produce meaningful thread output
- [x] Magical moment remains in-product, not punted to docs
- [ ] Every app-server launch/resume failure message is specified in the plan
- [ ] Version compatibility story is specified for unsupported Codex builds
- [ ] Docs/changelog note the transport migration and the meaning of Codex context usage
- [x] Works in CI with Bun tests
- [ ] Upgrade/rollback notes are explicit for maintainers

#### DX Completion Summary

- The developer experience outcome is good if the migration ships with clear failure text and a compatibility note.
- The main DX risk is silent ambiguity, not raw implementation complexity.

### Cross-Phase Themes

**Theme: Protocol truth over heuristics** — flagged in CEO, Design, Eng, and DX. High-confidence signal. This migration is only worth doing if Orchestra stops guessing at Codex state and instead consumes the authoritative protocol.

**Theme: Keep the boundary clean** — flagged in CEO and Eng. The transport layer, normalization layer, and adapter/parser boundary must stay separate or this migration will age badly.

### Deferred to TODOS.md

- Shared multi-session app-server process. Valuable later if Codex concurrency becomes a bottleneck, but it is not required for correctness now.
- Separate raw aggregate turn-usage UI for Codex. Useful only after the correct context metric is in place.
- Broader docs cleanup around `staging` vs `main`. Prior project learning says the repo docs still mention `staging`, but `origin/staging` is gone.

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | Treat this as a host-integration migration, not a one-off metrics patch | Mechanical | Choose completeness | The bug comes from the wrong integration layer | SDK-only patch |
| 2 | CEO | Recommend full app-server plus persistent Codex | Taste | Choose completeness | The repo already has persistent primitives; partial migration adds churn | app-server + non-persistent Codex |
| 3 | CEO | Keep shared app-server multiplexing out of v1 | Mechanical | Explicit over clever | It is a separate concurrency problem | shared app-server process now |
| 4 | Design | Reuse the existing context widget instead of adding a second token UI | Mechanical | DRY | The product issue is semantic correctness, not missing chrome | new Codex-specific token widget |
| 5 | Design | Degrade to no widget when token usage notification is absent | Mechanical | Explicit over clever | No signal is better than lying | fallback to aggregate turn totals |
| 6 | Eng | Add a normalization layer between app-server protocol and `CodexParser` | Mechanical | Explicit over clever | Keeps transport churn out of UI mapping logic | raw protocol parsing in `codex.ts` |
| 7 | Eng | Make version compatibility a startup concern | Mechanical | Bias toward action | Fail fast with a clear message beats latent protocol breakage | post-ship compatibility cleanup |
| 8 | Eng | Require restart/resume/interrupt tests in the migration | Mechanical | Choose completeness | Lifecycle regressions would be user-visible and painful | metrics-only tests |
| 9 | DX | Primary persona is the solo developer dogfooding Orchestra locally | Mechanical | Pragmatic | That is the actual user for this migration today | enterprise platform persona |
| 10 | DX | Defer separate aggregate turn-usage UI | Taste | Bias toward action | Correctness first, extra surface later if still wanted | ship both context and raw turn usage now |
| 11 | Approval Gate | Keep Codex persistence in scope for the same migration | Taste | Choose completeness | The persistent path is the cleaner long-term architecture and avoids a second migration | transport-only migration |
| 12 | Approval Gate | Include `reasoningOutputTokens` in the visible Codex context-fill total | Taste | Explicit over clever | The user wants the run bar to reflect total per-request occupancy against the model context window | omit reasoning tokens from visible total |

## Final Approval

- Status: approved with one override
- Approval date: `2026-04-14`
- Locked choices:
  - Codex persistence is included in this migration
  - Visible Codex context usage includes `reasoningOutputTokens`
