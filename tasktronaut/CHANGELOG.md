# Tasktronaut Changelog

## [1.2.33] - 2026-05-31

### Fixed

- **KISS mode GSD context suppression** — All three GSD hooks (`TaskStart`, `PreCompact`, `UserPromptSubmit`) now check the active mode before injecting any planning context. In KISS mode the hooks return no context, so lightweight local models receive a clean slate with no STATE.md dumps, no phase plans, and no `/gsd-*` workflow injection. The mode is surfaced by adding a `mode` field (field 8) to the `HookInput` proto message and populating it in `HookFactory.completeParams()` via `StateManager`. In non-KISS modes all existing GSD context injection is unchanged.

## [1.2.31] - 2026-05-30

### Fixed

- **`kissModeApiProvider` not coerced at state load time** — `state-helpers.ts` coerced `planModeApiProvider` and `actModeApiProvider` through `coerceSupportedApiProvider()` on every startup, but `kissModeApiProvider` was missing from the same step. If the value was stored as a non-supported provider string (e.g. `"openai-compatible"` from a prior session or backup), it would fall through to `AnthropicHandler` at runtime despite all settings-update paths coercing it correctly. Added the missing coercion so all three mode providers are normalized consistently at load time.

## [1.2.30] - 2026-05-30

### Fixed

- **`parallel_tool_calls` 400 error with Ollama/LiteLLM — second fix** — v1.2.29 set `enableParallelToolCalling: false` in KISS mode, but `getOpenAIToolParams()` always included the `parallel_tool_calls` field in the request payload regardless of its value. Ollama (and LiteLLM proxying Ollama) rejects the parameter entirely — even when `false`. Fixed by changing `getOpenAIToolParams()` to omit the field from the payload when `enableParallelToolCalls` is false, so it is only included when explicitly `true`.

## [1.2.29] - 2026-05-30

### Fixed

- **`parallel_tool_calls` 400 error with Ollama/LiteLLM** — Once native tool calling was active in KISS mode, the extension began sending `parallel_tool_calls: true` to the API. Ollama does not support this OpenAI parameter and returns a 400 error. Fixed by forcing `enableParallelToolCalling: false` when in KISS mode so the parameter is not forwarded.

## [1.2.28] - 2026-05-30

### Fixed

- **xs variant not selected for `openai-compatible` provider in KISS mode** — The xs (compact) variant matcher required `isLocalModel()` to be true in addition to `customPrompt === "compact"`. `isLocalModel()` only returns true for `"lmstudio"` and `"ollama"` — `"openai-compatible"` fails the check, so KISS mode never activated the xs variant and fell back to the generic prompt. Removed the `isLocalModel` guard: `customPrompt === "compact"` is now sufficient to select xs, regardless of provider type.

## [1.2.27] - 2026-05-30

### Fixed

- **KISS mode MCP tool calling — full end-to-end fix** — MCP tools were not reachable in KISS mode due to several layered gates, each independently blocking native tool calling:
  - **MCP hub stripped** — `mcpHub` was set to `undefined` when building the prompt context in KISS mode. MCP servers never appeared in the tool list. Fixed by removing the KISS mode guard so `mcpHub` is always passed.
  - **System prompt stripped** — KISS mode overrode `systemPrompt` to an empty string, discarding the variant-generated prompt and all tool definitions. Fixed by removing the conditional override.
  - **Native tool calls never enabled** — `enableNativeToolCalls` was not forced true in KISS mode, so the xs variant's `use_native_tools` label had no effect. Fixed by OR-ing `isKissMode` into the `enableNativeToolCalls` condition.
  - **xs variant not selected** — The prompt context did not signal `customPrompt: "compact"` in KISS mode, so the variant selector never chose xs. Fixed by building an `effectiveProviderInfo` override in KISS mode that injects `customPrompt: "compact"`, ensuring the xs variant (and its native-tool-calling label) is always selected.

## [1.2.26] - 2026-05-22

### Fixed

- **KISS mode "Thinking..." stuck state — architectural fix** — previous releases applied UI patches to `buttonConfig.ts` and `MessagesArea.tsx` to paper over the symptom. Root cause analysis: the entire UI state machine (button enable/disable, "Thinking..." indicator) is driven by `ask` messages — frontier models always end their turn by calling `attempt_completion` or `ask_followup_question`, which post `ask` messages, keeping the UI state machine coherent. KISS mode models return plain text and call no tool, leaving `say("text")` as the last message — a state the UI was never designed to handle as terminal.
  - **Fix**: `initiateTaskLoop` now calls `ask("followup", "")` after a text-only KISS response, then loops back with the user's reply. This makes KISS mode a continuous conversation loop (correct semantics) and drives the existing UI machinery the same way all other modes do — no special cases in buttonConfig or MessagesArea needed.
  - Reverted the `text_complete` buttonConfig entry and the `say("text")` exception in `MessagesArea.isWaitingForResponse` added in 1.2.24–1.2.25.
  - Retained the safety break that skips `noToolsUsed` in KISS mode (sending XML tool examples to small models triggers task_progress boilerplate from training-data pattern matching).

## [1.2.25] - 2026-05-22

### Fixed

- **KISS mode response quality and task_progress contamination** — phi4-mini and similar small models were generating `task_progress` boilerplate and degrading with each follow-up message:
  - **Root cause**: when the task loop failed to exit, `noToolsUsed` was sent as a follow-up. This message includes `toolUseInstructionsReminder` — XML tool call examples including `<attempt_completion>` and references to `task_progress` that phi4-mini picks up from its training data and mirrors in every subsequent response.
  - **Fix**: In KISS mode, the task loop now always breaks after any model response rather than sending `noToolsUsed`. KISS models are used conversationally, not agentically — a text response is always valid and should end the loop iteration cleanly.
