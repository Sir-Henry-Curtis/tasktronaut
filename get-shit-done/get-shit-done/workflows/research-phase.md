<purpose>
Research how to implement a phase. Prefer Tasktronaut's named
`use_subagent_gsd_phase_researcher` tool when available.

Standalone research command. For most workflows, use `/gsd-plan-phase` which integrates research automatically.
</purpose>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-phase-researcher — Researches technical approaches for a phase
</available_agent_types>

<process>

## Step 0: Resolve and Validate Phase

```bash
INIT=$(gsd-sdk query init.phase-op "${PHASE}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_RESEARCHER=$(gsd-sdk query agent-skills gsd-phase-researcher)
```

Extract from init JSON:
- `phase_found`
- `phase_dir`
- `padded_phase`
- `phase_number`
- `phase_name`
- `state_path`
- `requirements_path`
- `context_path`

If `phase_found` is false: Error and exit.

## Step 1: Check Existing Research

```bash
ls .planning/phases/${PHASE}-*/RESEARCH.md 2>/dev/null || true
```

If exists: Offer update/view/skip options.

## Step 2: Run Research

If `use_subagent_gsd_phase_researcher` is available, use it. Otherwise perform
the same research inline in the current context.

```text
use_subagent_gsd_phase_researcher(
  prompt_1="<objective>
Research implementation approach for Phase {phase}: {name}
</objective>

<required_reading>
- {context_path} (USER DECISIONS from /gsd-discuss-phase)
- {requirements_path} (Project requirements)
- {state_path} (Project decisions and history)
</required_reading>

${AGENT_SKILLS_RESEARCHER}

<additional_context>
Phase description: {description}
Phase number: {phase_number}
Phase directory: {phase_dir}
</additional_context>

<output>
Write to: {phase_dir}/{padded_phase}-RESEARCH.md
</output>"
)
```

> **ORCHESTRATOR RULE — TASKTRONAUT RUNTIME**: After calling
> `use_subagent_gsd_phase_researcher`, wait for the result before doing more
> research inline. If the tool is unavailable, perform the same research in the
> current context and write `{phase_dir}/{padded_phase}-RESEARCH.md` yourself.

## Step 3: Handle Return

- `## RESEARCH COMPLETE` — Display summary, offer: Plan/Dig deeper/Review/Done
- `## CHECKPOINT REACHED` — Present to user, spawn continuation
- `## RESEARCH INCONCLUSIVE` — Show attempts, offer: Add context/Try different mode/Manual

</process>
