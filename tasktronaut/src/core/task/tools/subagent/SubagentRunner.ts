import fs from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { ApiHandler, buildApiHandler } from "@core/api"
import { parseAssistantMessageV2, ToolUse } from "@core/assistant-message"
import { discoverAvailableSkills } from "@core/context/instructions/user-instructions/skills"
import { formatResponse } from "@core/prompts/responses"
import { PromptRegistry } from "@core/prompts/system-prompt"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { StreamResponseHandler } from "@core/task/StreamResponseHandler"
import { SubagentExecutionMetadata } from "@shared/ExtensionMessage"
import { ClineAssistantToolUseBlock, ClineStorageMessage, ClineTextContentBlock, ClineUserContent } from "@shared/messages"
import { Logger } from "@shared/services/Logger"
import { ClineDefaultTool, ClineTool } from "@shared/tools"
import { ContextManager } from "@/core/context/context-management/ContextManager"
import { checkContextWindowExceededError } from "@/core/context/context-management/context-error-handling"
import { getContextWindowInfo } from "@/core/context/context-management/context-window-utils"
import { HostRegistryInfo } from "@/registry"
import { ClineError, ClineErrorType } from "@/services/error"
import { ApiFormat } from "@/shared/proto/cline/models"
import { calculateApiCostAnthropic } from "@/utils/cost"
import { createWorktree, getGitRootPath } from "@/utils/git-worktree"
import { isNextGenModelFamily } from "@/utils/model-utils"
import { TaskState } from "../../TaskState"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import { SubagentBuilder } from "./SubagentBuilder"
import { finalizeSubagentExecution, registerSubagentExecution, updateSubagentExecutionProgress } from "./SubagentExecutionRegistry"

const MAX_EMPTY_ASSISTANT_RETRIES = 3
const MAX_INITIAL_STREAM_ATTEMPTS = 3
const INITIAL_STREAM_RETRY_BASE_DELAY_MS = 2_000

export type SubagentRunStatus = "completed" | "failed"

export interface SubagentRunResult {
	status: SubagentRunStatus
	result?: string
	error?: string
	stats: SubagentRunStats
	execution?: SubagentExecutionMetadata
}

interface SubagentProgressUpdate {
	stats?: SubagentRunStats
	latestToolCall?: string
	status?: "running" | "completed" | "failed"
	result?: string
	error?: string
	execution?: SubagentExecutionMetadata
}

interface SubagentRunStats {
	toolCalls: number
	inputTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	totalCost: number
	contextTokens: number
	contextWindow: number
	contextUsagePercentage: number
}

interface SubagentRequestUsageState {
	inputTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	totalTokens: number
	totalCost?: number
}

interface SubagentUsageState {
	currentRequest: SubagentRequestUsageState
	lastRequest?: SubagentRequestUsageState
}

interface SubagentToolCall {
	toolUseId: string
	id?: string
	call_id?: string
	signature?: string
	name: string
	input: unknown
	isNativeToolCall: boolean
}

interface SubagentContextState {
	conversationHistoryDeletedRange?: [number, number]
}

interface SubagentExecutionContext {
	workspaceRoot: string
	cwd: string
	worktreePath?: string
	branchName?: string
	isolated: boolean
}

function createEmptyRequestUsageState(): SubagentRequestUsageState {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
	}
}

function serializeToolResult(result: unknown): string {
	if (typeof result === "string") {
		return result
	}

	if (Array.isArray(result)) {
		return result
			.map((item) => {
				if (!item || typeof item !== "object") {
					return String(item)
				}

				const maybeText = (item as { text?: string }).text
				if (typeof maybeText === "string") {
					return maybeText
				}

				return JSON.stringify(item)
			})
			.join("\n")
	}

	return JSON.stringify(result, null, 2)
}