- **Removed forced native tool calling for KISS mode** — previously, `isKissMode` was OR'd into `enableNativeToolCalls`, causing phi4-mini to emit JSON function-call chunks even without tool definitions, which set `didToolUse = true` and prevented the text-only exit path from firing.

## [1.2.24] - 2026-05-22

### Fixed

- **KISS mode "thinking…" stuck after response** — After a text-only response ended the task loop, the UI remained in a disabled "Cancel" state indefinitely:
  - **Root cause**: `getButtonConfig()` in `buttonConfig.ts` fell through to the `BUTTON_CONFIGS.partial` fallback for completed `say("text")` messages, which sets `sendingDisabled: true` and shows a "Cancel" button — the same appearance as an in-progress stream.
  - **Fix**: Added a guard before the fallback that returns `BUTTON_CONFIGS.followup` (`sendingDisabled: false`) for any completed (non-partial) `say` message that isn't `api_req_started` or `command_output`. This re-enables the input field and clears the Cancel button as soon as the response finishes.

## [1.2.23] - 2026-05-21

### Fixed

- **KISS mode system prompt and tool deadlock** — phi4-mini and similar lightweight local models would get stuck in "thinking mode" indefinitely after sending a message:
  - **Root cause**: the full system prompt's XML tool-call instructions caused the model to emit `<think>` or partial XML tags that Cline's streaming parser interpreted as an incomplete tool call, creating an infinite wait loop.
  - **Fix**: In KISS mode the system prompt is now overridden to a single minimal string (`You are a helpful AI assistant. Be concise and direct.\n\nCurrent directory: <cwd>`) and no tool definitions are sent to the model. This lets the model respond naturally without generating XML tags.
  - The working directory is included so the model can orient itself; all other context is discovered through conversation.

## [1.2.22] - 2026-05-21

### Added

- **KISS mode** — A third operating mode alongside Plan and Act, optimized for lightweight local models (Ollama, LM Studio, etc.):
  - **Minimal system prompt** — No codebase context injected: rules files, skills, MCP servers, workspace roots, cline ignore instructions, editor tabs, and browser use are all stripped. Only the bare essentials are passed to the model.
  - **Own provider/model settings** — KISS mode has its own independent API provider and model configuration (defaults to Ollama), just like Plan and Act each have their own.
  - **3-part segmented pill** — The Plan|Act toggle at the bottom of the chat input is now a three-segment Plan|Act|KISS control. Each segment is independently clickable; the keyboard shortcut cycles plan→act→kiss→plan. The slider is color-coded (yellow for Plan, blue for Act, green for KISS) and the textarea outline matches the active mode.
  - **Settings tab** — A KISS Mode tab is available in the API Configuration settings section alongside Plan Mode and Act Mode.

## [1.2.21] - 2026-05-18

### Changed

- **Network isolation for ITAR compliance** — All automatic outbound calls to third-party infrastructure are now disabled:
  - **Cline account auth** (`api.cline.bot`): `ClineAuthProvider.retrieveClineAuthInfo()` returns `null` immediately; `getAuthRequest()` throws rather than opening the OAuth browser flow. No token refresh or user-info calls are ever made.
  - **Banner event reporting** (`api.cline.bot/banners/v2/messages`): `BannerService.sendBannerEvent()` returns immediately without posting. Banner fetching was already disabled in a prior fork; this closes the remaining POST path.
  - **Third-party model discovery**: `refreshOpenRouterModels`, `refreshGroqModels`, `refreshHicapModels`, `refreshHuggingFaceModels`, `refreshBasetenModels`, `refreshVercelAiGatewayModels`, and `getAihubmixModels` all return empty model maps without making any network call. Static model lists compiled into `api.ts` are unaffected. The only remaining outbound traffic is to the user-configured model inference endpoint.

## [1.2.20] - 2026-05-18

### Added

- **`gsd-sdk query help` command** — Added a comprehensive built-in help reference to the `gsd-sdk` shim. Running `gsd-sdk query help` (or `gsd-sdk query help.all`) now prints a categorized reference of all 50+ query commands with their flag syntax to stderr and exits. This eliminates the need for the model to inspect shim source code to discover command syntax, saving multiple tool calls per workflow.

## [1.2.19] - 2026-05-17

### Fixed

- **`AskUserQuestion` buttons still not showing — more reliable fix** — The `.tasktronautrules/gsd.md` rule from 1.2.18 was present but insufficient: the `<explicit_instructions>` block containing the workflow has higher model priority than system-context rules, so the `AskUserQuestion` directive was still being followed as written. Fixed by prepending a `TASKTRONAUT RUNTIME NOTE` block directly into every bundled workflow's content (via `generate-gsd-workflows.js`). The note appears at the top of each workflow's `<explicit_instructions>` and explicitly instructs the model to call `ask_followup_question` with the option labels as a JSON string array whenever the workflow says `AskUserQuestion`, overriding any conflicting instruction.

## [1.2.18] - 2026-05-17

### Fixed

- **`AskUserQuestion` in GSD workflows renders no option buttons** — GSD workflows use `AskUserQuestion` (a Claude Code CLI tool) for presenting option menus, but Cline/Tasktronaut only has `ask_followup_question` with an `options` array. Without guidance, the model falls back to asking questions without options — no clickable buttons appear. Added a `## Tasktronaut Tool Mapping` section to `.tasktronautrules/gsd.md` that explains the translation: `AskUserQuestion` → `ask_followup_question` with the options as a JSON array. Updated `TASKTRONAUTRULES_TEMPLATE` in `GsdInstaller.ts` to include this section for new installs. Existing installs are patched automatically on next activation if the file is missing the section and still contains an unmodified `## Rules` header.

