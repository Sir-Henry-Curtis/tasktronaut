# Tasktronaut Changelog

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
