import { ResponseInput, ResponseInputMessageContentList, ResponseReasoningItem } from "openai/resources/responses/responses"
import { ClineStorageMessage } from "@/shared/messages/content"

/**
 * Converts an array of ClineStorageMessage objects (extension of Anthropic format) to a ResponseInput array to use with OpenAI's Responses API.
 *
 * ## Key Differences from Chat Completions API
 *
 * The Responses API has stricter requirements than the Chat Completions API:
 *
 * ### Chat Completions API:
 * - Messages are simple role/content pairs
 * - System prompts are separate messages with role="system"
 * - No explicit reasoning item structure
 * - More forgiving about message ordering
 *
 * ### Responses API:
 * - Uses an "input" array of heterogeneous items (messages, reasoning, function_calls, etc.)
 * - System prompts go in an "instructions" field, not as messages
 * - Reasoning items MUST be immediately followed by a message or function_call
 * - Strict ordering requirements match training data distribution
 *
 * ## The Reasoning Item Constraint
 *
 * **THE CRITICAL ERROR:** "Item 'rs_...' of type 'reasoning' was provided without its required following item"
 *
 * This error occurs when reasoning items are orphaned or separated from their corresponding output.
 *
 * ### What Causes This Error:
 * ```
 * ❌ WRONG - Reasoning orphaned between turns:
 * [
 *   { role: "user", content: [...] },
 *   { type: "reasoning", id: "rs_abc", summary: [...] },  // ← ORPHANED!
 *   { type: "message", role: "assistant", content: [...] },
 *   { role: "user", content: [...] }
 * ]
 * ```
 *
 * ### The Fix - Keep Complete Assistant Turns Together:
 * ```
 * ✅ CORRECT - Reasoning paired with its message:
 * [
 *   { role: "user", content: [...] },
 *   { type: "reasoning", id: "rs_abc", summary: [...] },
 *   { type: "message", role: "assistant", content: [...] },  // ← Immediately follows reasoning
 *   { role: "user", content: [...] }
 * ]
 * ```
 *
 * **Per OpenAI Engineering Guidance:**
 * - ❌ WRONG: `content += filter(lambda x: x.type == "reasoning", resp.output)`
 * - ✅ CORRECT: `content += resp.output`
 *
 * Never extract only reasoning items - always include the complete output sequence
 * (reasoning + message/function_call) as provided by the API.
 *
 * ## Implementation Strategy
 *
 * 1. **Separate processing for assistant vs user messages** - Assistant turns need special
 *    handling to maintain reasoning-message pairing
 * 2. **Collect all assistant items together** - Gather reasoning, messages, and function_calls
 *    for the entire assistant turn before validating
 * 3. **Validate pairing within each turn** - Ensure each reasoning item is immediately followed
 *    by a message or function_call, inserting placeholders if needed
 * 4. **Flush complete turns atomically** - Add all items from an assistant turn together to
 *    maintain proper sequencing
 *
 * @link https://community.openai.com/t/openai-api-error-function-call-was-provided-without-its-required-reasoning-item-the-real-issue/1355347
 *
 * @param messages - Array of ClineStorageMessage objects to be converted
 * @returns ResponseInput array containing the transformed messages with proper reasoning pairing
 */