- **Queued messages not auto-sent when model becomes idle naturally** — If a message was queued while the model was busy and the model subsequently finished its task (or asked a followup question) without the user pressing "Stop & Process", the queued message sat indefinitely. Added a `useEffect` in `useMessageHandlers.ts` that watches `clineAsk` and `messageQueue`: when the model transitions to a waiting state (`followup`, `resume_task`, or `resume_completed_task`) and the queue is non-empty, the first queued message is sent automatically using the appropriate response type.

## [1.2.17] - 2026-05-17

### Fixed

- **Missing files on project initialization (comprehensive audit)** — A thorough review of all `@.tasktronaut/` hard file references in agents, workflows, and research assets revealed 6 files missing from `generate-gsd-research-assets.js` and 1 agent missing from `generate-gsd-agents.js`. Added: `references/git-integration.md`, `references/user-profiling.md`, `workflows/graduation.md`, `templates/retrospective.md`, `templates/roadmap.md`, `templates/state.md`. Added `gsd-user-profiler` agent (referenced via `@.tasktronaut/agents/gsd-user-profiler.md` in the profile-user workflow). Total research assets: 51. Total agents: 15.

- **`gsd-sdk --help` misleads model into skipping state mutations** — The shim printed "only 'query' is supported" when called without the `query` subcommand, causing the model to conclude that `state.advance-plan`, `state.update-progress`, and similar mutation commands were unavailable. In fact they all work via `gsd-sdk query state.*`. Replaced the message with a full usage guide listing all state mutation commands explicitly.

## [1.2.16] - 2026-05-17

### Fixed

- **`next.md` not installed to `.tasktronaut/workflows/` on project initialization** — `transition.md`, `execute-plan.md`, and `diagnose-issues.md` were all installed as research assets to `.tasktronaut/workflows/`, but `next.md` was only served from memory via `remoteGlobalWorkflows`. Added `next.md` to `generate-gsd-research-assets.js` so it lands on disk at `.tasktronaut/workflows/next.md` consistently with the other internal workflows.

## [1.2.15] - 2026-05-17

### Fixed

- **`/gsd-next` and `gsd-executor` attempt to dispatch slash commands, then go rogue** — `/gsd-next` instructed the model to "invoke the determined command via SlashCommand" and the executor agent had no explicit prohibition against dispatching workflow commands. Slash commands are user-layer chat triggers and cannot be dispatched from within a running task in any Claude Code runtime. The model interpreted this as license to try `gsd-sdk` dispatch (which is query-only), fail, then manually advance state or improvise. Fixed by rewriting `/gsd-next`'s `show_and_execute` step to a `show_next` step that presents a "Next Up" block and stops, and adding a `routing_prohibition` section to `gsd-executor.md` that explicitly prohibits slash command dispatch and manual state file editing outside the listed `gsd-sdk query state.*` calls.

## [1.2.14] - 2026-05-17

### Fixed

- **`/gsd-resume-work` fails with "No such file or directory" for `continuation-format.md`** — GSD workflows reference reference files via `@~/.claude/get-shit-done/references/` paths, but Tasktronaut installs those files to `.tasktronaut/references/` in the workspace. The workflow generator (`generate-gsd-workflows.js`) now rewrites `~/.claude/get-shit-done/` → `.tasktronaut/` and `~/.claude/agents/gsd-` → `.tasktronaut/agents/gsd-` in all bundled workflow content, so `@` file references resolve against the actual install location. Seven reference files that were used by workflows but missing from the bundle were also added (`continuation-format.md`, `scout-codebase.md`, `sketch-*.md`, `universal-anti-patterns.md`). The same path normalization is applied in `generate-gsd-research-assets.js` so inline path mentions in reference content are consistent.

## [1.2.13] - 2026-05-16

### Fixed

- **Message queue: queued message never sent after "Stop & Process"** — after clicking Stop & Process, the queued message was silently dropped. The root cause was a React 18 timing race: `stopAndProcessQueue` stored the pending message as React state (`setPendingQueuedMessage`) before `await cancelTask()`. Because state updates are batched and applied asynchronously, there was a window where `resume_task` arrived from the server and triggered the `useEffect` while `pendingQueuedMessage` was still `null` in that render cycle — so the effect returned early. When the state update finally applied in the next render, `clineAsk` hadn't changed from `"resume_task"`, so React did not re-fire the effect. Fixed by replacing the React state with a `useRef`: the ref is written synchronously (before any `await`), so the `useEffect` always reads the correct message regardless of when `resume_task` arrives.

## [1.2.12] - 2026-05-16

### Fixed

- **Subagent `reasoning`/`function_call` pairing in Responses API** — `SubagentRunner` was receiving `"reasoning"` stream chunks but doing nothing with them: it never called `processReasoningDelta`, so no thinking block was ever stored in the subagent's conversation history. On the next turn, the converter had a `function_call` in the history but no preceding `reasoning` item, causing the 400 error `"function_call provided without its required reasoning item"`. Fixed by wiring `reasonsHandler` in `SubagentRunner` the same way the main engine does: process each reasoning delta, then prepend the finalized thinking block (and any redacted thinking blocks) to `assistantContent` before pushing the assistant message to the subagent's conversation.

## [1.2.11] - 2026-05-16

### Fixed

- **`/gsd-map-codebase` parallel fan-out** — the four `gsd-codebase-mapper` subagents (tech, arch, quality, concerns) were being run sequentially instead of in parallel because the agent had `role: worker` and `isolation: inherit` without `allowParallelSharedWorkspace: true`. The runtime guard in `SubagentToolHandler` correctly blocked multi-prompt fan-out for shared-workspace workers to prevent collisions, but the mapper writes to distinct output files (STACK.md, ARCHITECTURE.md, etc.) so parallel execution is safe. Added `allowParallelSharedWorkspace: true` to the `gsd-codebase-mapper` agent config, regenerated the bundled agent, and updated the workspace-installed copy so all four focus areas run concurrently.

## [1.2.10] - 2026-05-16

### Fixed

