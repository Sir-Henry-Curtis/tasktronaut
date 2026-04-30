# GSD (Get Shit Done) Workflow v1.5
# Bundled with this extension. No external downloads required.

## Overview
GSD is a spec-driven workflow for AI-assisted development.
It prevents context rot by using fresh context windows per execution phase.
State lives in .planning/ at the workspace root.

## Directory Convention
- .planning/PROJECT.md   — vision, goals, constraints
- .planning/ROADMAP.md   — phased delivery plan
- .planning/STATE.md     — current phase / step
- .planning/PLANS/       — XML task plans per phase
- .planning/SUMMARIES/   — phase completion summaries

## Slash Commands
When the user runs a /gsd-* command, execute the matching workflow below.
Do not apply GSD workflows unless the user explicitly invokes a /gsd-* command.

### /gsd-new-project
1. Ask discovery questions: goals, constraints, tech stack, timeline.
2. Write .planning/PROJECT.md with vision and constraints.
3. Write .planning/ROADMAP.md with 3-7 phases.
4. Write .planning/STATE.md: current_phase: 1, current_step: discuss.

### /gsd-discuss-phase
1. Read STATE.md for current phase.
2. Ask questions: approach, risks, acceptance criteria, dependencies.
3. Write decisions to .planning/PLANS/phase-N-decisions.md.
4. Update STATE.md: current_step: plan.

### /gsd-plan-phase
1. Read STATE.md, PROJECT.md, ROADMAP.md, and phase decisions.
2. Scan relevant source directories.
3. Write .planning/PLANS/phase-N.xml with tasks: id, description, files_affected, acceptance_criteria.
4. Update STATE.md: current_step: execute.

### /gsd-execute-phase
1. Read STATE.md and phase-N.xml plan.
2. Group independent tasks into waves; execute each wave.
3. Commit after each task: git commit -m "task(N.M): description".
4. Update STATE.md: current_step: verify on completion.

### /gsd-verify-work
1. Read acceptance criteria from phase-N.xml.
2. Verify each criterion is met.
3. On pass: write .planning/SUMMARIES/phase-N.md, advance STATE.md to next phase.
4. On fail: write fix plan and re-enter execute.

### /gsd-next
Read STATE.md and run the appropriate next /gsd-* command automatically.

### /gsd-quick
Run a single task outside the phase workflow. Commit as: quick: description.

## Rules
- Never skip discuss — decisions made here prevent rework.
- Plans are immutable once execution starts.
- One commit per task, no bundling.
- Verify against original acceptance criteria, not the implementation.
- On context pressure (>150k tokens), save STATE.md and open a fresh task.
