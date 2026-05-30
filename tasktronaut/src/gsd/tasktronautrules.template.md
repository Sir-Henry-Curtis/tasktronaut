# GSD (Get Shit Done) Workflow — v1.5
# Bundled with this extension — no network fetch required.
# Installed to .tasktronautrules/gsd.md in the workspace root.

## Overview
GSD is a structured spec-driven workflow for AI-assisted development.
It prevents context rot by using fresh context windows per execution phase.

GSD v1.5 adds four lifecycle hooks (PreCompact, TaskStart, UserPromptSubmit, PostToolUse)
that automatically inject project state and detect stuck loops.

## Directory Convention
All GSD state lives in `.planning/` at the workspace root:
- `PROJECT.md`   — vision, goals, constraints
- `ROADMAP.md`   — phased delivery plan
- `STATE.md`     — current phase / step (machine-readable)
- `PLANS/`       — XML task plans per phase
- `SUMMARIES/`   — phase completion summaries

## Slash Commands

When the user runs a `/gsd-*` command, load the relevant workflow below and execute it.
Do not apply GSD workflows unless the user explicitly invokes a `/gsd-*` command.

### /gsd-new-project
Start a brand-new project. Steps:
1. Ask structured discovery questions (goals, constraints, tech stack, timeline, team size).
2. Write `.planning/PROJECT.md` with vision, goals, and constraints.
3. Write `.planning/ROADMAP.md` with phased delivery plan (3–7 phases).
4. Write `.planning/STATE.md`:
   ```
   current_phase: 1
   current_step: discuss
   phase_name: [first phase name]
   started_at: [ISO timestamp]
   ```

### /gsd-discuss-phase
Capture implementation decisions for the current phase. Steps:
1. Read `STATE.md` to find the current phase and phase name.
2. Read the relevant phase section from `ROADMAP.md`.
3. Ask targeted questions: approach, key risks, acceptance criteria, dependencies.
4. Write decisions to `.planning/PLANS/phase-[N]-decisions.md`.
5. Update `STATE.md`: `current_step: plan`.

### /gsd-plan-phase
Research the codebase and produce an atomic XML task plan. Steps:
1. Read `STATE.md`, `PROJECT.md`, `ROADMAP.md`, and phase decisions.
2. Scan the relevant source directories for existing patterns.
3. Produce `.planning/PLANS/phase-[N].xml` with this structure:
   ```xml
   <plan phase="N" name="[phase name]">
     <task id="N.1">
       <description>...</description>
       <files_affected>...</files_affected>
       <acceptance_criteria>...</acceptance_criteria>
     </task>
   </plan>
   ```
4. Update `STATE.md`: `current_step: execute`.

### /gsd-execute-phase
Execute the current phase plan wave by wave. Steps:
1. Read `STATE.md` and `.planning/PLANS/phase-[N].xml`.
2. Group tasks with no inter-dependencies into waves.
3. For each wave: execute tasks, then commit: `git commit -m "task(N.M): <description>"`.
4. Mark completed tasks in the plan file.
5. On completion: update `STATE.md`: `current_step: verify`.

### /gsd-verify-work
Run UAT against acceptance criteria. Steps:
1. Read the phase plan and its acceptance criteria.
2. For each task: verify the acceptance criteria are met.
3. On all pass: write `.planning/SUMMARIES/phase-[N].md` and update `STATE.md`:
   ```
   current_phase: [N+1]
   current_step: discuss
   phase_name: [next phase name]
   ```
4. On any failure: write a fix plan and re-enter the execute loop.

### /gsd-ship
Create a PR from the verified work. Steps:
1. Ensure `STATE.md` shows `current_step: verify` or completed.
2. Run `git push` and create a PR with the phase summary as the PR body.

### /gsd-next
Auto-detect `STATE.md` and run the appropriate next command.
Use this for hands-off progression through the workflow.
1. Read `STATE.md`.
2. Map `current_step` to the correct `/gsd-*` command.
3. Execute that command.

### /gsd-quick
Run a single small task outside the phase workflow.
Good for hotfixes, one-off refactors, or exploratory spikes.
1. Clarify the task scope (must fit in one session).
2. Execute and commit: `git commit -m "quick: <description>"`.

## STATE.md Format
```
current_phase: 2
current_step: execute
phase_name: Authentication Module
started_at: 2026-04-29T00:00:00Z
```

## Workflow Rules
- Never skip the discuss step — decisions made here prevent rework later.
- Plans are immutable once execution starts; amend via a new plan file.
- Each git commit covers exactly one task from the plan — no bundling.
- Verify runs against the original acceptance criteria, not the implementation.
- On context pressure (>150k tokens used), save STATE.md and open a fresh task.
- Planning artifacts in `.planning/` are the source of truth — not conversation history.