- **OpenAI Responses API `reasoning`/`function_call` pairing (root cause fix)** — `gpt-5.4` with `reasoning_effort=high` produces reasoning items (`rs_...`) that have no visible content or summary. The previous fix (1.2.9) correctly handled the converter pass, but the reasoning item was never stored in the first place because `ReasoningHandler.getCurrentReasoning()` returned `null` when both content and summary were empty. The guard now only discards a pending reasoning item when there is also no `id` — so an `rs_...` ID with empty content is stored as a `thinking` block with `call_id` set, giving the converter the pairing anchor it needs to emit the reasoning item before the subsequent `function_call` when replaying conversation history.

## [1.2.9] - 2026-05-16

### Fixed

- **OpenAI Responses API `reasoning`/`function_call` pairing** — when `reasoning_effort` is set and the model generated a reasoning item (`rs_...`) before a tool call (`fc_...`), replaying the conversation history would drop the reasoning item if it had no text content (empty summary), causing a 400 error: `"function_call was provided without its required 'reasoning' item"`. The converter now uses a two-pass approach: pass 1 collects all assistant items tagging reasoning as pending; pass 2 includes a pending reasoning item only when the immediately following item is a `function_call` or `message`, which satisfies both error constraints — no orphaned reasoning items and no function_calls missing their required reasoning predecessor.

## [1.2.8] - 2026-05-16

### Added

- **Message queue while busy** — typing in the chat input and pressing Enter (or clicking the send button) while a task is running now queues the message instead of silently discarding it. A compact `MessageQueuePanel` appears below the textarea listing all queued messages with numbered rows and individual delete buttons. A **Stop & Process** button (visible only when the task is running) cancels the current task and automatically sends the first queued message as the resume payload — no manual step required. The send button and Enter key are no longer blocked when the task is busy and there is content to queue.

### Fixed

- `/gsd-progress` roadmap phase mismatch — `gsd-sdk query init.progress` was returning `current_phase` as the raw string from STATE.md (e.g. `"1"`) while all roadmap phase numbers are normalized to zero-padded form (`"01"`). Any path construction or phase lookup using the init payload would silently miss. `parseStateSnapshotData` now passes the raw value through `normalizePhaseNumber()` before returning it, so `current_phase` is always in the same format as the roadmap phase index.

## [1.2.7] - 2026-05-16

### Fixed

- Fixed `/gsd-plan-phase` creating a standalone `.xml` file (e.g. `phase-1.xml`) instead of a `.planning/phases/{slug}/01-01-PLAN.md` markdown file. The root cause was a single line in the `gsd-planner` agent's success checklist: `"PLAN file(s) exist with XML structure"`. The model correctly interpreted "XML structure" as an instruction to produce an XML document, ignoring the rest of the agent's markdown format spec. The line is now explicit: PLAN.md files at `.planning/phases/{phase-slug}/` with markdown format (YAML frontmatter + XML task tags inside markdown — not a standalone .xml file). The fix is applied to the source agent file, the workspace-installed copy, and the bundled generated agent, so new workspace installs and existing workspaces both receive the correction.

## [1.2.6] - 2026-05-16

### Fixed

- Chat message list now shows a scrollbar. The Virtuoso container previously set `scrollbar-width: none` and `-ms-overflow-style: none` as inline styles, which hid the scrollbar in modern Chromium (Electron 121+) — VS Code's webview engine now respects the standard `scrollbar-width` CSS property, so the scroll track was invisible and users had to navigate with arrow keys only. The VS Code native scrollbar styling (visible on hover/focus) already existed via the `.scrollable` CSS class; removing the suppression styles restores it.
- GSD workflow tab no longer shows "No active GSD project" when a project is active. The `GsdView` component previously relied on a `gsdState` window message that was never sent. Now: (1) when `GsdView` mounts it sends a `requestGsdState` message to the extension, which reads `STATE.md` and responds immediately; (2) `GsdOrchestrator` broadcasts updated state to the webview whenever `STATE.md` changes while the GSD tab is open.

## [1.2.5] - 2026-05-15

### Fixed

- Fixed `gsd-sdk query commit "" --files ... --amend` silently overwriting the existing commit message with `chore: gsd update`. An empty message string is now treated as "no message provided" — when `--amend` is used without an explicit non-empty message, the SDK passes `--no-edit` to git so the original commit message is preserved unchanged.
- Fixed `commit-to-subrepo` ignoring `--no-verify` and `--amend` flags. The flags were listed in the handler's `knownFlags` set (to strip them from the message string) but were never forwarded to the underlying `git commit` call. Both flags are now correctly passed through.
- Fixed all GSD bundled workflows referencing `~/.gsd/` (the upstream GSD path) instead of `~/.tasktronaut/gsd/`. Affected commands: `/gsd-new-project` global defaults check, `/gsd-settings` save-to-global flow, and the knowledge/learnings store reference in `/gsd-execute-phase`. The path replacement is now applied in the workflow generator so future regenerations will also carry the fix.

## [1.2.4] - 2026-05-15

### Fixed

- Fixed Windows `EPERM` errors when 4 subagents spawn simultaneously and all try to rename their temp files over the same `subagent-executions.json` destination. On Windows, renaming over a file that another process has open fails with `EPERM` even with unique temp names. The write path now retries up to 5 times with exponential backoff (20 ms × attempt), then falls back to a direct non-atomic write if rename keeps failing. The temp file is cleaned up on any unrecoverable failure.

## [1.2.3] - 2026-05-15

### Fixed

