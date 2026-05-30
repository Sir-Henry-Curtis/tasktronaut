# KISS Mode — Future Cleanup

## Richer return value from `recursivelyMakeClineRequests`

**File:** `src/core/task/index.ts`

**Current state:**
`recursivelyMakeClineRequests` returns a plain `boolean` (`didEndLoop`). In `initiateTaskLoop`, when KISS mode sees `didEndLoop = true`, it calls `ask("followup", "")` to keep the conversation alive. This works correctly for the primary use case (phi4-mini, text-only responses) but has an edge case:

If a capable model is used in KISS mode and goes through an `attempt_completion` → user follow-up → final text response sequence, `didEndLoop = true` fires after that final text response, and the KISS followup ask runs a second time — a double-ask after what was effectively a completed task.

**Proposed fix:**
Change the return type of `recursivelyMakeClineRequests` from `boolean` to a richer object:

```typescript
type LoopExitReason =
    | { didEnd: false }
    | { didEnd: true; reason: "textOnly"; hadToolUse: boolean }
    | { didEnd: true; reason: "maxMistakes" }

// in initiateTaskLoop:
if (result.didEnd && result.reason === "textOnly" && !result.hadToolUse) {
    // Pure text-only response with no tool use anywhere in the session —
    // safe to enter KISS conversation mode via ask("followup", "")
}
```

Only call `ask("followup", "")` when `reason === "textOnly"` AND `hadToolUse === false`. This prevents the double-ask for capable models that used tools earlier in the same loop iteration.

**Why deferred:**
- KISS mode's minimal system prompt strips the agentic scaffolding that tells models to call `attempt_completion`, so capable models in KISS mode won't hit this path in practice
- phi4-mini (primary target) never emits tool calls in this configuration
- The worst current outcome (double-ask) leaves the conversation live rather than stuck — acceptable for a conversational mode
