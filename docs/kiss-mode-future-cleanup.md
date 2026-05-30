# KISS Mode Future Cleanup

## Richer Loop Exit Reason

The task loop currently reports whether a loop ended, but not why it ended. KISS mode treats a text-only response as a valid conversational turn and posts a follow-up ask so the UI is ready for the next user message.

That behavior is correct for the primary target: small local models that do not use tools. There is one edge case for more capable models used in KISS mode:

1. The model uses a completion tool.
2. The user sends a follow-up.
3. The model gives a final plain-text response.
4. KISS mode sees the loop ended and posts another follow-up ask.

The result is a harmless but messy double-ask.

## Proposed Shape

Replace the plain loop-ended boolean with a structured result:

```typescript
type LoopExitResult =
	| { didEnd: false }
	| { didEnd: true; reason: "textOnly"; hadToolUse: boolean }
	| { didEnd: true; reason: "maxMistakes" }
```

KISS mode should only post the conversational follow-up when the loop ended because of a text-only response and no tool was used in that loop.

```typescript
if (result.didEnd && result.reason === "textOnly" && !result.hadToolUse) {
	// Keep the KISS conversation alive.
}
```

## Why It Was Deferred

- The current KISS prompt removes the agentic scaffolding that usually causes completion tool calls.
- The primary target models do not emit tool calls in this configuration.
- The worst current outcome is a duplicate prompt-ready state, not a stuck UI or data loss.

This should be cleaned up when KISS mode grows support for model capability profiles.