export function convertToOpenAIResponsesInput(
	_messages: ClineStorageMessage[],
	options?: { usePreviousResponseId?: boolean },
): {
	input: ResponseInput
	previousResponseId?: string
} {
	// Chain from the latest stored Responses API assistant message when available.
	// When chaining, only send new items after that assistant turn.
	// If the latest assistant boundary would strand tool results without a provable
	// originating function call, fall back to full-context mode instead of sending
	// orphaned function_call_output items that the Responses API will reject.
	let previousResponseId: string | undefined
	let messages = _messages
	if (options?.usePreviousResponseId) {
		for (let i = _messages.length - 1; i >= 0; i--) {
			const msg = _messages[i]
			// Must be less than 24 hours old to be considered for chaining as the previous Id is only valid for 24 hours.
			// Set to 23 hours to account for any potential delays in processing.
			const isLessThan23HoursOld = msg.ts ? Date.now() - msg.ts < 23 * 60 * 60 * 1000 : false
			if (msg.role === "assistant" && msg.id && isLessThan23HoursOld) {
				const candidateMessages = _messages.slice(i + 1)
				if (canChainFromAssistantBoundary(msg, candidateMessages)) {
					previousResponseId = msg.id
					messages = candidateMessages
				}
				break
			}
		}
	}

	const allItems: any[] = []
	const toolUseIdToCallId = new Map<string, string>()

	for (const m of messages) {
		if (typeof m.content === "string") {
			allItems.push({ role: m.role, content: [{ type: "input_text", text: m.content }] })
			continue
		}

		if (m.role === "assistant") {
			// For assistant messages, we must ensure reasoning items are IMMEDIATELY followed
			// by their corresponding message or function_call. Process the entire assistant
			// turn and ensure proper pairing.
			//
			// Two-pass approach:
			//   Pass 1 — collect all candidate items, tagging reasoning items as pending.
			//   Pass 2 — include a pending reasoning item only when the next item is a
			//             function_call or message, preventing both error types:
			//               • "function_call provided without its required reasoning item"
			//                 (happens when we drop reasoning that preceded a function_call)
			//               • "reasoning provided without its required following item"
			//                 (happens when reasoning is orphaned at end of turn)
			type PendingReasoning = { __pending_reasoning: true; item: ResponseReasoningItem }
			const assistantItems: Array<any | PendingReasoning> = []

			for (const part of m.content) {
				switch (part.type) {
					case "thinking": {
						if (part.call_id && part.call_id.length > 0) {
							const hasThinkingContent = part.thinking && part.thinking.trim().length > 0
							const hasSummaryContent = part.summary && Array.isArray(part.summary) && part.summary.length > 0
							let summary: any[] = []
							if (hasSummaryContent) {
								summary = part.summary as any[]
							} else if (hasThinkingContent) {
								summary = [{ type: "summary_text", text: part.thinking }]
							}
							// Tag as pending — pass 2 decides whether to keep or drop
							assistantItems.push({
								__pending_reasoning: true,
								item: { id: part.call_id, type: "reasoning", summary } as ResponseReasoningItem,
							} as PendingReasoning)
						}
						break
					}
					case "redacted_thinking":
						// Include reasoning item with encrypted content if it has a call_id
						// Even if data is missing, we need to maintain the reasoning-function_call pairing
						if (part.call_id && part.call_id.length > 0) {
							const reasoningItem: any = {
								id: part.call_id,
								type: "reasoning",
								summary: [],
							}
							// Only include encrypted_content if data exists
							if (part.data) {
								reasoningItem.encrypted_content = part.data
							}
							// Tag as pending — same pass-2 gate as thinking
							assistantItems.push({
								__pending_reasoning: true,
								item: reasoningItem as ResponseReasoningItem,
							} as PendingReasoning)
						}
						break
					case "text": {
						const messageItem: any = {
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: part.text }],
						}
						if (part.call_id) {
							messageItem.id = part.call_id
						}
						assistantItems.push(messageItem)
						break
					}
					case "image": {
						const imageItem: any = {
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: `[image:${part.source.media_type}]` }],
						}
						if (part.call_id) {
							imageItem.id = part.call_id
						}
						assistantItems.push(imageItem)
						break
					}
					case "tool_use": {
						const call_id = part.call_id || part.id
						if (part.call_id) {
							toolUseIdToCallId.set(part.id, part.call_id)
						}
						assistantItems.push({
							type: "function_call",
							call_id,
							// MAX 53 characters for OpenAI Responses API tool IDs
							id: !part.id.startsWith("fc_") ? `fc_${part.id.slice(0, 50)}` : part.id,
							name: part.name,
							arguments: JSON.stringify(part.input ?? {}),
						})
						break
					}
				}
			}

			// Pass 2 — resolve pending reasoning items.
			// A reasoning item is included iff the immediately following item is a
			// function_call or message (i.e. it is not orphaned).
			for (let i = 0; i < assistantItems.length; i++) {
				const item = assistantItems[i] as any
				if (item.__pending_reasoning) {
					const next = assistantItems[i + 1] as any | undefined
					const nextIsAnchor = next && !next.__pending_reasoning && (next.type === "function_call" || next.type === "message")
					if (nextIsAnchor) {
						allItems.push(item.item)
					}
					// Drop orphaned reasoning items — no following function_call or message
				} else {
					allItems.push(item)
				}
			}
		} else {
			// User messages - collect all content
			const messageContent: ResponseInputMessageContentList = []

			for (const part of m.content) {
				switch (part.type) {
					case "text":
						messageContent.push({ type: "input_text", text: part.text })
						break
					case "image":
						messageContent.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${part.source.media_type};base64,${part.source.data}`,
						})
						break
					case "tool_result": {
						// Flush any pending message content before adding tool result
						if (messageContent.length > 0) {
							allItems.push({ role: m.role, content: [...messageContent] })
							messageContent.length = 0
						}
						const call_id = part.call_id || toolUseIdToCallId.get(part.tool_use_id) || part.tool_use_id
						allItems.push({
							type: "function_call_output",
							call_id,
							output: typeof part.content === "string" ? part.content : JSON.stringify(part.content),
						})
						break
					}
				}
			}

			// Flush any remaining user message content
			if (messageContent.length > 0) {
				allItems.push({ role: m.role, content: [...messageContent] })
			}
		}
	}

	return { input: allItems, previousResponseId }
}

function canChainFromAssistantBoundary(assistantMessage: ClineStorageMessage, followingMessages: ClineStorageMessage[]): boolean {
	const toolResults = collectToolResults(followingMessages)
	if (toolResults.length === 0) {
		return true
	}

	const assistantCallIds = collectAssistantCallIds(assistantMessage)
	if (assistantCallIds.size === 0) {
		return false
	}

	return toolResults.every((toolResult) => {
		const callId = typeof toolResult.call_id === "string" ? toolResult.call_id.trim() : ""
		return callId.length > 0 && assistantCallIds.has(callId)
	})
}

function collectAssistantCallIds(message: ClineStorageMessage): Set<string> {
	const callIds = new Set<string>()
	if (!Array.isArray(message.content)) {
		return callIds
	}

	for (const part of message.content) {
		if (part.type !== "tool_use") {
			continue
		}

		const callId =
			typeof part.call_id === "string" && part.call_id.trim().length > 0
				? part.call_id.trim()
				: typeof part.id === "string" && part.id.startsWith("call_")
					? part.id.trim()
					: ""

		if (callId.length > 0) {
			callIds.add(callId)
		}
	}

	return callIds
}

function collectToolResults(messages: ClineStorageMessage[]) {
	return messages.flatMap((message) => {
		if (!Array.isArray(message.content)) {
			return []
		}

		return message.content.filter((part): part is Extract<(typeof message.content)[number], { type: "tool_result" }> => {
			return part.type === "tool_result"
		})
	})
}