function toActivityPreview(value: string, maxLength = 240): string {
	const normalized = value.replace(/\s+/g, " ").trim()
	if (!normalized) {
		return ""
	}
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

function toToolUseParams(input: unknown): Partial<Record<string, string>> {
	if (!input || typeof input !== "object") {
		return {}
	}

	const params: Record<string, string> = {}
	for (const [key, value] of Object.entries(input)) {
		params[key] = typeof value === "string" ? value : JSON.stringify(value)
	}

	return params
}

function formatToolArgPreview(value: string, maxLength = 48): string {
	const normalized = value.replace(/\s+/g, " ").trim()
	if (normalized.length <= maxLength) {
		return normalized
	}
	return `${normalized.slice(0, maxLength - 3)}...`
}

function formatToolCallPreview(toolName: string, params: Partial<Record<string, string>>): string {
	const entries = Object.entries(params).filter(([, value]) => value !== undefined)
	const visibleEntries = entries.slice(0, 3)
	const omittedCount = Math.max(0, entries.length - visibleEntries.length)

	const args = visibleEntries
		.map(([key, value]) => `${key}=${formatToolArgPreview(value ?? "")}`)
		.concat(omittedCount > 0 ? [`...+${omittedCount}`] : [])
		.join(", ")

	return `${toolName}(${args})`
}

function normalizeToolCallArguments(argumentsPayload: unknown): string {
	if (typeof argumentsPayload === "string") {
		return argumentsPayload
	}

	try {
		return JSON.stringify(argumentsPayload ?? {})
	} catch {
		return "{}"
	}
}

function resolveToolUseId(call: { id?: string; call_id?: string; name?: string }, index: number): string {
	const id = call.id?.trim()
	if (id) {
		return id
	}

	const callId = call.call_id?.trim()
	if (callId) {
		return callId
	}

	const fallbackId = `subagent_tool_${Date.now()}_${index + 1}`
	Logger.warn(`[SubagentRunner] Missing tool call id for '${call.name || "unknown"}'; using fallback '${fallbackId}'`)
	return fallbackId
}

function createSubagentRunId(): string {
	return `subagent-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
}

function toAssistantToolUseBlock(call: SubagentToolCall): ClineAssistantToolUseBlock {
	return {
		type: "tool_use",
		id: call.toolUseId,
		name: call.name,
		input: call.input,
		call_id: call.call_id,
		signature: call.signature,
	}
}

function parseNonNativeToolCalls(assistantText: string): SubagentToolCall[] {
	const parsedBlocks = parseAssistantMessageV2(assistantText)

	return parsedBlocks
		.filter((block): block is ToolUse => block.type === "tool_use")
		.filter((block) => !block.partial)
		.map((block, index) => ({
			toolUseId: resolveToolUseId({ call_id: block.call_id, name: block.name }, index),
			name: block.name,
			input: block.params,
			call_id: block.call_id,
			signature: block.signature,
			isNativeToolCall: false,
		}))
}

function pushSubagentToolResultBlock(toolResultBlocks: any[], call: SubagentToolCall, label: string, content: string): void {
	if (call.isNativeToolCall) {
		toolResultBlocks.push({
			type: "tool_result",
			tool_use_id: call.toolUseId,
			call_id: call.call_id,
			content,
		})
		return
	}

	toolResultBlocks.push({
		type: "text",
		text: `${label} Result:\n${content}`,
	})
}

export class SubagentRunner {
	private readonly agent: SubagentBuilder
	private readonly apiHandler: ApiHandler
	private readonly allowedTools: ClineDefaultTool[]
	private activeApiAbort: (() => void) | undefined
	private abortRequested = false
	private activeCommandExecutions = 0
	private abortingCommands = false
	private executionContext?: SubagentExecutionContext
	private currentRunId?: string

	constructor(
		private baseConfig: TaskConfig,
		subagentName = "subagent",
	) {
		this.agent = new SubagentBuilder(baseConfig, subagentName)
		this.apiHandler = this.agent.getApiHandler()
		this.allowedTools = this.agent.getAllowedTools()
	}

	async abort(): Promise<void> {
		this.abortRequested = true

		try {
			this.activeApiAbort?.()
		} catch (error) {
			Logger.error("[SubagentRunner] failed to abort active API stream", error)
		}

		if (this.activeCommandExecutions > 0 && !this.abortingCommands && this.baseConfig.callbacks.cancelRunningCommandTool) {
			this.abortingCommands = true
			try {
				await this.baseConfig.callbacks.cancelRunningCommandTool()
			} catch (error) {
				Logger.error("[SubagentRunner] failed to cancel running command execution", error)
			} finally {
				this.abortingCommands = false
			}
		}
	}

	public async prepare(): Promise<void> {
		await this.getExecutionContext()
	}

	private shouldAbort(): boolean {
		return this.abortRequested || this.baseConfig.taskState.abort
	}

	private async getWorkspaceMetadataEnvironmentBlock(executionContext: SubagentExecutionContext): Promise<string | null> {
		try {
			if (executionContext.isolated && executionContext.worktreePath) {
				const isolatedWorkspacesJson = JSON.stringify(
					{
						workspaces: {
							[executionContext.cwd]: {
								hint: path.basename(executionContext.cwd) || executionContext.cwd,
								isolation: "worktree",
								sourceWorkspace: this.baseConfig.cwd,
								branch: executionContext.branchName,
							},
						},
					},
					null,
					2,
				)

				return `<environment_details>\n# Workspace Configuration\n${isolatedWorkspacesJson}\n</environment_details>`
			}

			const workspacesJson =
				(await this.baseConfig.workspaceManager?.buildWorkspacesJson()) ??
				JSON.stringify(
					{
						workspaces: {
							[executionContext.cwd]: {
								hint: path.basename(executionContext.cwd) || executionContext.cwd,
							},
						},
					},
					null,
					2,
				)

			return `<environment_details>\n# Workspace Configuration\n${workspacesJson}\n</environment_details>`
		} catch (error) {
			Logger.warn("[SubagentRunner] Failed to build workspace metadata block", error)
			return null
		}
	}

	private buildExecutionMetadata(executionContext?: SubagentExecutionContext): SubagentExecutionMetadata {
		return {
			runId: this.currentRunId,
			role: this.agent.getRole(),
			isolation: this.agent.getIsolationMode(),
			isolated: executionContext?.isolated ?? false,
			cwd: executionContext?.cwd ?? this.baseConfig.cwd,
			worktreePath: executionContext?.worktreePath,
			branchName: executionContext?.branchName,
		}
	}

	private extractGsdExecutionIdentity(prompt: string): { phaseNumber?: string; planId?: string } {
		const phaseMatch = prompt.match(/phase\s+([0-9]+(?:\.[0-9]+)?)/i)
		const planMatch = prompt.match(/plan\s+([0-9]+(?:-[0-9]+)?)/i)
		return {
			phaseNumber: phaseMatch?.[1],
			planId: planMatch?.[1],
		}
	}

	async run(prompt: string, onProgress: (update: SubagentProgressUpdate) => void): Promise<SubagentRunResult> {
		this.abortRequested = false
		this.currentRunId = undefined
		const state = new TaskState()
		let emptyAssistantResponseRetries = 0
		const contextState: SubagentContextState = {}
		const contextManager = new ContextManager()
		const usageState: SubagentUsageState = {
			currentRequest: createEmptyRequestUsageState(),
		}
		const stats: SubagentRunStats = {
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
			contextTokens: 0,
			contextWindow: 0,
			contextUsagePercentage: 0,
		}
		let executionContext: SubagentExecutionContext | undefined

		onProgress({ status: "running", stats, execution: this.buildExecutionMetadata() })

		try {
			executionContext = await this.getExecutionContext()
			const role = this.agent.getRole()
			if (role === "worker") {
				this.currentRunId = createSubagentRunId()
			}
			const execution = this.buildExecutionMetadata(executionContext)
			if (this.currentRunId) {
				const executionIdentity = this.extractGsdExecutionIdentity(prompt)
				await registerSubagentExecution({
					workspaceRoot: executionContext.workspaceRoot,
					runId: this.currentRunId,
					taskUlid: this.baseConfig.ulid,
					agentName: this.agent.getDisplayName(),
					phaseNumber: executionIdentity.phaseNumber,
					planId: executionIdentity.planId,
					role,
					isolation: this.agent.getIsolationMode(),
					baseWorkspaceCwd: this.baseConfig.cwd,
					executionCwd: executionContext.cwd,
					worktreePath: executionContext.worktreePath,
					branchName: executionContext.branchName,
					prompt,
				})
			}
			const mode = this.baseConfig.services.stateManager.getGlobalSettingsKey("mode")
			const apiConfiguration = this.baseConfig.services.stateManager.getApiConfiguration()
			const api = this.apiHandler
			this.activeApiAbort = api.abort?.bind(api)

			const providerId = (
				mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider
			) as string
			const providerInfo = {
				providerId,
				model: api.getModel(),
				mode,
				customPrompt: this.baseConfig.services.stateManager.getGlobalSettingsKey("customPrompt"),
			}
			stats.contextWindow = providerInfo.model.info.contextWindow || 0
			const nativeToolCallsRequested =
				providerInfo.model.info.apiFormat === ApiFormat.OPENAI_RESPONSES ||
				!!this.baseConfig.services.stateManager.getGlobalStateKey("nativeToolCallEnabled")

			const host = HostRegistryInfo.get()
			const remoteSkillEntries = this.baseConfig.services.stateManager.getRemoteConfigSettings().remoteGlobalSkills || []
			const availableSkills = await discoverAvailableSkills(executionContext.cwd, {
				remoteSkillEntries,
				globalSkillsToggles: this.baseConfig.services.stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {},
				localSkillsToggles: this.baseConfig.services.stateManager.getWorkspaceStateKey("localSkillsToggles") ?? {},
				remoteSkillsToggles: this.baseConfig.services.stateManager.getGlobalStateKey("remoteSkillsToggles") ?? {},
			})
			const configuredSkillNames = this.agent.getConfiguredSkills()
			const skills =
				configuredSkillNames !== undefined
					? configuredSkillNames
							.map((skillName) => {
								const skill = availableSkills.find((candidate) => candidate.name === skillName)
								if (!skill) {
									Logger.warn(`[SubagentRunner] Configured skill '${skillName}' not found for subagent run.`)
								}
								return skill
							})
							.filter((skill): skill is (typeof availableSkills)[number] => Boolean(skill))
					: availableSkills

			const context: SystemPromptContext = {
				providerInfo,
				cwd: executionContext.cwd,
				ide: host?.platform || "Unknown",
				skills,
				focusChainSettings: this.baseConfig.focusChainSettings,
				yoloModeToggled: false,
				enableNativeToolCalls: nativeToolCallsRequested,
				enableParallelToolCalling: false,
				isSubagentRun: true,
			}

			const promptRegistry = PromptRegistry.getInstance()
			const generatedSystemPrompt = await promptRegistry.get(context)
			const systemPrompt = this.agent.buildSystemPrompt(generatedSystemPrompt)
			const useNativeToolCalls = !!promptRegistry.nativeTools?.length
			const nativeTools = useNativeToolCalls ? this.agent.buildNativeTools(context) : undefined
			const workspaceMetadataEnvironmentBlock = await this.getWorkspaceMetadataEnvironmentBlock(executionContext)

				if (useNativeToolCalls && (!nativeTools || nativeTools.length === 0)) {
					const error = "Subagent tool requires native tool calling support."
					await this.finalizeRegisteredExecution(executionContext, "failed", error)
					onProgress({ status: "failed", error, stats, execution })
					return { status: "failed", error, stats, execution }
				}

				if (this.shouldAbort()) {
					await this.abort()
					const error = "Subagent run cancelled."
					await this.finalizeRegisteredExecution(executionContext, "failed", error)
					onProgress({ status: "failed", error, stats: { ...stats }, execution })
					return { status: "failed", error, stats, execution }
				}

			const conversation: ClineStorageMessage[] = [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: prompt,
						} as ClineTextContentBlock,
						// Server-side task loop checks require workspace metadata to be present in the
						// initial user message of subagent runs.
						...(workspaceMetadataEnvironmentBlock
							? [
									{
										type: "text",
										text: workspaceMetadataEnvironmentBlock,
									} as ClineTextContentBlock,
								]
							: []),
					],
				},
			]

			while (true) {
				if (
					usageState.lastRequest &&
					this.shouldCompactBeforeNextRequest(usageState.lastRequest.totalTokens, api, providerInfo.model.id)
				) {
					const compactResult = this.compactConversationForContextWindow(
						contextManager,
						conversation,
						contextState.conversationHistoryDeletedRange,
					)
					contextState.conversationHistoryDeletedRange = compactResult.conversationHistoryDeletedRange
					if (compactResult.didCompact) {
						Logger.warn("[SubagentRunner] Proactively compacted context before next subagent request.")
					}
					// Prevent repeated compaction attempts off the same token sample.
					usageState.lastRequest = undefined
				}

				const streamHandler = new StreamResponseHandler()
				const { toolUseHandler, reasonsHandler } = streamHandler.getHandlers()
				usageState.currentRequest = createEmptyRequestUsageState()
				const requestUsage = usageState.currentRequest

				let assistantText = ""
				let assistantTextSignature: string | undefined
				let requestId: string | undefined

				const stream = this.createMessageWithInitialChunkRetry(
					api,
					systemPrompt,
					conversation,
					nativeTools,
					providerInfo.providerId,
					providerInfo.model.id,
					contextManager,
					contextState,
				)

				for await (const chunk of stream) {
					switch (chunk.type) {
						case "usage":
							requestId = requestId ?? chunk.id
							stats.inputTokens += chunk.inputTokens || 0
							stats.outputTokens += chunk.outputTokens || 0
							stats.cacheWriteTokens += chunk.cacheWriteTokens || 0
							stats.cacheReadTokens += chunk.cacheReadTokens || 0
							requestUsage.inputTokens += chunk.inputTokens || 0
							requestUsage.outputTokens += chunk.outputTokens || 0
							requestUsage.cacheWriteTokens += chunk.cacheWriteTokens || 0
							requestUsage.cacheReadTokens += chunk.cacheReadTokens || 0
							requestUsage.totalTokens =
								requestUsage.inputTokens +
								requestUsage.outputTokens +
								requestUsage.cacheWriteTokens +
								requestUsage.cacheReadTokens
							requestUsage.totalCost = chunk.totalCost ?? requestUsage.totalCost
							stats.contextTokens = requestUsage.totalTokens
							stats.contextUsagePercentage =
								stats.contextWindow > 0 ? (stats.contextTokens / stats.contextWindow) * 100 : 0
							onProgress({ stats: { ...stats }, execution })
							break
						case "text":
							requestId = requestId ?? chunk.id
							assistantText += chunk.text || ""
							assistantTextSignature = chunk.signature || assistantTextSignature
							break
						case "tool_calls":
							requestId = requestId ?? chunk.id
							toolUseHandler.processToolUseDelta(
								{
									id: chunk.tool_call.function?.id,
									type: "tool_use",
									name: chunk.tool_call.function?.name,
									input: normalizeToolCallArguments(chunk.tool_call.function?.arguments),
									signature: chunk.signature,
								},
								chunk.tool_call.call_id,
							)
							break
						case "reasoning":
							requestId = requestId ?? chunk.id
							reasonsHandler.processReasoningDelta({
								id: chunk.id,
								reasoning: chunk.reasoning,
								signature: chunk.signature,
								details: chunk.details
									? Array.isArray(chunk.details)
										? chunk.details
										: [chunk.details]
									: [],
								redacted_data: chunk.redacted_data,
							})
							break
					}

					if (this.shouldAbort()) {
						await this.abort()
						const error = "Subagent run cancelled."
						await this.finalizeRegisteredExecution(executionContext, "failed", error)
						onProgress({ status: "failed", error, stats: { ...stats }, execution })
						return { status: "failed", error, stats, execution }
					}
				}

				const calculatedRequestCost =
					requestUsage.totalCost ??
					calculateApiCostAnthropic(
						providerInfo.model.info,
						requestUsage.inputTokens,
						requestUsage.outputTokens,
						requestUsage.cacheWriteTokens,
						requestUsage.cacheReadTokens,
					)
				requestUsage.totalTokens =
					requestUsage.inputTokens +
					requestUsage.outputTokens +
					requestUsage.cacheWriteTokens +
					requestUsage.cacheReadTokens
				stats.totalCost += calculatedRequestCost || 0
				usageState.lastRequest = { ...requestUsage }

				const nativeFinalizedToolCalls = toolUseHandler.getAllFinalizedToolUses().map((toolCall, index) => ({
					toolUseId: resolveToolUseId(toolCall, index),
					id: toolCall.id,
					call_id: toolCall.call_id,
					signature: toolCall.signature,
					name: toolCall.name,
					input: toolCall.input,
					isNativeToolCall: true,
				}))
				const parsedNonNativeToolCalls = parseNonNativeToolCalls(assistantText)
				const fallbackNonNativeToolCalls = nativeFinalizedToolCalls.map((toolCall) => ({
					...toolCall,
					isNativeToolCall: false,
				}))

				let finalizedToolCalls: SubagentToolCall[] = []
				if (useNativeToolCalls) {
					finalizedToolCalls = nativeFinalizedToolCalls
				} else if (parsedNonNativeToolCalls.length > 0) {
					finalizedToolCalls = parsedNonNativeToolCalls
				} else if (fallbackNonNativeToolCalls.length > 0) {
					// Defensive fallback: if non-native mode receives structured tool call chunks,
					// execute them but serialize results as plain text to avoid tool_result pairing mismatches.
					Logger.warn(
						"[SubagentRunner] Received structured tool_calls while native tool calling is disabled; falling back to non-native result serialization.",
					)
					finalizedToolCalls = fallbackNonNativeToolCalls
				}
				const assistantContent = [] as any[]

				// Reasoning blocks must precede their associated function_call/message in
				// the Responses API history. Mirror the main engine's ordering exactly.
				assistantContent.push(...reasonsHandler.getRedactedThinking())
				const thinkingBlock = reasonsHandler.getCurrentReasoning()
				if (thinkingBlock) {
					assistantContent.push({ ...thinkingBlock })
				}

				if (assistantText.trim().length > 0) {
					assistantContent.push({
						type: "text",
						text: assistantText,
						signature: assistantTextSignature,
					})
				}
				if (useNativeToolCalls) {
					assistantContent.push(...finalizedToolCalls.map(toAssistantToolUseBlock))
				}

				if (assistantContent.length > 0) {
					conversation.push({
						role: "assistant",
						content: assistantContent,
						id: requestId,
					})
				}

				if (finalizedToolCalls.length === 0) {
					emptyAssistantResponseRetries += 1
					if (emptyAssistantResponseRetries > MAX_EMPTY_ASSISTANT_RETRIES) {
						const error = "Subagent did not call attempt_completion."
						await this.finalizeRegisteredExecution(executionContext, "failed", error)
						onProgress({ status: "failed", error, stats: { ...stats }, execution })
						return { status: "failed", error, stats, execution }
					}

					// Mirror the main loop's no-tools-used nudge so empty/blank model turns
					// can recover without surfacing an immediate hard failure in subagent UI.
					if (assistantContent.length === 0) {
						conversation.push({
							role: "assistant",
							content: [
								{
									type: "text",
									text: "Failure: I did not provide a response.",
								},
							],
							id: requestId,
						})
					}
					conversation.push({
						role: "user",
						content: [
							{
								type: "text",
								text: formatResponse.noToolsUsed(useNativeToolCalls),
							},
						],
					})
					await delay(0)
					continue
				}
				emptyAssistantResponseRetries = 0

				const toolResultBlocks = [] as ClineUserContent[]
				for (const call of finalizedToolCalls) {
					const toolName = call.name as ClineDefaultTool
					const toolCallParams = toToolUseParams(call.input)

					if (toolName === ClineDefaultTool.ATTEMPT) {
						const completionResult = toolCallParams.result?.trim()
						if (!completionResult) {
							const missingResultError = formatResponse.missingToolParameterError("result")
							pushSubagentToolResultBlock(toolResultBlocks, call, toolName, missingResultError)
							continue
						}

						stats.toolCalls += 1
						if (this.currentRunId) {
							await updateSubagentExecutionProgress({
								workspaceRoot: executionContext.workspaceRoot,
								runId: this.currentRunId,
								latestOutput: toActivityPreview(completionResult),
							})
						}
						await this.finalizeRegisteredExecution(executionContext, "completed")
						onProgress({ stats: { ...stats }, execution })
						onProgress({ status: "completed", result: completionResult, stats: { ...stats }, execution })
						return { status: "completed", result: completionResult, stats, execution }
					}

					if (!this.allowedTools.includes(toolName)) {
						const deniedResult = formatResponse.toolError(`Tool '${toolName}' is not available inside subagent runs.`)
						pushSubagentToolResultBlock(toolResultBlocks, call, toolName, deniedResult)
						continue
					}

					const toolCallBlock: ToolUse = {
						type: "tool_use",
						name: toolName,
						params: toolCallParams,
						partial: false,
						isNativeToolCall: call.isNativeToolCall,
						call_id: call.call_id || call.toolUseId,
						signature: call.signature,
					}

					if (call.call_id) {
						state.toolUseIdMap.set(call.call_id, call.toolUseId)
					}

					const latestToolCall = formatToolCallPreview(toolName, toolCallParams)
					if (this.currentRunId) {
						await updateSubagentExecutionProgress({
							workspaceRoot: executionContext.workspaceRoot,
							runId: this.currentRunId,
							latestToolCall: toActivityPreview(latestToolCall),
						})
					}
					onProgress({ latestToolCall })

					const subagentConfig = this.createSubagentTaskConfig(state, executionContext.cwd)
					const handler = this.baseConfig.coordinator.getHandler(toolName)
					let toolResult: unknown

					if (!handler) {
						toolResult = formatResponse.toolError(`No handler registered for tool '${toolName}'.`)
					} else {
						try {
							toolResult = await handler.execute(subagentConfig, toolCallBlock)
						} catch (error) {
							toolResult = formatResponse.toolError((error as Error).message)
						}
					}

					stats.toolCalls += 1
					onProgress({ stats: { ...stats }, execution })

					const serializedToolResult = serializeToolResult(toolResult)
					if (this.currentRunId) {
						await updateSubagentExecutionProgress({
							workspaceRoot: executionContext.workspaceRoot,
							runId: this.currentRunId,
							latestOutput: toActivityPreview(serializedToolResult),
						})
					}
					const toolDescription = handler?.getDescription(toolCallBlock) || `[${toolName}]`
					pushSubagentToolResultBlock(toolResultBlocks, call, toolDescription, serializedToolResult)
				}

				conversation.push({
					role: "user",
					content: toolResultBlocks,
				})

				await delay(0)
			}
		} catch (error) {
			const execution = this.buildExecutionMetadata(executionContext)
			if (this.shouldAbort()) {
				const cancelledError = "Subagent run cancelled."
				if (executionContext) {
					await this.finalizeRegisteredExecution(executionContext, "failed", cancelledError)
				}
				onProgress({ status: "failed", error: cancelledError, stats: { ...stats }, execution })
				return { status: "failed", error: cancelledError, stats, execution }
			}

			const errorText = (error as Error).message || "Subagent execution failed."
			Logger.error("[SubagentRunner] run failed", error)
			if (executionContext) {
				await this.finalizeRegisteredExecution(executionContext, "failed", errorText)
			}
			onProgress({ status: "failed", error: errorText, stats: { ...stats }, execution })
			return { status: "failed", error: errorText, stats, execution }
		} finally {
			this.activeApiAbort = undefined
			this.currentRunId = undefined
		}
	}

	private async finalizeRegisteredExecution(
		executionContext: SubagentExecutionContext,
		status: "completed" | "failed",
		error?: string,
	): Promise<void> {
		if (!this.currentRunId) {
			return
		}
		await finalizeSubagentExecution({
			workspaceRoot: executionContext.workspaceRoot,
			runId: this.currentRunId,
			status,
			error,
		})
	}

	private createSubagentTaskConfig(state: TaskState, cwd: string): TaskConfig {
		const baseCallbacks = this.baseConfig.callbacks
		const coordinator = new ToolExecutorCoordinator()
		const validator = new ToolValidator(this.baseConfig.services.clineIgnoreController)

		for (const tool of this.allowedTools) {
			coordinator.registerByName(tool, validator)
		}

		return {
			...this.baseConfig,
			cwd,
			api: this.apiHandler,
			coordinator,
			taskState: state,
			isSubagentExecution: true,
			callbacks: {
				...baseCallbacks,
				say: async () => undefined,
				sayAndCreateMissingParamError: async (_toolName, paramName) =>
					formatResponse.toolError(formatResponse.missingToolParameterError(paramName)),
				executeCommandTool: async (command: string, timeoutSeconds: number | undefined) => {
					this.activeCommandExecutions += 1
					try {
						return await baseCallbacks.executeCommandTool(command, timeoutSeconds, {
							useBackgroundExecution: true,
							suppressUserInteraction: true,
							cwd,
						})
					} finally {
						this.activeCommandExecutions = Math.max(0, this.activeCommandExecutions - 1)
					}
				},
			},
		}
	}

	private async getExecutionContext(): Promise<SubagentExecutionContext> {
		if (this.executionContext) {
			return this.executionContext
		}

		const isolationMode = this.agent.getIsolationMode()
		if (isolationMode !== "worktree") {
			this.executionContext = {
				workspaceRoot: this.baseConfig.cwd,
				cwd: this.baseConfig.cwd,
				isolated: false,
			}
			return this.executionContext
		}

		const gitRoot = await getGitRootPath(this.baseConfig.cwd)
		if (!gitRoot) {
			throw new Error("Worktree isolation requires the workspace to be inside a git repository.")
		}

		const worktreesRoot = path.join(gitRoot, ".tasktronaut", "worktrees")
		await fs.mkdir(worktreesRoot, { recursive: true })

		const worktreeId = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
		const worktreePath = path.join(worktreesRoot, `agent-${worktreeId}`)
		const branchName = `tasktronaut/agent-${worktreeId}`
		const result = await createWorktree(gitRoot, worktreePath, {
			branch: branchName,
			baseBranch: "HEAD",
			createNewBranch: true,
		})

		if (!result.success) {
			throw new Error(result.message)
		}

		const resolvedWorktreePath = result.worktree?.path || worktreePath
		const resolvedBranchName = result.worktree?.branch || branchName
		Logger.info(`[SubagentRunner] Created isolated worktree for subagent at ${resolvedWorktreePath} (${resolvedBranchName})`)
		this.executionContext = {
			workspaceRoot: gitRoot,
			cwd: resolvedWorktreePath,
			worktreePath: resolvedWorktreePath,
			branchName: resolvedBranchName,
			isolated: true,
		}
		return this.executionContext
	}

	private shouldRetryInitialStreamError(error: unknown, providerId: string, modelId: string): boolean {
		// Mirror main loop behavior: do not auto-retry auth/balance failures.
		const parsedError = ClineError.transform(error, modelId, providerId)
		const isAuthError = parsedError.isErrorType(ClineErrorType.Auth)
		const isBalanceError = parsedError.isErrorType(ClineErrorType.Balance)

		if (isAuthError || isBalanceError) {
			return false
		}

		return true
	}

	private compactConversationForContextWindow(
		contextManager: ContextManager,
		conversation: ClineStorageMessage[],
		conversationHistoryDeletedRange: [number, number] | undefined,
	): {
		didCompact: boolean
		conversationHistoryDeletedRange: [number, number] | undefined
	} {
		const optimizationResult = this.optimizeConversationForContextWindow(contextManager, conversation)
		let didCompact = optimizationResult.didOptimize
		let updatedDeletedRange = conversationHistoryDeletedRange

		if (optimizationResult.didOptimize && !optimizationResult.needToTruncate) {
			return {
				didCompact: true,
				conversationHistoryDeletedRange: updatedDeletedRange,
			}
		}

		const deletedRange = contextManager.getNextTruncationRange(conversation, conversationHistoryDeletedRange, "quarter")
		if (deletedRange[1] < deletedRange[0]) {
			return {
				didCompact,
				conversationHistoryDeletedRange: updatedDeletedRange,
			}
		}

		if (
			conversationHistoryDeletedRange &&
			deletedRange[0] === conversationHistoryDeletedRange[0] &&
			deletedRange[1] === conversationHistoryDeletedRange[1]
		) {
			return {
				didCompact,
				conversationHistoryDeletedRange: updatedDeletedRange,
			}
		}

		updatedDeletedRange = deletedRange
		didCompact = true
		return {
			didCompact,
			conversationHistoryDeletedRange: updatedDeletedRange,
		}
	}

	private optimizeConversationForContextWindow(
		contextManager: ContextManager,
		conversation: ClineStorageMessage[],
	): {
		didOptimize: boolean
		needToTruncate: boolean
	} {
		const timestamp = Date.now()
		const optimizationResult = contextManager.attemptFileReadOptimizationInMemory(conversation, undefined, timestamp)
		if (!optimizationResult.anyContextUpdates) {
			return { didOptimize: false, needToTruncate: true }
		}

		const optimizedConversation = optimizationResult.optimizedConversationHistory.map(
			(message) => message as ClineStorageMessage,
		)
		conversation.splice(0, conversation.length, ...optimizedConversation)
		return { didOptimize: true, needToTruncate: optimizationResult.needToTruncate }
	}

	private shouldCompactBeforeNextRequest(
		requestTotalTokens: number,
		api: ReturnType<typeof buildApiHandler>,
		modelId: string,
	): boolean {
		const { contextWindow, maxAllowedSize } = getContextWindowInfo(api)
		const useAutoCondense = this.baseConfig.services.stateManager.getGlobalSettingsKey("useAutoCondense")
		if (useAutoCondense && isNextGenModelFamily(modelId)) {
			const autoCondenseThreshold = 0.75
			const roundedThreshold = autoCondenseThreshold ? Math.floor(contextWindow * autoCondenseThreshold) : maxAllowedSize
			const thresholdTokens = Math.min(roundedThreshold, maxAllowedSize)
			return requestTotalTokens >= thresholdTokens
		}

		return requestTotalTokens >= maxAllowedSize
	}

	private async *createMessageWithInitialChunkRetry(
		api: ReturnType<typeof buildApiHandler>,
		systemPrompt: string,
		fullConversation: ClineStorageMessage[],
		nativeTools: ClineTool[] | undefined,
		providerId: string,
		modelId: string,
		contextManager: ContextManager,
		contextState: SubagentContextState,
	) {
		for (let attempt = 1; attempt <= MAX_INITIAL_STREAM_ATTEMPTS; attempt += 1) {
			const truncatedConversation = contextManager
				.getTruncatedMessages(fullConversation, contextState.conversationHistoryDeletedRange)
				.map((message) => message as ClineStorageMessage)
			const stream = api.createMessage(systemPrompt, truncatedConversation, nativeTools)
			const iterator = stream[Symbol.asyncIterator]()

			try {
				const firstChunk = await iterator.next()
				if (!firstChunk.done) {
					yield firstChunk.value
				}

				yield* iterator
				return
			} catch (error) {
				if (checkContextWindowExceededError(error)) {
					const compactResult = this.compactConversationForContextWindow(
						contextManager,
						fullConversation,
						contextState.conversationHistoryDeletedRange,
					)
					contextState.conversationHistoryDeletedRange = compactResult.conversationHistoryDeletedRange
					if (!compactResult.didCompact || this.shouldAbort() || attempt >= MAX_INITIAL_STREAM_ATTEMPTS) {
						throw error
					}
					Logger.warn(
						`[SubagentRunner] Context window exceeded on initial stream attempt ${attempt}; compacted conversation and retrying.`,
					)
					continue
				}

				const shouldRetry =
					!this.shouldAbort() &&
					attempt < MAX_INITIAL_STREAM_ATTEMPTS &&
					this.shouldRetryInitialStreamError(error, providerId, modelId)
				if (!shouldRetry) {
					throw error
				}

				const delayMs = INITIAL_STREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
				Logger.warn(`[SubagentRunner] Initial stream failed. Retrying attempt ${attempt + 1}.`, error)
				await delay(delayMs)
			}
		}
	}
}