- Fixed a race condition in parallel subagent execution where all concurrently spawned agents wrote to the same `.tmp` registry file, causing "Unexpected non-whitespace character after JSON" parse failures. Each write now uses a unique temp-file name (random hex suffix + atomic rename). Registry reads now recover from parse errors rather than crashing, so a corrupted file resets to empty instead of blocking all subagent execution.
- GSD workspace rules (`.tasktronautrules/gsd.md`) now specify the correct `.planning/phases/XX-name/` directory convention. The previous stub used `.planning/PLANS/` and `.planning/SUMMARIES/` — paths the `gsd-sdk` parser does not recognize — causing phase and progress queries to silently fail.
- GSD workspace rules now include the ROADMAP.md format specification so the model generates SDK-compatible output (`- [ ] **Phase N: Name** - description` checklist + `### Phase N:` detail sections with `Plans:` checkbox lists) instead of plain markdown the SDK cannot parse.
- Fixed 7 hardcoded `~/.claude/get-shit-done/` references in `execute-plan.md` and `transition.md` GSD workflows — now correctly point to `~/.tasktronaut/` paths.
- GSD auto-advance no longer uses a fixed 500 ms sleep after opening a new task pane. The orchestrator now polls until the webview controller is ready (up to 5 s), eliminating a race where the pane was still initializing when the command was sent.
- GSD orchestrator command ID corrected from `gsd.toggleAutoMode` to `tasktronaut.gsd.toggleAutoMode` — the old ID silently failed to register and could not be invoked from the status bar.
- Fixed file watcher lifecycle in `GsdOrchestrator`: the `STATE.md` watcher is now properly disposed and nulled before re-creating, preventing duplicate watchers from stacking on workspace folder changes.
- Removed shell command injection risk in the `gsd-sdk` PostToolUse hook: session-ID and file-path validation now uses correct regex anchoring, and file-path traversal is blocked independently from the session-ID check.
- Replaced `execSync` with `spawnSync` in `gsd-sdk` for git log and branch config reads, so git output is captured without shell interpolation and errors return empty strings instead of throwing.
- GSD workspace install no longer writes a duplicate `gsd-tools.cjs` alongside `gsd-tools.js` — the `.cjs` path was removed from the managed asset manifest and install step.
- Removed stale `clinerules.template.md` from source (contained defunct `.planning/PLANS/` and `.planning/SUMMARIES/` paths that contradicted current SDK behavior).
- System prompt no longer references `BROWSER_SUPPORT` or `BROWSER_CAPABILITIES` placeholders after browser tooling was removed in 0.16.0 — leftover template variables are now gone from capabilities text.

### Added

- `roadmap.md` and `state.md` added to `.tasktronaut/templates/` — previously missing templates referenced by the `gsd-roadmapper` agent during `/gsd-new-project` initialization. Their absence caused the agent to fall back to freeform output that the SDK parser could not read.
- `UserPromptSubmit` hook now pre-flights `/gsd-map-project` and `/gsd-map-codebase` by running the corresponding `gsd-sdk` inventory query before the model sees the prompt, injecting structured workspace metadata as context. The hook resolves the SDK script directly (`.tasktronaut/bin/gsd-sdk.js`) with fallback to the wrapper binary, avoiding dependency on `PATH` configuration.
- `CardExecutionRecord` extended with pull-request tracking fields (`pull_request_number`, `pull_request_url`, `pull_request_state`, `pull_request_merge_status`, `pull_request_is_draft`), structured file-diff list (`file_diffs`), delivery history, review history, `delivery_note`, and a new `changes_requested` status — supporting the Laika review/delivery workflow.
- `generateCommitMsgForPath()` added to the commit message generator, allowing commit message generation to be targeted at a specific repository path rather than always using the active VS Code SCM context.
- `GsdOrchestrator.dispose()` added so the STATE.md file watcher is cleaned up when the orchestrator is torn down.

### Changed

- Web tools capability description narrowed: `web_search` is no longer advertised as a general research tool. Only `web_fetch` is described, and only when the user already has a specific URL. Removes the instruction to proactively search for up-to-date information using `web_search`.
- GSD workspace rules (`gsd.md`) now sequence the correct `gsd-sdk` calls for every command (`init.new-project`, `init.phase-op`, `plan.validate`, `plan.complete`, `phase.complete`, `progress.bar`), replacing the previous stub that had no SDK calls at all.
- Updated bundled GSD agent definitions to reflect current workflow conventions (phase-researcher, planner, project-researcher, ui-researcher).

## [1.0.13] - 2026-05-12

### Fixed

- Enabled drag-and-drop attachment handling for supported non-image files in the chat box, matching the attachment picker behavior for `.xml`, `.json`, `.txt`, `.log`, `.md`, `.docx`, `.ipynb`, `.pdf`, `.xlsx`, and `.csv`.
- Replaced the misleading "files other than images are currently disabled" drop warning with actionable messages for unsupported types, oversized files, or host drops that do not expose a usable local path.

## [1.0.12] - 2026-05-12

### Fixed

- Moved shadow Git checkpoint repositories out of IDE-managed globalStorage and into Tasktronaut-controlled OS data storage to avoid Theia file-watch/message-decoder instability from large `.git/objects` churn.
- Added first-use migration for legacy globalStorage checkpoint workspaces and cleanup coverage for both current and legacy checkpoint roots.

## [1.0.11] - 2026-05-11

### Fixed

- Scoped the welcome-screen Recent list to the current workspace so opening a different project no longer shows unrelated global chat history.
- Made the full History view default to Workspace Only, while preserving explicit filtering/search behavior for current-project task review.

## [1.0.10] - 2026-05-11

### Fixed

- Allowed plain text-only assistant answers to end a turn instead of forcing an internal no-tools-used retry, restoring normal Q&A behavior for non-actionable questions.

## [1.0.9] - 2026-05-11

### Fixed

- Replaced remaining bundled GSD `/clear` transition guidance with Tasktronaut-native `/newtask` handoff instructions.
- Added regression coverage so upstream `/clear` transition prompts are not reintroduced into bundled GSD workflows.

## [1.0.8] - 2026-05-11

### Fixed

