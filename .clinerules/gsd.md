# Tasktronaut GSD Adapter

Tasktronaut does not maintain a second hand-written copy of the GSD command set.

The canonical workflow catalog for `/gsd-*` commands lives in:

- `get-shit-done/get-shit-done/workflows/*.md`

## How Slash Commands Are Resolved

When a user runs `/gsd-...`:

1. `.clinerules/hooks/UserPromptSubmit` detects the command.
2. The hook auto-discovers the vendored workflow files.
3. The matching workflow markdown is injected into context.
4. Relevant `.planning/` files are attached when present.

This keeps the Tasktronaut integration aligned with the vendored GSD library instead of a manually curated subset.

## Current Compatibility Policy

- Every workflow file in `get-shit-done/get-shit-done/workflows/` should be invokable as `/gsd-<filename>`.
- Filenames with underscores also accept dashed aliases where appropriate.
- Known compatibility alias:
  - `/gsd-resume-work` resolves to `resume-project.md`

## Brownfield Guidance

- Use `/gsd-map-codebase` to analyze an existing repository before initialization.
- Use `/gsd-new-project` to initialize a new `.planning/` workspace.
- Use `/gsd-help` to inspect the broader command surface described by the vendored GSD docs.

## Maintenance Rule

If commands are added or removed later, update the vendored workflow catalog first.
The Tasktronaut hook should derive support from that catalog rather than from this file.
