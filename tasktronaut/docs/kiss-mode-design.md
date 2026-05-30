# KISS Mode Design

## Core Principle

Small local models (phi4-mini, Mistral 7B, Llama 3.x, etc.) reason poorly when given unsolicited context. Any system prompt — even a well-intentioned one — activates training patterns that override the model's natural response to what the user actually said. The user loses control of the conversation before it starts.

KISS mode's job is to get out of the way and let the user drive.

---

## Phase 1 — Zero contamination (complete)

**What ships now (1.2.26):**

- System prompt: empty string. No behavioral instructions, no directory context, nothing.
- Tools: sent only if the model's API format supports native tool calling (`ApiFormat.OPENAI_RESPONSES`) or the user has enabled it globally. phi4-mini gets nothing.
- Environment details: suppressed.
- Task resumption wrapper (`[TASK RESUMPTION]`, `<user_message>`): suppressed.
- `noToolsUsed` loop message: suppressed — KISS is conversational, not agentic. Any text response is valid.
- Loop mechanics: after a text-only response, `ask("followup", "")` is posted silently. The UI enables the input and the conversation continues. The task loop stays alive for the whole session.

**What the model receives:**

```
[no system prompt]

User: <exactly what the user typed>
```

Nothing else. The model's response is entirely its own.

---

## Phase 2 — User-authored context (next)

After the first model response, Tasktronaut offers the user a small set of context options. The user's selection becomes the system prompt for all subsequent turns in the session. The user is the author; Tasktronaut just gives them a clean interface to write it.

### Option chips (shown once, after first response)

| Label | System prompt injected |
|---|---|
| Helpful assistant | `You are a helpful assistant.` |
| Code helper | `You are a coding assistant. Be precise and concise.` |
| Browse directory | `Current directory: <cwd>` |
| Simple & direct | `Be kind, simple, and direct.` |
| [Custom…] | User types free-form text |

Selecting one dismisses the chips and stores the chosen string as `kissContext` for the session. All subsequent turns prepend it as the system prompt. The user can change it via a small "context" badge in the chat header.

### State

- `kissContext: string | null` — per-task, not persisted across sessions. Starts null (no context).
- Set to a non-null string on first user selection; subsequent turns use it.

### Files to change

| File | Change |
|---|---|
| `src/core/task/index.ts` | Read `kissContext` from task state; inject as system prompt when non-null |
| `src/core/task/index.ts` (initiateTaskLoop) | On first `ask("followup", "")`, pass a flag/marker so the webview knows to show context chips |
| Proto: `proto/cline/task.proto` or `proto/cline/ui.proto` | New `say` type or field to signal "show context picker" |
| `webview-ui/src/components/chat/` | New `KissContextPicker` component rendered when that signal is received |
| `webview-ui/src/components/chat/ChatRow.tsx` | Render the picker row |
| `src/core/controller/task/` | Handler for `setKissContext` RPC |

---

## Phase 3 — Model capability detection

Not every KISS model is phi4-mini. A Mistral 7B or Llama 3.2 in KISS mode might handle tools, structured output, or longer context just fine. Right now we send zero tools to everything. A better approach:

- On first connection, run a lightweight capability probe (single hidden message, not shown to user):
  - Does the model follow a tool call? → enable tools
  - Does the model handle multi-turn context cleanly? → allow longer history
  - Does the model hallucinate structure? → keep system prompt minimal

- Store capability profile per model ID (persistent, updated on each new model).
- Let the capability profile control what KISS sends: system prompt length, tool availability, history window.

This is the "start small, grow if capable" behavior the user originally described.

### Files to change

| File | Change |
|---|---|
| `src/core/task/index.ts` | Run capability probe on first KISS task per model |
| New: `src/core/kiss/capability-profile.ts` | Probe logic + persistent storage per model ID |
| `src/shared/storage/state-keys.ts` | `kissCapabilityProfiles: Record<string, KissCapabilityProfile>` |

---

## Phase 4 — Adaptive context (future)

Once we have capability profiles and user-authored context, the next step is letting the model signal what it needs. If the model asks "what directory are we in?" — Tasktronaut notices and offers to add that. If the model struggles with a multi-step task — Tasktronaut offers to add structure. The user approves each addition.

This is low-priority and depends on Phase 2 and 3 being stable.

---

## What KISS mode is not

- Not a stripped-down Act mode. Act mode is agentic — the model drives toward a goal using tools. KISS is conversational — the user drives, the model responds.
- Not a settings toggle on the existing system prompt. The existing prompt is designed for Claude-class models and cannot be trimmed to work for phi4-mini.
- Not a permanent mode for capable models. If the user wants a capable model with full context, they should use Act or Plan mode.

---

## Known deferred issues

See [kiss-mode-future-cleanup.md](kiss-mode-future-cleanup.md) for the `recursivelyMakeClineRequests` return type refinement (double-ask edge case for capable models using `attempt_completion` in KISS mode).