- Replaced the `/gsd-map-codebase` existing-map placeholder with explicit instructions to render discovered `.planning/codebase/*.md` files from structured shim metadata.
- Added `existing_map_details` to `init.map-codebase` shim output so workflows can show file paths, line counts, and byte sizes instead of vague placeholders.
- Extended regression coverage for both the workflow prompt text and shim metadata.

## [1.0.7] - 2026-05-11

### Fixed

- Removed the unsupported `/clear` instruction from the `/gsd-map-codebase` completion message and replaced it with Tasktronaut-safe guidance to start a fresh task/chat if a clean context is desired before running `/gsd-new-project`.
- Added regression coverage so the map-codebase workflow does not reintroduce the invalid `/clear` → `/gsd-new-project` prompt.

## [1.0.6] - 2026-05-11

### Fixed

- Enabled Tasktronaut subagents by default for new installs so GSD brownfield mapping can advertise and use the dynamic `use_subagent_gsd_codebase_mapper` tool.
- Added an explicit `allowParallelSharedWorkspace` agent capability and enabled it for `gsd-codebase-mapper`, allowing the mapper's disjoint document-writing prompts to run in parallel while keeping ordinary shared-workspace worker agents serialized.
- Added regression coverage proving non-isolated workers remain blocked unless they opt in, and opted-in mapper-style workers actually run multiple prompts concurrently.

## [1.0.5] - 2026-05-11

### Fixed

- Normalized managed `gsd-sdk` command invocations before shell execution so bare `gsd-sdk`, POSIX `.tasktronaut/bin/gsd-sdk`, and Windows `.tasktronaut\bin\gsd-sdk(.cmd)` forms all route through the workspace launcher.
- Added a real `security.scan-for-secrets` shim query used by codebase mapping, returning masked findings and scan metadata instead of silently falling through to empty output.

## [1.0.4] - 2026-05-11

### Fixed

- Fixed Tasktronaut background command execution so workspace-managed shims in `.tasktronaut/bin` are prepended to command `PATH`, allowing bare `gsd-sdk query ...` workflow commands to resolve without a failed global-CLI attempt first.
- Added regression coverage proving a managed workspace `gsd-sdk` launcher resolves as a bare command through the standalone/background terminal path.

## [1.0.3] - 2026-05-11

### Fixed

- Stopped hook protocol JSON responses from being echoed into the chat transcript, so GSD `contextModification` output is injected for the model without duplicating visible Tasktronaut/GSD hook output for the user.
- Updated hook executor tests to use the current `.tasktronautrules/hooks` workspace path and added regression coverage for hiding JSON protocol output while preserving normal hook debug lines.
- Added explicit shipped-README attribution for the bundled/adapted GSD / Get Shit Done workflow, agent, hook, and SDK-shim components.

## [1.0.2] - 2026-05-11

### Fixed

- Added a package-time verifier for the bundled `gsd-sdk` shim so generated launcher syntax, known template-escape corruption patterns, managed launcher drift, and representative query execution are checked before release packaging.
- Fixed `/gsd-new-project` brownfield detection for non-Node projects such as Rust crates, so `Cargo.toml` plus source files route users toward codebase mapping instead of greenfield discovery.

## [1.0.1] - 2026-05-11

### Fixed

- Fixed managed `gsd-sdk.js` generation so embedded newline and regular-expression escapes survive installation on Windows, preventing `/gsd-new-project` from failing with a launcher syntax error.

## [1.0.0] - 2026-05-10

### Changed

- Released Tasktronaut 1.0.0 after closing the core trust lanes: managed runtime freshness, single product story, workflow reliability, and OpenAI runtime stability
- Brought the bundled `gsd-sdk` shim to practical parity across the main GSD workflow surface, with managed asset verification, runtime coverage, and cleanup of remaining shipped product-boundary residue

## [0.16.14] - 2026-05-10

### Changed

- Cleaned the remaining 1.0.1 residue in repo-owned notes and prompt snapshots, and tightened helper-tail/runtime parity evidence for the managed `gsd-sdk` surface

## [0.16.13] - 2026-05-10

### Changed

- Closed the remaining OpenAI trust lane with extension-host runtime tests for GPT-5 no-chaining, bounded fallback recovery, orphaned tool-output cleanup, and longer-session stability under repeated requests

## [0.16.12] - 2026-05-09

### Changed

- Made the model-warning copy in settings and chat recovery more diagnostic, with concrete failure signals and practical mitigation guidance

## [0.16.11] - 2026-05-09

### Changed

- Fixed OpenAI Responses input normalization to preserve GPT-5 reasoning/function-call continuity during trimming and drop invalid orphaned reasoning/function-call/output fragments together

## [0.16.10] - 2026-05-09

### Changed

- Fixed OpenAI Responses full-context trimming so orphaned `function_call_output` items are dropped when their matching assistant tool call has been trimmed away

## [0.16.9] - 2026-05-09

### Changed

- Disabled `previous_response_id` chaining for GPT-5 family OpenAI Responses requests and broadened rate-limit detection so Tasktronaut prefers bounded explicit local context over unstable server-side chaining

## [0.16.8] - 2026-05-09

### Changed

- Made OpenAI Responses retry bounded full-context automatically when a chained `previous_response_id` request hits `rate_limit_exceeded`, avoiding opaque server-side context reuse on GPT-5.4

## [0.16.7] - 2026-05-09

### Changed

- Added OpenAI Responses request-debug context to surfaced GPT-5.4 TPM/rate-limit errors so the Tasktronaut window shows the built request summary needed to diagnose oversized requests

## [0.16.6] - 2026-05-09

### Changed

- Added a final GPT-5.4 OpenAI Responses safeguard that truncates oversized remaining message/tool-output items when whole-item trimming still cannot get under TPM-safe request size

## [0.16.5] - 2026-05-09

### Changed

