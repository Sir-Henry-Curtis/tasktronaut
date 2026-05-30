# KISS Mode Design

KISS mode exists for lightweight local models that perform poorly when they receive a full agentic system prompt. The mode starts from almost no scaffolding and lets the user drive the conversation.

## Core Principle

Small local models often react to unsolicited context by imitating training patterns instead of answering the user's request. Tool schemas, XML examples, task wrappers, and dense system instructions can all push the model toward boilerplate.

KISS mode's job is to get out of the way.

## Phase 1: Zero Contamination

The current KISS baseline sends:

- no system prompt
- no environment details
- no task resumption wrapper
- no synthetic "no tools used" reminder
- no tool definitions unless the selected API format and settings explicitly support native tool calling

The model receives the user's message as directly as possible:

```text
[no system prompt]

User: <exactly what the user typed>
```

After a text-only response, Tasktronaut silently posts a follow-up ask so the UI returns to an input-ready state and the conversation stays alive.

## Phase 2: User-Authored Context

The next intended improvement is optional user-authored context. After the first model response, Tasktronaut can offer a small set of context choices. The user's selection becomes the session prompt for subsequent turns.

Example choices:

| Label | Prompt |
| --- | --- |
| Helpful assistant | `You are a helpful assistant.` |
| Code helper | `You are a coding assistant. Be precise and concise.` |
| Browse directory | `Current directory: <workspace>` |
| Simple and direct | `Be kind, simple, and direct.` |
| Custom | User-provided text |

This keeps the user as the author of added context. Tasktronaut provides the interface, not the behavior policy.

## Phase 3: Model Capability Detection

Not every KISS model is equally limited. Some local models can handle tools, structured output, or a longer context window. A future capability profile can let Tasktronaut start small and grow only when a model proves it can handle more.

A profile could track:

- whether the model follows native tool calls
- whether it stays coherent across multiple turns
- whether it hallucinates tool or progress structures
- how much prompt and history context it tolerates

The profile should be stored per model identity and adjusted as the model changes.

## Phase 4: Adaptive Context

Once user-authored context and capability profiles are stable, Tasktronaut can offer context only when the conversation indicates a need. If the model asks what directory it is in, Tasktronaut can offer to add workspace context. If the model struggles with a multi-step task, Tasktronaut can offer a little structure.

The user should approve each addition.

## What KISS Mode Is Not

- It is not a stripped-down Act mode. Act mode is agentic; KISS is conversational.
- It is not a settings toggle on the full system prompt. The full prompt is built for stronger tool-using models.
- It is not the best mode for capable models that need full project context. Use Plan or Act for that.

## Deferred Cleanup

See [KISS Mode Future Cleanup](./kiss-mode-future-cleanup.md) for the loop-exit refinement that would prevent a double-ask edge case for capable models using completion tools in KISS mode.