- Tightened GPT-5.4 OpenAI Responses TPM protection again with a more conservative input-token estimate and a lower chained/full-context safety budget
- Made duplicate `apply_patch` add-file mistakes return a normal actionable tool error instead of a hard executor failure

## [0.16.4] - 2026-05-09

### Changed

- Hardened OpenAI Responses request budgeting again by trimming oversized chained `previous_response_id` inputs for GPT-5.4 class models, reducing TPM rate-limit failures on long tool-heavy chats

## [0.16.3] - 2026-05-09

### Changed

- Added OpenAI Responses request-size guards for GPT-5.4 class models by setting `max_output_tokens` and trimming oversized full-context fallbacks before they hit TPM limits
- Continued the Tasktronaut-native `gsd-sdk` shim parity sweep with additional helper coverage, including the smaller helper lane and source-side frontmatter mutation support

## [0.16.2] - 2026-05-08

### Changed

- Extended the Tasktronaut-native `gsd-sdk` shim and normalized more bundled workflows away from hardcoded legacy `gsd-tools.cjs` execution paths
- Added a focused Tasktronaut 1.0 completion checklist and continued long-tail workflow/runtime cleanup across ingest, spec, verify, progress, and plan-review-convergence flows

## [0.16.1] - 2026-05-08

### Changed

- Suppressed no-op hook messages so `PostToolUse` hooks that return `cancel: false` with no context modification no longer clutter the chat transcript
- Continued hardening the bundled `gsd-sdk` shim with real verify-phase support for `frontmatter.get`, `verify.artifacts`, and `roadmap.analyze`, including both dotted and namespaced query forms

## [0.16.0] - 2026-05-08

### Changed

- Removed the built-in browser automation surface from Tasktronaut across the extension, CLI, prompts, telemetry, and docs so browser access is expected to come from external integrations such as MCP instead
- Added a dedicated GSD settings experience with expanded `gsd-sdk` workflow controls, model profiles, per-agent overrides, branching strategy, and advanced workspace configuration
- Improved the GSD workflow and settings UI layout to make long, expandable configuration surfaces much more readable and usable

## [0.15.13] - 2026-05-08

### Changed

- Expanded the GSD settings page with model profiles, per-agent model overrides, branching strategy, advanced workflow feature toggles, and additional `gsd-sdk` workspace configuration controls

## [0.15.12] - 2026-05-08

### Changed

- Reworked the GSD settings layout so each option presents its title and description above the control, improving readability and long-path wrapping in the settings panel

## [0.15.11] - 2026-05-08

### Changed

- Added a dedicated Tasktronaut settings page for workspace-local GSD workflow and `gsd-sdk` configuration stored in `.planning/config.json`
- Reworked the GSD workflow panel to use a full-surface vertical scroll layout so expanded command groups remain usable instead of collapsing into cramped nested panes

## [0.15.10] - 2026-05-08

### Changed

- Locked the supported configured provider path to OpenAI-compatible settings and removed the dead legacy multi-provider settings UI, model pickers, and related tests from the webview surface

## [0.15.9] - 2026-05-07

### Changed

- Removed the legacy kanban CLI launch, migration, and update surface from the original app while preserving Laika-facing orchestration and board functionality

## [0.15.8] - 2026-05-07

### Fixed

- OpenAI Responses native tool calls now wait for both the confirmed provider `call_id` and complete JSON arguments before execution, preventing premature tool runs that could still break `function_call_output` chaining

## [0.15.7] - 2026-05-07

### Fixed

- OpenAI Responses native tool calls now wait for the provider-confirmed `call_id` before execution, preventing follow-up turns from losing `function_call_output` blocks and triggering `No tool output found for function call ...` errors

## [0.15.6] - 2026-05-07

### Fixed

- Tasktronaut now waits for the workspace GSD install to finish during extension activation, preventing reload races where bundled `gsd-sdk` launchers were still missing when GSD workflows started

## [0.15.5] - 2026-05-07

### Fixed

- OpenAI Responses API follow-up turns now chain through `previous_response_id` in standard HTTP mode as well as websocket mode, avoiding lossy assistant-history reconstruction for `gpt-5.x` tool calls
- Added a full-context retry path when OpenAI cannot find the prior response id, so follow-up turns fall back cleanly instead of breaking the task loop

## [0.15.4] - 2026-05-07

### Fixed

- OpenAI `gpt-5.x` models selected under the standard `openai` provider now fall back to model-id-based Responses API routing when model metadata has not been hydrated yet, preventing `reasoning_effort` plus tool calls from still being sent to `/v1/chat/completions`

## [0.15.3] - 2026-05-07

### Fixed

- OpenAI `gpt-5.x` models selected under the standard `openai` provider now route automatically to the Responses API handler when the model metadata requires it, preventing `reasoning_effort` plus tool calls from being sent to `/v1/chat/completions`

## [0.15.2] - 2026-05-07

### Fixed

- GSD workspace installs are now self-contained on Windows and Unix-like systems — Tasktronaut writes workspace-local `gsd-sdk` and `gsd-tools` launchers under `.tasktronaut/bin`, updates bundled rules to point at them, and prepends that bin directory to terminal `PATH` so GSD flows no longer depend on a separate global Node-based SDK install

## [0.15.1] - 2026-05-07

### Fixed

- Unit-test bootstrap no longer fails on path aliases in focused mocha runs — Tasktronaut now uses a deterministic mocha wrapper and CommonJS-safe preload path so targeted test execution works reliably
- Added explicit `tsconfig-paths` registration to the mocha harness to keep aliased imports resolvable during standalone unit-test runs

## [0.15.0] - 2026-05-07

### Fixed

- GSD command group cards no longer render as blank grey boxes — replaced native `<details>/<summary>` elements with a React state-based collapsible that renders reliably in the VS Code webview
- Expanded GSD command groups no longer cramp the layout — header and project state widget are now pinned, and the command groups section has its own independent scroll area
- Individual expanded command groups are capped in height with internal scrolling, preventing a single large group (e.g. Core Workflow) from dominating the panel

### Added

- `gsd-sdk` shim bundled at `.tasktronautrules/hooks/gsd-sdk` — implements `gsd-sdk query` commands (init, commit, config, roadmap, agent-skills) using pure Node.js and git so GSD workflows run without the external `get-shit-done-cc` npm package
- 18 GSD agent definitions (gsd-roadmapper, gsd-project-researcher, gsd-research-synthesizer, gsd-executor, gsd-verifier, gsd-plan-checker, and 12 others) are now installed to `.claude/agents/` on workspace activation, enabling subagent spawning in GSD workflows

### Changed

- Internal constant renamed from `CLINERULES_TEMPLATE` to `TASKTRONAUTRULES_TEMPLATE`

## [0.12.12] - 2026-05-05

### Added

- Full GSD command surface (50+ slash commands) now registered across all categories: core workflow, phase management, milestones, session, existing projects, code quality, UI design, experimentation, debugging, backlog & capture, navigation, and configuration
- All 47 GSD workflow files embedded in the extension at build time via `gsd-workflows-generated.ts` — no external workflow catalog required
- GSD Workflow tab panel (`GsdView`) with grouped, clickable command cards that launch the selected command directly into a new task
- GSD hooks (`PreCompact`, `TaskStart`, `UserPromptSubmit`, `PostToolUse`) installed to `.tasktronautrules/hooks/` on workspace activation to maintain planning context across sessions

### Changed

- Expanded GSD slash command descriptions and added missing commands (`/gsd-ship`, `/gsd-fast`, `/gsd-map-codebase`, and all phase/milestone/session/quality commands)

### Removed

- Legacy Cline-branded icons (`cline-bot.svg`, `cline-bot.ttf`, `cline-bot.woff`, `robot_panel_dark.png`, `robot_panel_light.png`, `sleepy-cline.svg`, social icon set)

## [0.12.11] - 2026-05-04

### Fixed

- Welcome screen "Launch Tasktronaut" button now shows the validation error message so users know what is required to proceed
- Welcome screen now shows full model options (including reasoning effort selector) so OpenAI Compatible configuration can be completed without entering settings

## [0.12.10] - 2026-05-03

### Changed

- GSD command resolution now tracks the locally vendored `get-shit-done` workflow catalog instead of a small hardcoded subset
- `.clinerules` now auto-discovers and injects workflow specs for all 84 local vendored GSD workflow files
- Added compatibility aliases for locally renamed vendored commands such as `/gsd-resume-work`

## [0.12.9] - 2026-05-03

### Added

- `/gsd-map-codebase` command available in GSD workflow tab and slash command autocomplete — spawns parallel agents to analyze stack, architecture, conventions, and concerns before starting a new project

## [0.12.8] - 2026-05-02

### Fixed

- GSD workflow tab buttons now correctly start a new task with the selected command instead of navigating to chat without action
- GSD slash commands (`/gsd-new-project`, `/gsd-discuss-phase`, `/gsd-plan-phase`, `/gsd-execute-phase`, `/gsd-verify-work`, `/gsd-next`, `/gsd-quick`) now appear in the slash command autocomplete list

## [0.12.7] - 2026-05-02

### Changed

- All VS Code command IDs renamed from `cline.*` to `tasktronaut.*` — commands, context keys, menu items, and keybindings are now fully Tasktronaut-branded
- Extension package name changed from `claude-dev` to `tasktronaut`; extension identifier is now `tasktronaut.tasktronaut`
- Activity bar container and sidebar view IDs updated to `tasktronaut.*`

## [0.12.6] - 2026-05-01

### Changed

- Removed the remaining live YOLO CLI/runtime paths from Tasktronaut
- Simplified the extension README for the offline VS Code details page by making it intentionally text-only

## [0.12.5] - 2026-05-01

### Fixed

- Repacked extension README images as inline HTML data images for the VS Code installed-extension details renderer

## [0.12.4] - 2026-05-01

### Changed

- Removed Yolo Mode from the extension settings UI
- Removed extension runtime handling that previously special-cased Yolo Mode behavior

## [0.12.3] - 2026-05-01

### Fixed

- Inlined extension README images into the packaged VSIX so the installed details page can render them without network access

## [0.12.2] - 2026-05-01

### Fixed

- Reworked extension README image markup for better compatibility with the VS Code extension details renderer

### Changed

- Removed the Browser tab from Settings
- Removed the Images and Browser rows from Advanced model details
- Removed the dead "Allow error and usage reporting" control from General settings

## [0.12.1] - 2026-05-01

### Fixed

- Extension detail page images now render correctly — images are bundled inside the VSIX and referenced as local relative paths instead of base64 data URIs (which VS Code's webview sanitizer strips)

### Changed

- API Provider selector removed — extension now always uses OpenAI Compatible provider only
- Removed "Set Azure API version" field and "Use Azure Identity Authentication" checkbox from provider settings
- Removed account button from VS Code panel header

## [0.12.0] - 2026-04-30

### Added

- GSD (Get Stuff Done) workflow tab in sidebar navigation

### Changed

- Rebranded from Cline to Tasktronaut throughout UI, commands, and extension manifest
- Hardcoded to OpenAI Compatible provider — no other providers are available
- Extension detail page images bundled locally; no external image hosting (ITAR/EAR compliance)

### Removed

- PostHog telemetry and all external analytics
- Cline account / cloud features and account button
- MCP marketplace and remote server tabs
- Kanban launch modal
- All API providers except OpenAI Compatible (Anthropic, OpenRouter, Bedrock, Vertex, Gemini, etc.)
- Azure-specific options from provider settings
- VS Code Marketplace categories and external repository links from manifest
