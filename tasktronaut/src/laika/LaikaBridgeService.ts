import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { WebviewProvider } from "@core/webview"
import { getSavedClineMessages } from "@/core/storage/disk"
import * as vscode from "vscode"
import { sendAddToInputEvent } from "@/core/controller/ui/subscribeToAddToInput"
import { checkpointRestore as performCheckpointRestore } from "@/core/controller/checkpoints/checkpointRestore"
import { generateCommitMsgForPath } from "@/hosts/vscode/commit-message-generator"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo, HostRegistryInfo } from "@/registry"
import { CheckpointRestoreRequest } from "@/shared/proto/cline/checkpoints"
import { bindCardExecutionTaskHistory, listCardExecutionRecords, queueCardExecutionRequest, reconcileSubagentExecutionRegistry, recordCardExecutionDeliveryEvent, refreshCardExecutionRecordsForWorkspace, setCardExecutionLifecycleState } from "@/core/task/tools/subagent/SubagentExecutionRegistry"
import { getDistinctId } from "@/services/logging/distinctId"
import { Logger } from "@/shared/services/Logger"
import { openUrlInBrowser } from "@/utils/github-url-utils"
import { type ActorLeaseRecord, getBridgeEventCommand, parseBridgeEventLine, shouldExecuteBridgeEvent } from "./bridge-contract"
import type { AutoApprovalSettings } from "@/shared/AutoApprovalSettings"
import type { Mode } from "@/shared/storage/types"

interface ActorRegistryEntry {
	actor_id: string
	display_name: string
	ide: string
	machine: string
	workspace_root: string
	can_execute_gsd: boolean
	capabilities: string[]
	last_heartbeat_unix_ms: number
}

interface ActorRegistryFile {
	actors: ActorRegistryEntry[]
}

const BRIDGE_DIR_NAME = ".tasktronaut"
const ACTORS_FILE_NAME = "actors.json"
const IPC_FILE_NAME = "ipc.jsonl"
const LEADER_FILE_NAME = "leader.json"
const CARD_CHECKPOINTS_FILE_NAME = "card-checkpoints.json"
const HEARTBEAT_INTERVAL_MS = 30_000
const ACTOR_STALE_TTL_MS = 5 * 60_000
const POLL_INTERVAL_MS = 2_000
const PROCESSED_EVENT_CACHE_LIMIT = 500
const RECENT_UI_REQUEST_WINDOW_MS = 2_000
const execFileAsync = promisify(execFile)

interface DeliveryOutcome {
	note: string
	pullRequestNumber?: number
	pullRequestUrl?: string
	pullRequestState?: string
	pullRequestMergeStatus?: string
	pullRequestIsDraft?: boolean
}

interface GitProviderSettings {
	provider: string
	baseUrl?: string
	transport: string
	mcpServer?: string
	mcpPrStatusTool?: string
	mcpOpenPrTool?: string
	mcpCommitTool?: string
	mcpSyncTool?: string
}

interface CardExecutionCheckpointRecord {
	checkpoint_id: string
	card_key: string
	label: string
	note?: string
	created_at_unix_ms: number
	state: string
	run_id?: string
	branch_name?: string
	worktree_path?: string
	changed_files?: string[]
	diff_summary?: string
	review_note?: string
	delivery_readiness?: string
	based_on_updated_at_unix_ms?: number
	native_checkpoint_hash?: string
	native_checkpoint_message_ts?: number
}

interface CardCheckpointRegistryFile {
	checkpoints: CardExecutionCheckpointRecord[]
}

export class LaikaBridgeService implements vscode.Disposable {
	private readonly actorId: string
	private readonly displayName: string
	private readonly ide: string
	private readonly machine: string
	private heartbeatTimer?: NodeJS.Timeout
	private pollTimer?: NodeJS.Timeout
	private workspaceFolderListener?: vscode.Disposable
	private currentWorkspaceRoot?: string
	private knownEventLineCount = 0
	private readonly processedEventIds = new Set<string>()
	private readonly processedEventOrder: string[] = []
	private recentUiRequestKey?: string
	private recentUiRequestAt = 0
	private pollInFlight = false

	constructor() {
		const hostInfo = HostRegistryInfo.get()
		const distinctId = sanitizeActorToken(getDistinctId() || "local")
		this.ide = vscode.env.appName || hostInfo?.platform || hostInfo?.ide || "VS Code"
		this.machine = sanitizeActorToken(os.hostname() || "local-machine")
		this.actorId = `vscode-${distinctId.slice(0, 12) || "local"}-${process.pid}`
		this.displayName = `Tasktronaut · ${this.ide}`
	}

	public activate(context: vscode.ExtensionContext): void {
		this.workspaceFolderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void this.handleWorkspaceChange()
		})
		context.subscriptions.push(this.workspaceFolderListener, this)

		void this.handleWorkspaceChange()
		this.heartbeatTimer = setInterval(() => void this.writeHeartbeat(), HEARTBEAT_INTERVAL_MS)
		this.pollTimer = setInterval(() => void this.pollBridgeEvents(), POLL_INTERVAL_MS)
	}

	public dispose(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = undefined
		}
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = undefined
		}
		this.workspaceFolderListener?.dispose()
		this.workspaceFolderListener = undefined
		void this.removeActorFromWorkspace(this.currentWorkspaceRoot)
	}

	private async handleWorkspaceChange(): Promise<void> {
		const nextWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (nextWorkspaceRoot === this.currentWorkspaceRoot) {
			if (nextWorkspaceRoot) {
				await this.writeHeartbeat()
			}
			return
		}

		const previousWorkspaceRoot = this.currentWorkspaceRoot
		this.currentWorkspaceRoot = nextWorkspaceRoot
		this.knownEventLineCount = 0
		this.processedEventIds.clear()
		this.processedEventOrder.length = 0

		if (previousWorkspaceRoot) {
			await this.removeActorFromWorkspace(previousWorkspaceRoot)
		}
		if (nextWorkspaceRoot) {
			await this.reconcileWorkspaceExecutions(nextWorkspaceRoot)
			await this.captureCurrentBridgeTail(nextWorkspaceRoot)
			await this.writeHeartbeat()
		}
	}

	private async reconcileWorkspaceExecutions(workspaceRoot: string): Promise<void> {
		try {
			const result = await reconcileSubagentExecutionRegistry(workspaceRoot)
			if (result.reconciled > 0) {
				Logger.info(
					`[LaikaBridge] Reconciled ${result.reconciled} worker execution record(s) in ${workspaceRoot} (${result.abandoned} abandoned, ${result.cleaned} cleaned).`,
				)
			}
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to reconcile worker execution registry: ${getErrorMessage(error)}`)
		}
	}

	private async writeHeartbeat(): Promise<void> {
		const workspaceRoot = this.currentWorkspaceRoot
		if (!workspaceRoot) {
			return
		}

		try {
			const bridgeDir = await ensureBridgeDirectory(workspaceRoot)
			const actorsPath = path.join(bridgeDir, ACTORS_FILE_NAME)
			const registry = await readActorRegistry(actorsPath)
			const cutoffMs = Date.now() - ACTOR_STALE_TTL_MS
			const nextActors = registry.actors.filter(
				(actor) => actor.actor_id !== this.actorId && actor.last_heartbeat_unix_ms >= cutoffMs,
			)
			nextActors.push({
				actor_id: this.actorId,
				display_name: this.displayName,
				ide: this.ide,
				machine: this.machine,
				workspace_root: workspaceRoot,
				can_execute_gsd: true,
				capabilities: ["executor", "execute_gsd", "command_actor"],
				last_heartbeat_unix_ms: Date.now(),
			})
			await fs.writeFile(actorsPath, JSON.stringify({ actors: nextActors }, null, 2))
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to write actor heartbeat: ${getErrorMessage(error)}`)
		}
	}

	private async removeActorFromWorkspace(workspaceRoot?: string): Promise<void> {
		if (!workspaceRoot) {
			return
		}

		try {
			const actorsPath = path.join(workspaceRoot, BRIDGE_DIR_NAME, ACTORS_FILE_NAME)
			const registry = await readActorRegistry(actorsPath)
			const nextActors = registry.actors.filter((actor) => actor.actor_id !== this.actorId)
			await fs.writeFile(actorsPath, JSON.stringify({ actors: nextActors }, null, 2))
		} catch (error) {
			Logger.debug(`[LaikaBridge] Skipped actor cleanup: ${getErrorMessage(error)}`)
		}
	}

	private async captureCurrentBridgeTail(workspaceRoot: string): Promise<void> {
		const ipcPath = path.join(workspaceRoot, BRIDGE_DIR_NAME, IPC_FILE_NAME)
		try {
			const content = await fs.readFile(ipcPath, "utf8")
			this.knownEventLineCount = splitJsonLines(content).length
		} catch {
			this.knownEventLineCount = 0
		}
	}

	private async pollBridgeEvents(): Promise<void> {
		if (this.pollInFlight) {
			return
		}

		const workspaceRoot = this.currentWorkspaceRoot
		if (!workspaceRoot) {
			return
		}

		this.pollInFlight = true
		try {
			const ipcPath = path.join(workspaceRoot, BRIDGE_DIR_NAME, IPC_FILE_NAME)
			const content = await fs.readFile(ipcPath, "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") {
					return ""
				}
				throw error
			})
			const allLines = splitJsonLines(content)
			if (allLines.length < this.knownEventLineCount) {
				this.knownEventLineCount = 0
			}
			const pendingLines = allLines.slice(this.knownEventLineCount)
			this.knownEventLineCount = allLines.length

			if (pendingLines.length === 0) {
				return
			}

			const lease = await readActorLease(workspaceRoot)
			for (const line of pendingLines) {
				const event = parseBridgeEventLine(line)
				if (!event?.event_id) {
					Logger.warn(`[LaikaBridge] Ignored malformed bridge event line in ${ipcPath}`)
					continue
				}
				if (this.processedEventIds.has(event.event_id)) {
					continue
				}
				this.trackProcessedEventId(event.event_id)

				if (event.workspace_root && event.workspace_root !== workspaceRoot) {
					continue
				}
				if (!shouldExecuteBridgeEvent(event, this.actorId, lease)) {
					continue
				}
				if (!event.event) {
					continue
				}

				await this.handleExecutableBridgeEvent(workspaceRoot, event)
			}
		} catch (error) {
			Logger.warn(`[LaikaBridge] Bridge poll failed: ${getErrorMessage(error)}`)
		} finally {
			this.pollInFlight = false
		}
	}

	private async appendPromptBridgeStatus(
		workspaceRoot: string,
		event: { event_id?: string; target_actor_id?: string | null; payload?: Record<string, unknown> | null },
		status: "received" | "started" | "output" | "completed" | "failed",
		message: string,
		taskId?: string,
		command?: string,
	): Promise<void> {
		const payload = event.payload
		if (payload?.source_surface !== "laika_prompt_dock") {
			return
		}

		try {
			const bridgeDir = await ensureBridgeDirectory(workspaceRoot)
			const ipcPath = path.join(bridgeDir, IPC_FILE_NAME)
			const timestamp = Date.now()
			const record = {
				event_id: `${event.event_id || "unknown"}:${status}:${timestamp}:${Math.random().toString(16).slice(2)}`,
				event: "laika_prompt_status",
				workspace_root: workspaceRoot,
				target_actor_id: event.target_actor_id || this.actorId,
				source: "tasktronaut",
				timestamp_unix_ms: timestamp,
				payload: {
					correlation_event_id: event.event_id || null,
					status,
					message,
					task_id: taskId,
					command,
					actor_id: this.actorId,
					actor_label: this.displayName,
				},
			}
			await fs.appendFile(ipcPath, `${JSON.stringify(record)}\n`)
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to append prompt bridge status: ${getErrorMessage(error)}`)
		}
	}

	private monitorPromptDockTaskOutput(
		workspaceRoot: string,
		event: { event_id?: string; target_actor_id?: string | null; payload?: Record<string, unknown> | null },
		taskId: string | undefined,
		command: string,
	): void {
		if (!taskId || event.payload?.source_surface !== "laika_prompt_dock") {
			return
		}

		let lastSeenTs = 0
		let polls = 0
		const timer = setInterval(() => {
			void (async () => {
				polls += 1
				try {
					const messages = await getSavedClineMessages(taskId)
					const nextMessages = messages
						.filter((message) => message.ts > lastSeenTs)
						.filter((message) => message.type === "say")
						.filter((message) => message.say === "text" || message.say === "completion_result" || message.say === "error")

					for (const message of nextMessages) {
						lastSeenTs = Math.max(lastSeenTs, message.ts)
						const text = normalizePromptDockOutput(message.text)
						if (!text) {
							continue
						}
						const status = message.say === "completion_result" ? "completed" : message.say === "error" ? "failed" : "output"
						await this.appendPromptBridgeStatus(workspaceRoot, event, status, text, taskId, command)
						if (status === "completed" || status === "failed") {
							clearInterval(timer)
							return
						}
					}
				} catch (error) {
					Logger.warn(`[LaikaBridge] Failed to mirror prompt dock output: ${getErrorMessage(error)}`)
				}

				if (polls >= 90) {
					await this.appendPromptBridgeStatus(
						workspaceRoot,
						event,
						"completed",
						"Tasktronaut did not publish additional mirrored output before the watch window closed.",
						taskId,
						command,
					)
					clearInterval(timer)
				}
			})()
		}, 2_000)
	}

	private async executeBridgeCommand(
		workspaceRoot: string,
		command: string,
		eventType: string,
		eventId: string,
		event: { event_id?: string; target_actor_id?: string | null; payload?: Record<string, unknown> | null },
	): Promise<string | undefined> {
		try {
			Logger.info(`[LaikaBridge] Executing ${eventType} (${eventId}) via Tasktronaut: ${command}`)
			await this.appendPromptBridgeStatus(workspaceRoot, event, "received", "Tasktronaut received the bridged prompt.", undefined, command)
			if (event.payload?.suppress_focus !== true) {
				await HostProvider.workspace.openClineSidebarPanel({})
			}
			const webview = WebviewProvider.getInstance()
			const taskId = await webview.controller.initTask(command)
			await webview.controller.postStateToWebview()
			await this.appendPromptBridgeStatus(workspaceRoot, event, "started", "Tasktronaut started a task for the bridged prompt.", taskId, command)
			this.monitorPromptDockTaskOutput(workspaceRoot, event, taskId, command)
			return taskId
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to execute ${eventType} (${eventId}): ${getErrorMessage(error)}`)
			await this.appendPromptBridgeStatus(workspaceRoot, event, "failed", `Tasktronaut failed to start the prompt: ${getErrorMessage(error)}`, undefined, command)
			return undefined
		}
	}

	private async handleExecutableBridgeEvent(workspaceRoot: string, event: { event?: string; event_id?: string; card_id?: string; wave?: number; target_actor_id?: string | null; payload?: Record<string, unknown> | null }): Promise<void> {
		const eventType = event.event
		const eventId = event.event_id || "unknown-event"
		if (!eventType) {
			return
		}

		switch (eventType) {
			case "task_start_requested": {
				const command = getBridgeEventCommand(event)
				if (!command) {
					Logger.warn(`[LaikaBridge] Ignored ${eventType} (${eventId}) because it did not include an executable command`)
					return
				}
				await this.queueExecutionOwnership(workspaceRoot, event, command)
				const taskId = await this.executeBridgeCommand(workspaceRoot, command, eventType, eventId, event)
				await this.bindTaskHistoryForEvent(workspaceRoot, event, taskId)
				return
			}
			case "task_resume_requested": {
				const resumed = await this.resumeExecutionOwnership(workspaceRoot, eventType, eventId, event)
				if (resumed) {
					return
				}
				const command = getBridgeEventCommand(event)
				if (!command) {
					Logger.warn(`[LaikaBridge] Ignored ${eventType} (${eventId}) because it did not include an executable command`)
					return
				}
				await this.queueExecutionOwnership(workspaceRoot, event, command)
				const taskId = await this.executeBridgeCommand(workspaceRoot, command, eventType, eventId, event)
				await this.bindTaskHistoryForEvent(workspaceRoot, event, taskId)
				return
			}
			case "task_status_requested": {
				await refreshCardExecutionRecordsForWorkspace(workspaceRoot)
				Logger.info(`[LaikaBridge] Refreshed card execution registry via ${eventType} (${eventId})`)
				return
			}
			case "task_pause_requested": {
				await this.updateLifecycleState(workspaceRoot, event, "paused")
				await this.pauseActiveTask(eventType, eventId)
				return
			}
			case "task_abort_requested": {
				await this.updateLifecycleState(workspaceRoot, event, "aborted")
				await this.abortActiveTask(eventType, eventId)
				return
			}
			case "task_ready_for_review": {
				await this.updateLifecycleState(workspaceRoot, event, "ready_for_review")
				Logger.info(`[LaikaBridge] Marked card execution ready for review via ${eventType} (${eventId})`)
				return
			}
			case "task_verified": {
				await this.updateLifecycleState(workspaceRoot, event, "verified")
				Logger.info(`[LaikaBridge] Marked card execution verified via ${eventType} (${eventId})`)
				return
			}
			case "task_request_changes": {
				await this.updateLifecycleState(workspaceRoot, event, "changes_requested")
				Logger.info(`[LaikaBridge] Marked card execution as changes requested via ${eventType} (${eventId})`)
				return
			}
			case "task_add_review_note": {
				await this.updateReviewNote(workspaceRoot, event)
				Logger.info(`[LaikaBridge] Attached review note via ${eventType} (${eventId})`)
				return
			}
			case "task_add_review_comment": {
				await this.updateReviewNote(workspaceRoot, event)
				await this.routeReviewComment(workspaceRoot, eventType, eventId, event.payload, event.card_id)
				return
			}
			case "task_restore_checkpoint": {
				await this.handleCheckpointRestoreRequest(workspaceRoot, eventType, eventId, event)
				return
			}
			case "task_request_commit":
			case "task_request_sync":
			case "task_request_ship_check":
			case "task_request_pr": {
				await this.handleDeliveryRequest(workspaceRoot, eventType, eventId, event)
				return
			}
			case "focus_actor_requested": {
				await this.focusCurrentActor(eventType, eventId)
				return
			}
			case "open_path_requested": {
				await this.openRequestedPath(workspaceRoot, eventType, eventId, event.payload)
				return
			}
			case "tasktronaut_ui_requested": {
				await this.handleRemoteUiRequest(eventType, eventId, event.payload)
				return
			}
			case "tasktronaut_auto_approval_updated": {
				await this.handleRemoteAutoApprovalUpdate(eventType, eventId, event.payload)
				return
			}
			default: {
				const command = getBridgeEventCommand(event)
				if (!command) {
					Logger.warn(`[LaikaBridge] Ignored ${eventType} (${eventId}) because it did not include an executable command`)
					return
				}
				await this.queueExecutionOwnership(workspaceRoot, event, command)
				const taskId = await this.executeBridgeCommand(workspaceRoot, command, eventType, eventId, event)
				await this.bindTaskHistoryForEvent(workspaceRoot, event, taskId)
			}
		}
	}

	private async resumeExecutionOwnership(
		workspaceRoot: string,
		eventType: string,
		eventId: string,
		event: { card_id?: string; payload?: Record<string, unknown> | null },
	): Promise<boolean> {
		const payload = event.payload
		const board = payload && typeof payload.board === "string" ? payload.board : undefined
		if (!event.card_id || !board) {
			return false
		}

		const records = await listCardExecutionRecords(workspaceRoot)
		const record = records.find((item) => item.card_id === event.card_id && item.board === board)
		if (!record?.task_history_id) {
			return false
		}

		try {
			Logger.info(`[LaikaBridge] Resuming existing task ${record.task_history_id} for ${board}:${event.card_id} via ${eventType} (${eventId})`)
			await HostProvider.workspace.openClineSidebarPanel({})
			const webview = WebviewProvider.getInstance()
			await webview.controller.reinitExistingTaskFromId(record.task_history_id)
			await webview.controller.postStateToWebview()
			return true
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to resume existing task ${record.task_history_id} for ${board}:${event.card_id}: ${getErrorMessage(error)}`)
			return false
		}
	}

	private async pauseActiveTask(eventType: string, eventId: string): Promise<void> {
		try {
			Logger.info(`[LaikaBridge] Pausing active task via ${eventType} (${eventId})`)
			await HostProvider.workspace.openClineSidebarPanel({})
			const webview = WebviewProvider.getInstance()
			await webview.controller.cancelTask()
			await webview.controller.postStateToWebview()
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to pause active task for ${eventType} (${eventId}): ${getErrorMessage(error)}`)
		}
	}

	private async abortActiveTask(eventType: string, eventId: string): Promise<void> {
		try {
			Logger.info(`[LaikaBridge] Aborting active task via ${eventType} (${eventId})`)
			await HostProvider.workspace.openClineSidebarPanel({})
			const webview = WebviewProvider.getInstance()
			await webview.controller.clearTask()
			await webview.controller.postStateToWebview()
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to abort active task for ${eventType} (${eventId}): ${getErrorMessage(error)}`)
		}
	}

	private async queueExecutionOwnership(workspaceRoot: string, event: { card_id?: string; wave?: number; target_actor_id?: string | null; payload?: Record<string, unknown> | null; event_id?: string }, command: string): Promise<void> {
		const payload = event.payload
		const board = payload && typeof payload.board === "string" ? payload.board : undefined
		const sourceRef = payload && typeof payload.source_ref === "string" ? payload.source_ref : undefined
		if (!event.card_id || !board) {
			return
		}

		await queueCardExecutionRequest({
			workspaceRoot,
			cardId: event.card_id,
			board,
			actorId: event.target_actor_id || this.actorId,
			phaseNumber: typeof event.wave === "number" ? String(event.wave) : undefined,
			wave: event.wave,
			command,
			sourceRef,
			eventId: event.event_id,
		})
	}

	private async updateLifecycleState(
		workspaceRoot: string,
		event: { card_id?: string; payload?: Record<string, unknown> | null; event_id?: string },
		status: "paused" | "aborted" | "ready_for_review" | "verified" | "changes_requested",
	): Promise<void> {
		const payload = event.payload
		const board = payload && typeof payload.board === "string" ? payload.board : undefined
		const reviewNote = payload && typeof payload.review_note === "string" ? payload.review_note.trim() : undefined
		if (!event.card_id || !board) {
			return
		}
		await setCardExecutionLifecycleState({
			workspaceRoot,
			cardId: event.card_id,
			board,
			status,
			eventId: event.event_id,
			reviewNote,
		})
	}

	private async bindTaskHistoryForEvent(
		workspaceRoot: string,
		event: { card_id?: string; payload?: Record<string, unknown> | null },
		taskId?: string,
	): Promise<void> {
		const payload = event.payload
		const board = payload && typeof payload.board === "string" ? payload.board : undefined
		if (!event.card_id || !board || !taskId) {
			return
		}
		await bindCardExecutionTaskHistory({
			workspaceRoot,
			cardId: event.card_id,
			board,
			taskHistoryId: taskId,
		})
	}

	private async updateReviewNote(
		workspaceRoot: string,
		event: { card_id?: string; payload?: Record<string, unknown> | null; event_id?: string },
	): Promise<void> {
		const payload = event.payload
		const board = payload && typeof payload.board === "string" ? payload.board : undefined
		const reviewNote = payload && typeof payload.review_note === "string" ? payload.review_note.trim() : ""
		if (!event.card_id || !board || !reviewNote) {
			return
		}

		const records = await listCardExecutionRecords(workspaceRoot)
		const record = records.find((item) => item.card_id === event.card_id && item.board === board)
		if (!record) {
			return
		}

		await setCardExecutionLifecycleState({
			workspaceRoot,
			cardId: event.card_id,
			board,
			status: record.status,
			eventId: event.event_id,
			reviewNote,
			reviewEvent: "review_note",
		})
	}

	private async routeReviewComment(
		workspaceRoot: string,
		eventType: string,
		eventId: string,
		payload?: Record<string, unknown> | null,
		cardId?: string,
	): Promise<void> {
		const reviewComment = payload && typeof payload.review_note === "string" ? payload.review_note.trim() : ""
		const rawFilePath = payload && typeof payload.file_path === "string" ? payload.file_path.trim() : ""
		if (!reviewComment || !rawFilePath) {
			Logger.warn(`[LaikaBridge] Ignored ${eventType} (${eventId}) because comment text or file path was missing`)
			return
		}

		const filePath = path.isAbsolute(rawFilePath) ? rawFilePath : path.resolve(workspaceRoot, rawFilePath)
		const startLine = payload && typeof payload.start_line === "number" ? Math.max(0, payload.start_line) : 0
		const endLine = payload && typeof payload.end_line === "number" ? Math.max(startLine, payload.end_line) : startLine
		const board = payload && typeof payload.board === "string" ? payload.board : undefined

		try {
			if (cardId && board) {
				const record = (await listCardExecutionRecords(workspaceRoot)).find(
					(item) => item.card_id === cardId && item.board === board,
				)
				if (record) {
					await setCardExecutionLifecycleState({
						workspaceRoot,
						cardId,
						board,
						status: record.status,
						eventId,
						reviewNote: reviewComment,
						reviewEvent: "review_comment",
						reviewFilePath: filePath,
						reviewStartLine: startLine,
						reviewEndLine: endLine,
					})
				}
			}
			const commentController = HostProvider.get().createCommentReviewController()
			await commentController.ensureCommentsViewDisabled()
			commentController.startStreamingComment(filePath, startLine, endLine, undefined, undefined, true)
			commentController.appendToStreamingComment(reviewComment)
			commentController.endStreamingComment()

			await HostProvider.workspace.openClineSidebarPanel({})
			const chatMessage = [
				"Reviewer feedback arrived from Laika.",
				board && cardId ? `Card: ${board}:${cardId}` : undefined,
				`File: ${filePath} (lines ${startLine + 1}-${endLine + 1})`,
				"",
				reviewComment,
			]
				.filter(Boolean)
				.join("\n")
			await sendAddToInputEvent(chatMessage)

			Logger.info(`[LaikaBridge] Routed review comment for ${filePath} via ${eventType} (${eventId})`)
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to route review comment for ${eventType} (${eventId}): ${getErrorMessage(error)}`)
		}
	}

	private async handleCheckpointRestoreRequest(
		workspaceRoot: string,
		eventType: string,
		eventId: string,
		event: { card_id?: string; payload?: Record<string, unknown> | null },
	): Promise<void> {
		const payload = event.payload
		const board = payload && typeof payload.board === "string" ? payload.board : undefined
		const checkpointId =
			payload && typeof payload.checkpoint_id === "string" ? payload.checkpoint_id.trim() : ""
		if (!event.card_id || !board || !checkpointId) {
			Logger.warn(`[LaikaBridge] Ignored ${eventType} (${eventId}) because checkpoint routing metadata was missing`)
			return
		}

		const checkpoint = await this.findCheckpointRecord(workspaceRoot, board, event.card_id, checkpointId)
		const records = await listCardExecutionRecords(workspaceRoot)
		const record = records.find((item) => item.card_id === event.card_id && item.board === board)

		let reopenedTask = false
		let nativeRestoreApplied = false
		if (record?.task_history_id) {
			try {
				Logger.info(
					`[LaikaBridge] Reopening task history ${record.task_history_id} for checkpoint restore on ${board}:${event.card_id} via ${eventType} (${eventId})`,
				)
				await HostProvider.workspace.openClineSidebarPanel({})
				const webview = WebviewProvider.getInstance()
				await webview.controller.reinitExistingTaskFromId(record.task_history_id)
				await webview.controller.postStateToWebview()
				reopenedTask = true
				if (checkpoint?.native_checkpoint_message_ts) {
					await performCheckpointRestore(
						webview.controller,
						CheckpointRestoreRequest.create({
							number: checkpoint.native_checkpoint_message_ts,
							restoreType: "taskAndWorkspace",
						}),
					)
					nativeRestoreApplied = true
				}
			} catch (error) {
				Logger.warn(
					`[LaikaBridge] Failed to reopen task history ${record.task_history_id} for ${board}:${event.card_id}: ${getErrorMessage(error)}`,
				)
			}
		}

		const messageLines = [
			"Laika checkpoint restore requested.",
			`Card: ${board}:${event.card_id}`,
			checkpoint ? `Checkpoint: ${checkpoint.label}` : `Checkpoint id: ${checkpointId}`,
			checkpoint?.run_id ? `Run: ${checkpoint.run_id}` : undefined,
			checkpoint?.branch_name ? `Branch: ${checkpoint.branch_name}` : undefined,
			checkpoint?.worktree_path ? `Worktree: ${checkpoint.worktree_path}` : undefined,
			checkpoint?.delivery_readiness ? `Saved delivery state: ${checkpoint.delivery_readiness}` : undefined,
			nativeRestoreApplied
				? "Native Tasktronaut checkpoint restore was applied."
				: reopenedTask
					? "Owning task history was reopened in Tasktronaut."
					: "No bound task history was available, so only the checkpoint context could be surfaced.",
			"",
			checkpoint?.diff_summary ? `Saved summary: ${checkpoint.diff_summary}` : "No saved diff summary was captured for this checkpoint.",
			checkpoint?.note ? `Checkpoint note: ${checkpoint.note}` : undefined,
			checkpoint?.review_note ? `Review note: ${checkpoint.review_note}` : undefined,
			checkpoint?.changed_files?.length
				? `Saved files: ${checkpoint.changed_files.slice(0, 6).join(", ")}${checkpoint.changed_files.length > 6 ? ` (+${checkpoint.changed_files.length - 6} more)` : ""}`
				: undefined,
			!nativeRestoreApplied && checkpoint?.native_checkpoint_message_ts
				? "Tasktronaut-native checkpoint metadata was present, but native restore did not complete cleanly."
				: undefined,
			!checkpoint?.native_checkpoint_message_ts
				? "This checkpoint was saved before native Tasktronaut checkpoint metadata was captured, so only context restore is available."
				: undefined,
		]
			.filter(Boolean)
			.join("\n")

		await HostProvider.workspace.openClineSidebarPanel({})
		await sendAddToInputEvent(messageLines)
		Logger.info(`[LaikaBridge] Surfaced checkpoint restore request for ${board}:${event.card_id} via ${eventType} (${eventId})`)
	}

	private async findCheckpointRecord(
		workspaceRoot: string,
		board: string,
		cardId: string,
		checkpointId: string,
	): Promise<CardExecutionCheckpointRecord | undefined> {
		const registryPath = path.join(workspaceRoot, BRIDGE_DIR_NAME, "runtime", CARD_CHECKPOINTS_FILE_NAME)
		try {
			const content = await fs.readFile(registryPath, "utf8")
			const parsed = JSON.parse(content) as Partial<CardCheckpointRegistryFile>
			const checkpoints = Array.isArray(parsed.checkpoints) ? parsed.checkpoints : []
			const cardKey = `${board}:${cardId}`
			return checkpoints.find((checkpoint) => checkpoint.card_key === cardKey && checkpoint.checkpoint_id === checkpointId)
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException
			if (nodeError.code !== "ENOENT") {
				Logger.warn(`[LaikaBridge] Failed to read card checkpoints: ${getErrorMessage(error)}`)
			}
			return undefined
		}
	}

	private async focusCurrentActor(eventType: string, eventId: string): Promise<void> {
		try {
			if (this.shouldSuppressUiRequest(`focus:${this.currentWorkspaceRoot ?? "workspace"}`)) {
				Logger.info(`[LaikaBridge] Suppressed duplicate focus request via ${eventType} (${eventId})`)
				return
			}
			const activeEditor = vscode.window.activeTextEditor
			if (activeEditor) {
				await vscode.window.showTextDocument(activeEditor.document, {
					viewColumn: activeEditor.viewColumn,
					preserveFocus: false,
					preview: false,
				})
			} else {
				await HostProvider.workspace.openClineSidebarPanel({})
			}
			Logger.info(`[LaikaBridge] Focused current actor via ${eventType} (${eventId})`)
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to focus current actor for ${eventType} (${eventId}): ${getErrorMessage(error)}`)
		}
	}

	private async handleRemoteUiRequest(
		eventType: string,
		eventId: string,
		payload?: Record<string, unknown> | null,
	): Promise<void> {
		const target = payload && typeof payload.ui_target === "string" ? payload.ui_target : ""
		try {
			await HostProvider.workspace.openClineSidebarPanel({})
			const webview = WebviewProvider.getInstance()
			await webview.controller.postStateToWebview()

			switch (target) {
				case "chat_input":
					await vscode.commands.executeCommand(ExtensionRegistryInfo.commands.FocusChatInput, false)
					break
				case "new_chat":
					await vscode.commands.executeCommand(ExtensionRegistryInfo.commands.PlusButton)
					break
				case "history":
					await vscode.commands.executeCommand(ExtensionRegistryInfo.commands.HistoryButton)
					break
				case "settings":
					await vscode.commands.executeCommand(ExtensionRegistryInfo.commands.SettingsButton)
					break
				case "mcp":
					await vscode.commands.executeCommand(ExtensionRegistryInfo.commands.McpButton)
					break
				case "worktrees":
					await vscode.commands.executeCommand(ExtensionRegistryInfo.commands.WorktreesButton)
					break
				case "gsd":
					await vscode.commands.executeCommand(ExtensionRegistryInfo.commands.GsdButton)
					break
				case "mode": {
					const requestedMode = payload && payload.mode === "plan" ? "plan" : "act"
					await webview.controller.togglePlanActMode(requestedMode as Mode)
					break
				}
				default:
					Logger.warn(`[LaikaBridge] Ignored ${eventType} (${eventId}) because ui_target '${target}' is not supported`)
					return
			}

			Logger.info(`[LaikaBridge] Routed remote Tasktronaut UI target '${target}' via ${eventType} (${eventId})`)
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to route remote Tasktronaut UI request for ${eventType} (${eventId}): ${getErrorMessage(error)}`)
		}
	}

	private async handleRemoteAutoApprovalUpdate(
		eventType: string,
		eventId: string,
		payload?: Record<string, unknown> | null,
	): Promise<void> {
		const incomingActions = payload && typeof payload.actions === "object" && payload.actions !== null
			? payload.actions as Record<string, unknown>
			: undefined
		if (!incomingActions) {
			Logger.warn(`[LaikaBridge] Ignored ${eventType} (${eventId}) because auto-approval actions were missing`)
			return
		}

		try {
			await HostProvider.workspace.openClineSidebarPanel({})
			const webview = WebviewProvider.getInstance()
			const currentSettings = (await webview.controller.getStateToPostToWebview()).autoApprovalSettings
			const currentActions = currentSettings?.actions ?? {}
			const nextSettings: AutoApprovalSettings = {
				...(currentSettings as AutoApprovalSettings),
				version: (currentSettings?.version ?? 1) + 1,
				enabled: currentSettings?.enabled ?? true,
				favorites: currentSettings?.favorites ?? [],
				maxRequests: currentSettings?.maxRequests ?? 20,
				enableNotifications: currentSettings?.enableNotifications ?? false,
				actions: {
					...currentActions,
					...coerceAutoApprovalActions(incomingActions),
				},
			}
			webview.controller.stateManager.setGlobalState("autoApprovalSettings", nextSettings)
			await webview.controller.postStateToWebview()
			await vscode.commands.executeCommand(ExtensionRegistryInfo.commands.SettingsButton)
			Logger.info(`[LaikaBridge] Updated auto-approval settings from Laika via ${eventType} (${eventId})`)
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to update auto-approval settings for ${eventType} (${eventId}): ${getErrorMessage(error)}`)
		}
	}

	private async openRequestedPath(
		workspaceRoot: string,
		eventType: string,
		eventId: string,
		payload?: Record<string, unknown> | null,
	): Promise<void> {
		const requestedPath = payload && typeof payload.path === "string" ? payload.path.trim() : ""
		if (!requestedPath) {
			Logger.warn(`[LaikaBridge] Ignored ${eventType} (${eventId}) because it did not include a path`)
			return
		}

		try {
			const resolvedPath = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(workspaceRoot, requestedPath)
			const line = payload && typeof payload.line === "number" ? Math.max(0, payload.line - 1) : 0
			const column = payload && typeof payload.column === "number" ? Math.max(0, payload.column - 1) : 0
			if (this.shouldSuppressUiRequest(`open:${resolvedPath}:${line}:${column}`)) {
				Logger.info(`[LaikaBridge] Suppressed duplicate open request for ${resolvedPath} via ${eventType} (${eventId})`)
				return
			}
			const stat = await fs.stat(resolvedPath)
			if (stat.isDirectory()) {
				const result = await HostProvider.workspace.openFolder({
					path: resolvedPath,
					newWindow: false,
				})
				if (!result.success) {
					Logger.warn(`[LaikaBridge] Failed to open directory ${resolvedPath} for ${eventType} (${eventId})`)
				}
				return
			}

			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath))
			const activeEditor = vscode.window.activeTextEditor
			const alreadyActive =
				activeEditor?.document.uri.fsPath === resolvedPath &&
				activeEditor.selection.active.line === line &&
				activeEditor.selection.active.character === column
			if (alreadyActive) {
				Logger.info(`[LaikaBridge] Skipped reopen for ${resolvedPath} via ${eventType} (${eventId}) because it is already focused`)
				return
			}
			const editor = await vscode.window.showTextDocument(document, {
				preview: false,
				preserveFocus: false,
			})
			const position = new vscode.Position(line, column)
			editor.selection = new vscode.Selection(position, position)
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
			Logger.info(`[LaikaBridge] Opened ${resolvedPath} via ${eventType} (${eventId})`)
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to open requested path for ${eventType} (${eventId}): ${getErrorMessage(error)}`)
		}
	}

	private shouldSuppressUiRequest(key: string): boolean {
		const now = Date.now()
		if (this.recentUiRequestKey === key && now - this.recentUiRequestAt < RECENT_UI_REQUEST_WINDOW_MS) {
			return true
		}
		this.recentUiRequestKey = key
		this.recentUiRequestAt = now
		return false
	}

	private async handleDeliveryRequest(
		workspaceRoot: string,
		eventType: "task_request_commit" | "task_request_sync" | "task_request_ship_check" | "task_request_pr" | string,
		eventId: string,
		event: { card_id?: string; payload?: Record<string, unknown> | null; event_id?: string },
	): Promise<void> {
		const payload = event.payload
		const board = payload && typeof payload.board === "string" ? payload.board : undefined
		const branchName = payload && typeof payload.branch_name === "string" ? payload.branch_name : undefined
		const worktreePath = payload && typeof payload.worktree_path === "string" ? payload.worktree_path : undefined
		const deliveryReadiness = payload && typeof payload.delivery_readiness === "string" ? payload.delivery_readiness : undefined
		const gitProviderSettings = await this.loadGitProviderSettings(workspaceRoot)

		if (!event.card_id || !board) {
			Logger.warn(`[LaikaBridge] Ignored ${eventType} (${eventId}) because card routing metadata was missing`)
			return
		}

		let outcome: DeliveryOutcome = { note: "" }
		try {
			if (eventType === "task_request_commit") {
				outcome = (await this.handleCommitRequest(worktreePath, branchName, gitProviderSettings)) as DeliveryOutcome
			} else if (eventType === "task_request_sync") {
				outcome = (await this.handleSyncRequest(worktreePath, branchName, gitProviderSettings)) as DeliveryOutcome
			} else if (eventType === "task_request_pr") {
				outcome = (await this.handlePullRequestRequest(worktreePath, branchName, gitProviderSettings)) as DeliveryOutcome
			} else {
				outcome = (await this.handleShipCheckRequest(worktreePath, branchName, gitProviderSettings)) as DeliveryOutcome
			}
		} catch (error) {
			outcome = { note: `Delivery request failed: ${getErrorMessage(error)}` }
			Logger.warn(`[LaikaBridge] ${eventType} (${eventId}) failed: ${getErrorMessage(error)}`)
		}

		const messageLines = [
			`Laika delivery request: ${eventType.replaceAll("_", " ")}`,
			board && event.card_id ? `Card: ${board}:${event.card_id}` : undefined,
			branchName ? `Branch: ${branchName}` : undefined,
			worktreePath ? `Worktree: ${worktreePath}` : undefined,
			deliveryReadiness ? `Readiness: ${deliveryReadiness}` : undefined,
			"",
			outcome.note,
		]
			.filter(Boolean)
			.join("\n")

		await HostProvider.workspace.openClineSidebarPanel({})
		await sendAddToInputEvent(messageLines)

		await recordCardExecutionDeliveryEvent({
			workspaceRoot,
			cardId: event.card_id,
			board,
			eventId: event.event_id,
			deliveryEvent:
				eventType === "task_request_commit"
					? "commit_requested"
					: eventType === "task_request_sync"
						? "sync_requested"
						: eventType === "task_request_pr"
							? "pr_requested"
						: "ship_check_requested",
			deliveryNote: outcome.note,
			branchName,
			worktreePath,
			deliveryReadiness,
			pullRequestNumber: outcome.pullRequestNumber,
			pullRequestUrl: outcome.pullRequestUrl,
			pullRequestState: outcome.pullRequestState,
			pullRequestMergeStatus: outcome.pullRequestMergeStatus,
			pullRequestIsDraft: outcome.pullRequestIsDraft,
		})

		Logger.info(`[LaikaBridge] Handled delivery request ${eventType} (${eventId}) for ${board}:${event.card_id}`)
	}

	private async handleCommitRequest(
		worktreePath?: string,
		branchName?: string,
		gitProviderSettings: GitProviderSettings = defaultGitProviderSettings(),
	): Promise<DeliveryOutcome> {
		if (!worktreePath) {
			return { note: "Commit request received, but the execution does not have a recorded worktree yet." }
		}

		const resolvedPath = path.resolve(worktreePath)
		await vscode.commands.executeCommand("workbench.view.scm")
		const webview = WebviewProvider.getInstance()
		const generated = await generateCommitMsgForPath(webview.controller, resolvedPath)
		const repository = await this.getGitRepositoryForPath(resolvedPath)
		if (!repository) {
			return { note: `Commit request received for ${branchName ?? "the active branch"}, but no matching Source Control repository was found for ${resolvedPath}.` }
		}

		const hasStagedChanges = await this.hasStagedChanges(resolvedPath)
		if (!hasStagedChanges) {
			return { note: `Commit request prepared for ${branchName ?? "the active branch"}, but there are no staged changes to commit yet.` }
		}

		const commitMessage = String(repository.inputBox?.value ?? "").trim()
		if (!commitMessage) {
			return {
				note: generated
					? `Prepared Source Control for ${branchName ?? "the active branch"}, but no commit message is currently available to confirm.`
					: `Commit request opened Source Control for ${branchName ?? "the active branch"}, but no commit message is currently available to confirm.`,
			}
		}

		if (gitProviderSettings.transport === "mcp") {
			return await this.handleProviderMcpCommit(resolvedPath, branchName, commitMessage, gitProviderSettings)
		}

		const confirmation = await vscode.window.showWarningMessage(
			`Commit staged changes for ${branchName ?? "this branch"}?`,
			{ modal: true, detail: commitMessage },
			"Commit staged changes",
			"Cancel",
		)
		if (confirmation !== "Commit staged changes") {
			return { note: `Commit request for ${branchName ?? "the active branch"} was prepared, but the human confirmation was cancelled.` }
		}

		await execFileAsync("git", ["commit", "-m", commitMessage], { cwd: resolvedPath })
		return { note: `Committed staged changes on ${branchName ?? "the active branch"} after human confirmation.` }
	}

	private async handleSyncRequest(
		worktreePath?: string,
		branchName?: string,
		gitProviderSettings: GitProviderSettings = defaultGitProviderSettings(),
	): Promise<DeliveryOutcome> {
		if (!worktreePath) {
			return { note: "Sync request received, but the execution does not have a recorded worktree yet." }
		}

		const resolvedPath = path.resolve(worktreePath)
		const delivery = await this.inspectDeliveryState(resolvedPath)
		await vscode.commands.executeCommand("workbench.view.scm")
		if (delivery.conflicted > 0 || delivery.unstaged > 0 || delivery.untracked > 0 || delivery.staged > 0) {
			return { note: `Sync requested for ${branchName ?? "the active branch"}, but the worktree is not clean enough to automate. ${delivery.summary}` }
		}
		if (gitProviderSettings.transport === "mcp") {
			return await this.handleProviderMcpSync(resolvedPath, branchName, delivery, gitProviderSettings)
		}
		if (delivery.ahead > 0 && delivery.behind === 0) {
			const confirmation = await vscode.window.showWarningMessage(
				`Push ${branchName ?? "this branch"} to its upstream?`,
				{ modal: true, detail: delivery.summary },
				"Push branch",
				"Cancel",
			)
			if (confirmation !== "Push branch") {
				return { note: `Push request for ${branchName ?? "the active branch"} was cancelled before running. ${delivery.summary}` }
			}
			await execFileAsync("git", ["push"], { cwd: resolvedPath })
			const refreshed = await this.inspectDeliveryStatus(resolvedPath)
			return { note: `Pushed ${branchName ?? "the active branch"} after human confirmation. ${refreshed}` }
		}
		if (delivery.behind > 0 && delivery.ahead === 0) {
			const confirmation = await vscode.window.showWarningMessage(
				`Pull --rebase for ${branchName ?? "this branch"} from upstream?`,
				{ modal: true, detail: delivery.summary },
				"Pull with rebase",
				"Cancel",
			)
			if (confirmation !== "Pull with rebase") {
				return { note: `Sync request for ${branchName ?? "the active branch"} was cancelled before pulling. ${delivery.summary}` }
			}
			await execFileAsync("git", ["pull", "--rebase"], { cwd: resolvedPath })
			const refreshed = await this.inspectDeliveryStatus(resolvedPath)
			return { note: `Pulled latest upstream changes into ${branchName ?? "the active branch"} after human confirmation. ${refreshed}` }
		}
		return { note: `Sync requested for ${branchName ?? "the active branch"}, but manual follow-through is still safer here. ${delivery.summary}` }
	}

	private async handleShipCheckRequest(
		worktreePath?: string,
		branchName?: string,
		gitProviderSettings: GitProviderSettings = defaultGitProviderSettings(),
	): Promise<DeliveryOutcome> {
		if (!worktreePath) {
			return { note: "Ship check requested, but the execution does not have a recorded worktree yet." }
		}
		const resolvedPath = path.resolve(worktreePath)
		const summary = await this.inspectDeliveryStatus(resolvedPath)
		if (gitProviderSettings.transport === "mcp") {
			const mcpOutcome = await this.handleProviderMcpShipCheck(resolvedPath, branchName, gitProviderSettings)
			return {
				...mcpOutcome,
				note: `Ship check for ${branchName ?? "the active branch"}: ${summary}${
					mcpOutcome.note ? ` · ${mcpOutcome.note}` : ""
				}`,
			}
		}
		const pr =
			gitProviderSettings.provider === "github" && gitProviderSettings.transport !== "mcp"
				? await this.inspectPullRequestState(resolvedPath, branchName)
				: undefined
		const providerDetail =
			gitProviderSettings.transport === "mcp" && gitProviderSettings.mcpServer
				? ` · provider ${gitProviderLabel(gitProviderSettings)} is configured for MCP server ${gitProviderSettings.mcpServer}`
				: gitProviderSettings.provider !== "github"
					? ` · provider ${gitProviderLabel(gitProviderSettings)}`
					: ""
		return {
			note: `Ship check for ${branchName ?? "the active branch"}: ${summary}${pr ? ` · ${formatPullRequestSummary(pr)}` : ""}${providerDetail}`,
			pullRequestNumber: pr?.number,
			pullRequestUrl: pr?.url,
			pullRequestState: pr?.state,
			pullRequestMergeStatus: pr?.mergeStateStatus,
			pullRequestIsDraft: pr?.isDraft,
		}
	}

	private async handlePullRequestRequest(
		worktreePath?: string,
		branchName?: string,
		gitProviderSettings: GitProviderSettings = defaultGitProviderSettings(),
	): Promise<DeliveryOutcome> {
		if (!worktreePath) {
			return { note: "PR request received, but the execution does not have a recorded worktree yet." }
		}

		const resolvedPath = path.resolve(worktreePath)
		const branch = branchName || (await this.currentBranchName(resolvedPath))
		if (!branch) {
			return { note: "PR request received, but the branch name could not be determined." }
		}

		if (gitProviderSettings.transport === "mcp") {
			return await this.handleProviderMcpPullRequest(resolvedPath, branch, gitProviderSettings)
		}

		const existingPr =
			gitProviderSettings.provider === "github" && gitProviderSettings.transport !== "mcp"
				? await this.inspectPullRequestState(resolvedPath, branch)
				: undefined
		if (existingPr?.url) {
			const confirmation = await vscode.window.showInformationMessage(
				`An existing pull request was found for ${branch}. Open it in the browser?`,
				{ modal: true, detail: existingPr.url },
				"Open pull request",
				"Cancel",
			)
			if (confirmation !== "Open pull request") {
				return {
					note: `PR request for ${branch} was cancelled before opening the existing pull request.`,
					pullRequestNumber: existingPr.number,
					pullRequestUrl: existingPr.url,
					pullRequestState: existingPr.state,
					pullRequestMergeStatus: existingPr.mergeStateStatus,
					pullRequestIsDraft: existingPr.isDraft,
				}
			}
			await openUrlInBrowser(existingPr.url)
			return {
				note: `Opened the existing pull request for ${branch} after human confirmation.`,
				pullRequestNumber: existingPr.number,
				pullRequestUrl: existingPr.url,
				pullRequestState: existingPr.state,
				pullRequestMergeStatus: existingPr.mergeStateStatus,
				pullRequestIsDraft: existingPr.isDraft,
			}
		}

		const compareUrl = await this.buildCompareUrl(resolvedPath, branch, gitProviderSettings)
		if (!compareUrl) {
			const mcpHint =
				gitProviderSettings.transport === "mcp" && gitProviderSettings.mcpServer
					? ` The workspace is configured for MCP server ${gitProviderSettings.mcpServer}, but provider-backed PR creation is not wired yet.`
					: ""
			return {
				note: `PR request received for ${branch}, but a ${gitProviderLabel(gitProviderSettings)} pull request URL could not be prepared for this repository.${mcpHint}`,
			}
		}

		const confirmation = await vscode.window.showInformationMessage(
			`Open a ${gitProviderLabel(gitProviderSettings)} pull request page for ${branch}?`,
			{ modal: true, detail: compareUrl },
			"Open pull request page",
			"Cancel",
		)
		if (confirmation !== "Open pull request page") {
			return { note: `PR request for ${branch} was cancelled before opening the compare page.` }
		}
		await openUrlInBrowser(compareUrl)
		const transportDetail =
			gitProviderSettings.transport === "mcp" && gitProviderSettings.mcpServer
				? ` The workspace is configured for MCP server ${gitProviderSettings.mcpServer}, so this used the provider web fallback until MCP PR actions are connected.`
				: ""
		return {
			note: `Opened the ${gitProviderLabel(gitProviderSettings)} pull request page for ${branch} after human confirmation.${transportDetail}`,
			pullRequestUrl: compareUrl,
		}
	}

	private async loadGitProviderSettings(workspaceRoot: string): Promise<GitProviderSettings> {
		const defaults = defaultGitProviderSettings()
		try {
			const configPath = path.join(workspaceRoot, ".planning", "config.json")
			const configRaw = await fs.readFile(configPath, "utf8")
			const parsed = JSON.parse(configRaw) as { git?: Record<string, unknown> }
			const git = parsed.git
			if (!git || typeof git !== "object") {
				return defaults
			}
			return {
				provider: typeof git.provider === "string" && git.provider.trim() ? git.provider.trim() : defaults.provider,
				baseUrl:
					typeof git.provider_base_url === "string" && git.provider_base_url.trim()
						? git.provider_base_url.trim()
						: undefined,
				transport:
					typeof git.provider_transport === "string" && git.provider_transport.trim()
						? git.provider_transport.trim()
						: defaults.transport,
				mcpServer:
					typeof git.provider_mcp_server === "string" && git.provider_mcp_server.trim()
						? git.provider_mcp_server.trim()
						: undefined,
				mcpPrStatusTool:
					typeof git.provider_mcp_pr_status_tool === "string" && git.provider_mcp_pr_status_tool.trim()
						? git.provider_mcp_pr_status_tool.trim()
						: undefined,
				mcpOpenPrTool:
					typeof git.provider_mcp_open_pr_tool === "string" && git.provider_mcp_open_pr_tool.trim()
						? git.provider_mcp_open_pr_tool.trim()
						: undefined,
				mcpCommitTool:
					typeof git.provider_mcp_commit_tool === "string" && git.provider_mcp_commit_tool.trim()
						? git.provider_mcp_commit_tool.trim()
						: undefined,
				mcpSyncTool:
					typeof git.provider_mcp_sync_tool === "string" && git.provider_mcp_sync_tool.trim()
						? git.provider_mcp_sync_tool.trim()
						: undefined,
			}
		} catch {
			return defaults
		}
	}

	private async handleProviderMcpShipCheck(
		worktreePath: string,
		branchName: string | undefined,
		gitProviderSettings: GitProviderSettings,
	): Promise<DeliveryOutcome> {
		if (!gitProviderSettings.mcpServer) {
			return {
				note: `provider ${gitProviderLabel(gitProviderSettings)} is configured for MCP transport, but no MCP server is selected.`,
			}
		}
		if (!gitProviderSettings.mcpPrStatusTool) {
			return {
				note: `provider ${gitProviderLabel(gitProviderSettings)} is configured for MCP server ${gitProviderSettings.mcpServer}, but no PR status tool is configured yet.`,
			}
		}
		return await this.callGitProviderMcpTool(
			worktreePath,
			branchName,
			gitProviderSettings,
			gitProviderSettings.mcpPrStatusTool,
			"status",
		)
	}

	private async handleProviderMcpPullRequest(
		worktreePath: string,
		branchName: string,
		gitProviderSettings: GitProviderSettings,
	): Promise<DeliveryOutcome> {
		if (!gitProviderSettings.mcpServer) {
			return {
				note: `PR request received for ${branchName}, but provider ${gitProviderLabel(gitProviderSettings)} is configured for MCP transport without an MCP server.`,
			}
		}
		if (!gitProviderSettings.mcpOpenPrTool) {
			return {
				note: `PR request received for ${branchName}, but provider ${gitProviderLabel(gitProviderSettings)} is configured for MCP server ${gitProviderSettings.mcpServer} without a PR action tool.`,
			}
		}

		const confirmation = await vscode.window.showInformationMessage(
			`Run ${gitProviderSettings.mcpOpenPrTool} on MCP server ${gitProviderSettings.mcpServer} for ${branchName}?`,
			{
				modal: true,
				detail: `Provider: ${gitProviderLabel(gitProviderSettings)} · Transport: MCP`,
			},
			"Run MCP PR action",
			"Cancel",
		)
		if (confirmation !== "Run MCP PR action") {
			return { note: `PR request for ${branchName} was cancelled before the MCP provider action ran.` }
		}

		const outcome = await this.callGitProviderMcpTool(
			worktreePath,
			branchName,
			gitProviderSettings,
			gitProviderSettings.mcpOpenPrTool,
			"action",
		)
		if (outcome.pullRequestUrl) {
			await openUrlInBrowser(outcome.pullRequestUrl)
			return {
				...outcome,
				note: `${outcome.note} Opened the returned pull request URL after human confirmation.`,
			}
		}
		return outcome
	}

	private async handleProviderMcpCommit(
		worktreePath: string,
		branchName: string | undefined,
		commitMessage: string,
		gitProviderSettings: GitProviderSettings,
	): Promise<DeliveryOutcome> {
		if (!gitProviderSettings.mcpServer) {
			return {
				note: `Commit request received for ${branchName ?? "the active branch"}, but provider ${gitProviderLabel(gitProviderSettings)} is configured for MCP transport without an MCP server.`,
			}
		}
		if (!gitProviderSettings.mcpCommitTool) {
			return {
				note: `Commit request received for ${branchName ?? "the active branch"}, but provider ${gitProviderLabel(gitProviderSettings)} is configured for MCP server ${gitProviderSettings.mcpServer} without a commit tool.`,
			}
		}

		const confirmation = await vscode.window.showWarningMessage(
			`Run ${gitProviderSettings.mcpCommitTool} on MCP server ${gitProviderSettings.mcpServer} for ${branchName ?? "this branch"}?`,
			{
				modal: true,
				detail: commitMessage,
			},
			"Run MCP commit action",
			"Cancel",
		)
		if (confirmation !== "Run MCP commit action") {
			return { note: `Commit request for ${branchName ?? "the active branch"} was cancelled before the MCP provider action ran.` }
		}

		return await this.callGitProviderMcpTool(
			worktreePath,
			branchName,
			gitProviderSettings,
			gitProviderSettings.mcpCommitTool,
			"commit",
			{
				commit_message: commitMessage,
			},
		)
	}

	private async handleProviderMcpSync(
		worktreePath: string,
		branchName: string | undefined,
		delivery: {
			summary: string
			ahead: number
			behind: number
			staged: number
			unstaged: number
			untracked: number
			conflicted: number
		},
		gitProviderSettings: GitProviderSettings,
	): Promise<DeliveryOutcome> {
		if (!gitProviderSettings.mcpServer) {
			return {
				note: `Sync request received for ${branchName ?? "the active branch"}, but provider ${gitProviderLabel(gitProviderSettings)} is configured for MCP transport without an MCP server.`,
			}
		}
		if (!gitProviderSettings.mcpSyncTool) {
			return {
				note: `Sync request received for ${branchName ?? "the active branch"}, but provider ${gitProviderLabel(gitProviderSettings)} is configured for MCP server ${gitProviderSettings.mcpServer} without a sync tool.`,
			}
		}

		const syncAction =
			delivery.ahead > 0 && delivery.behind === 0
				? "push"
				: delivery.behind > 0 && delivery.ahead === 0
					? "pull_rebase"
					: "sync"
		const confirmation = await vscode.window.showWarningMessage(
			`Run ${gitProviderSettings.mcpSyncTool} on MCP server ${gitProviderSettings.mcpServer} for ${branchName ?? "this branch"}?`,
			{
				modal: true,
				detail: `${delivery.summary} · action: ${syncAction}`,
			},
			"Run MCP sync action",
			"Cancel",
		)
		if (confirmation !== "Run MCP sync action") {
			return { note: `Sync request for ${branchName ?? "the active branch"} was cancelled before the MCP provider action ran. ${delivery.summary}` }
		}

		return await this.callGitProviderMcpTool(
			worktreePath,
			branchName,
			gitProviderSettings,
			gitProviderSettings.mcpSyncTool,
			"sync",
			{
				sync_action: syncAction,
				delivery_summary: delivery.summary,
				ahead_count: delivery.ahead,
				behind_count: delivery.behind,
			},
		)
	}

	private async callGitProviderMcpTool(
		worktreePath: string,
		branchName: string | undefined,
		gitProviderSettings: GitProviderSettings,
		toolName: string,
		actionKind: "status" | "action" | "commit" | "sync",
		extraArguments?: Record<string, unknown>,
	): Promise<DeliveryOutcome> {
		const controller = WebviewProvider.getInstance().controller
		const mcpHub = controller?.mcpHub
		if (!mcpHub || !gitProviderSettings.mcpServer) {
			return { note: `MCP tool ${toolName} could not run because the MCP runtime is unavailable.` }
		}

		const baseBranch = (await this.defaultRemoteBranch(worktreePath)) || "main"
		const remoteUrl = await this.originRemoteUrl(worktreePath)
		const repositoryUrl = remoteUrl ? normalizeRemoteRepoUrl(remoteUrl, gitProviderSettings.baseUrl) : undefined
		const toolArguments = {
			provider: gitProviderSettings.provider,
			provider_base_url: gitProviderSettings.baseUrl,
			remote_url: remoteUrl,
			repository_url: repositoryUrl,
			branch_name: branchName,
			base_branch: baseBranch,
			worktree_path: worktreePath,
			...extraArguments,
		}

		try {
			const result = await mcpHub.callTool(
				gitProviderSettings.mcpServer,
				toolName,
				pruneUndefinedFields(toolArguments),
				`laika-${Date.now()}`,
			)
			if (result.isError) {
				return {
					note: `MCP ${actionKind} tool ${toolName} on ${gitProviderSettings.mcpServer} reported an error: ${extractMcpToolText(result) || "no error detail returned"}`,
				}
			}
			const parsed = parseGitProviderMcpResult(result)
			return {
				note:
					parsed.note ||
					`Ran MCP ${actionKind} tool ${toolName} on ${gitProviderSettings.mcpServer} for ${branchName ?? "the active branch"}.`,
				pullRequestNumber: parsed.pullRequestNumber,
				pullRequestUrl: parsed.pullRequestUrl,
				pullRequestState: parsed.pullRequestState,
				pullRequestMergeStatus: parsed.pullRequestMergeStatus,
				pullRequestIsDraft: parsed.pullRequestIsDraft,
			}
		} catch (error) {
			return {
				note: `MCP ${actionKind} tool ${toolName} on ${gitProviderSettings.mcpServer} failed: ${getErrorMessage(error)}`,
			}
		}
	}

	private async getGitRepositoryForPath(repoPath: string): Promise<any | undefined> {
		const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports
		if (!gitExtension) {
			return undefined
		}
		const git = gitExtension.getAPI(1)
		const normalizedRepoPath = path.resolve(repoPath)
		return (
			git.repositories.find((candidate: any) => path.resolve(candidate.rootUri.fsPath) === normalizedRepoPath) ||
			git.repositories.find((candidate: any) => normalizedRepoPath.startsWith(path.resolve(candidate.rootUri.fsPath)))
		)
	}

	private async currentBranchName(worktreePath: string): Promise<string | undefined> {
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath })
			const branch = stdout.trim()
			return branch.length > 0 ? branch : undefined
		} catch {
			return undefined
		}
	}

	private async inspectPullRequestState(
		worktreePath: string,
		branchName?: string,
	): Promise<
		| {
				number?: number
				url?: string
				state?: string
				isDraft?: boolean
				mergeStateStatus?: string
		  }
		| undefined
	> {
		const branch = branchName || (await this.currentBranchName(worktreePath))
		if (!branch) {
			return undefined
		}
		try {
			const { stdout } = await execFileAsync(
				"gh",
				[
					"pr",
					"list",
					"--head",
					branch,
					"--state",
					"all",
					"--json",
					"number,url,state,isDraft,mergeStateStatus",
					"--limit",
					"1",
				],
				{ cwd: worktreePath },
			)
			const parsed = JSON.parse(stdout) as Array<{
				number?: number
				url?: string
				state?: string
				isDraft?: boolean
				mergeStateStatus?: string
			}>
			return parsed[0]
		} catch {
			return undefined
		}
	}

	private async hasStagedChanges(worktreePath: string): Promise<boolean> {
		try {
			await execFileAsync("git", ["diff", "--cached", "--quiet"], { cwd: worktreePath })
			return false
		} catch {
			return true
		}
	}

	private async findExistingPullRequestUrl(worktreePath: string, branchName: string): Promise<string | undefined> {
		return (await this.inspectPullRequestState(worktreePath, branchName))?.url
	}

	private async buildCompareUrl(
		worktreePath: string,
		branchName: string,
		gitProviderSettings: GitProviderSettings = defaultGitProviderSettings(),
	): Promise<string | undefined> {
		const remoteUrl = await this.originRemoteUrl(worktreePath)
		const repoHttpUrl = remoteUrl ? normalizeRemoteRepoUrl(remoteUrl, gitProviderSettings.baseUrl) : undefined
		if (!repoHttpUrl) {
			return undefined
		}
		const baseBranch = (await this.defaultRemoteBranch(worktreePath)) || "main"
		switch (gitProviderSettings.provider) {
			case "gitlab":
				return `${repoHttpUrl}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branchName)}&merge_request[target_branch]=${encodeURIComponent(baseBranch)}`
			case "bitbucket":
				return `${repoHttpUrl}/pull-requests/new?source=${encodeURIComponent(branchName)}&dest=${encodeURIComponent(baseBranch)}`
			case "github":
			case "gitea":
			case "custom":
			default:
				return `${repoHttpUrl}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branchName)}?expand=1`
		}
	}

	private async originRemoteUrl(worktreePath: string): Promise<string | undefined> {
		try {
			const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: worktreePath })
			const remote = stdout.trim()
			return remote.length > 0 ? remote : undefined
		} catch {
			return undefined
		}
	}

	private async defaultRemoteBranch(worktreePath: string): Promise<string | undefined> {
		try {
			const { stdout } = await execFileAsync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: worktreePath })
			const ref = stdout.trim()
			return ref.split("/").at(-1) || undefined
		} catch {
			return undefined
		}
	}

	private async inspectDeliveryStatus(worktreePath: string): Promise<string> {
		return (await this.inspectDeliveryState(worktreePath)).summary
	}

	private async inspectDeliveryState(worktreePath: string): Promise<{
		summary: string
		ahead: number
		behind: number
		staged: number
		unstaged: number
		untracked: number
		conflicted: number
	}> {
		const resolvedPath = path.resolve(worktreePath)
		const { stdout } = await execFileAsync("git", ["status", "--porcelain=1", "--branch"], { cwd: resolvedPath })
		const lines = stdout.split(/\r?\n/u).filter(Boolean)
		const branchHeader = lines[0] ?? ""
		const branchState = branchHeader.startsWith("## ") ? branchHeader.slice(3).trim() : "branch state unavailable"
		let staged = 0
		let unstaged = 0
		let untracked = 0
		let conflicted = 0
		for (const line of lines.slice(1)) {
			if (line.startsWith("??")) {
				untracked += 1
				continue
			}
			const stagedCode = line[0] ?? " "
			const unstagedCode = line[1] ?? " "
			if (stagedCode === "U" || unstagedCode === "U" || (stagedCode === "A" && unstagedCode === "A")) {
				conflicted += 1
			}
			if (stagedCode !== " ") staged += 1
			if (unstagedCode !== " ") unstaged += 1
		}
		const aheadMatch = branchState.match(/\bahead (\d+)/u)
		const behindMatch = branchState.match(/\bbehind (\d+)/u)
		const ahead = aheadMatch ? Number(aheadMatch[1]) : 0
		const behind = behindMatch ? Number(behindMatch[1]) : 0
		const parts = [branchState]
		if (staged > 0) parts.push(`${staged} staged`)
		if (unstaged > 0) parts.push(`${unstaged} unstaged`)
		if (untracked > 0) parts.push(`${untracked} untracked`)
		if (conflicted > 0) parts.push(`${conflicted} conflicted`)
		if (staged === 0 && unstaged === 0 && untracked === 0 && conflicted === 0) {
			parts.push("worktree clean")
		}
		return {
			summary: parts.join(" · "),
			ahead,
			behind,
			staged,
			unstaged,
			untracked,
			conflicted,
		}
	}

	private trackProcessedEventId(eventId: string): void {
		this.processedEventIds.add(eventId)
		this.processedEventOrder.push(eventId)
		if (this.processedEventOrder.length <= PROCESSED_EVENT_CACHE_LIMIT) {
			return
		}

		const staleEventId = this.processedEventOrder.shift()
		if (staleEventId) {
			this.processedEventIds.delete(staleEventId)
		}
	}
}

function splitJsonLines(content: string): string[] {
	return content
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean)
}

async function ensureBridgeDirectory(workspaceRoot: string): Promise<string> {
	const bridgeDir = path.join(workspaceRoot, BRIDGE_DIR_NAME)
	await fs.mkdir(bridgeDir, { recursive: true })
	return bridgeDir
}

async function readActorRegistry(actorsPath: string): Promise<ActorRegistryFile> {
	try {
		const content = await fs.readFile(actorsPath, "utf8")
		const parsed = JSON.parse(content) as ActorRegistryFile | ActorRegistryEntry[]
		if (Array.isArray(parsed)) {
			return { actors: parsed }
		}
		if (parsed && Array.isArray(parsed.actors)) {
			return { actors: parsed.actors }
		}
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException
		if (nodeError.code !== "ENOENT") {
			Logger.warn(`[LaikaBridge] Failed to parse actors.json: ${getErrorMessage(error)}`)
		}
	}

	return { actors: [] }
}

async function readActorLease(workspaceRoot: string): Promise<ActorLeaseRecord | null> {
	try {
		const leaderPath = path.join(workspaceRoot, BRIDGE_DIR_NAME, LEADER_FILE_NAME)
		const content = await fs.readFile(leaderPath, "utf8")
		return JSON.parse(content) as ActorLeaseRecord
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException
		if (nodeError.code !== "ENOENT") {
			Logger.warn(`[LaikaBridge] Failed to parse leader.json: ${getErrorMessage(error)}`)
		}
		return null
	}
}

function sanitizeActorToken(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]+/g, "-")
}

function normalizePromptDockOutput(value: string | undefined): string {
	if (!value) {
		return ""
	}
	const trimmed = value.trim()
	if (!trimmed) {
		return ""
	}
	return trimmed.length > 1600 ? `${trimmed.slice(0, 1600).trimEnd()}…` : trimmed
}

function formatPullRequestSummary(pr: {
	number?: number
	url?: string
	state?: string
	isDraft?: boolean
	mergeStateStatus?: string
}): string {
	const parts = [
		pr.number ? `PR #${pr.number}` : "pull request",
		pr.state ? `state: ${pr.state}` : undefined,
		typeof pr.isDraft === "boolean" ? (pr.isDraft ? "draft" : "ready for review") : undefined,
		pr.mergeStateStatus ? `merge: ${pr.mergeStateStatus}` : undefined,
	]
	return parts.filter(Boolean).join(", ")
}

function defaultGitProviderSettings(): GitProviderSettings {
	return {
		provider: "github",
		transport: "web",
	}
}

function gitProviderLabel(settings: GitProviderSettings): string {
	switch (settings.provider) {
		case "gitea":
			return "Gitea"
		case "gitlab":
			return "GitLab"
		case "bitbucket":
			return "Bitbucket"
		case "custom":
			return "custom git provider"
		case "github":
		default:
			return "GitHub"
	}
}

function normalizeRemoteRepoUrl(remoteUrl: string, providerBaseUrl?: string): string | undefined {
	const trimmed = remoteUrl.trim().replace(/\.git$/u, "")
	const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/u)
	if (sshMatch) {
		const host = providerBaseUrl?.trim().replace(/\/+$/u, "") || `https://${sshMatch[1]}`
		return `${host}/${sshMatch[2]}`
	}
	const httpsMatch = trimmed.match(/^(https?:\/\/[^/]+)\/(.+)$/u)
	if (httpsMatch) {
		const host = providerBaseUrl?.trim().replace(/\/+$/u, "") || httpsMatch[1]
		return `${host}/${httpsMatch[2]}`
	}
	return undefined
}

function pruneUndefinedFields<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null))
}

function extractMcpToolText(result: {
	content?: Array<
		| { type?: string; text?: string }
		| { type?: string; resource?: { text?: string } }
	>
}): string {
	const parts =
		result.content?.flatMap((block) => {
			if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
				return [block.text]
			}
			if (
				block &&
				typeof block === "object" &&
				"resource" in block &&
				block.resource &&
				typeof block.resource === "object" &&
				typeof block.resource.text === "string"
			) {
				return [block.resource.text]
			}
			return []
		}) ?? []
	return parts.join("\n").trim()
}

function parseGitProviderMcpResult(result: {
	content?: Array<
		| { type?: string; text?: string }
		| { type?: string; resource?: { text?: string } }
	>
}): DeliveryOutcome {
	const text = extractMcpToolText(result)
	const jsonCandidate = parseFirstJsonObject(text)
	const record =
		jsonCandidate && typeof jsonCandidate === "object" && !Array.isArray(jsonCandidate)
			? (("pull_request" in jsonCandidate &&
					jsonCandidate.pull_request &&
					typeof jsonCandidate.pull_request === "object" &&
					!Array.isArray(jsonCandidate.pull_request)
					? jsonCandidate.pull_request
					: jsonCandidate) as Record<string, unknown>)
			: undefined

	const url =
		readStringField(record, [
			"pull_request_url",
			"pr_url",
			"url",
			"html_url",
			"web_url",
			"browser_url",
			"compare_url",
		]) || extractFirstUrl(text)
	const note =
		readStringField(record, ["summary", "message", "note", "detail", "status_text"]) ||
		(text ? text.slice(0, 1200) : "MCP provider action completed.")

	return {
		note,
		pullRequestNumber: readNumberField(record, ["pull_request_number", "pr_number", "number", "id"]),
		pullRequestUrl: url,
		pullRequestState: readStringField(record, ["pull_request_state", "state", "status"]),
		pullRequestMergeStatus: readStringField(record, ["pull_request_merge_status", "merge_status", "mergeStateStatus"]),
		pullRequestIsDraft: readBooleanField(record, ["pull_request_is_draft", "is_draft", "draft"]),
	}
}

function parseFirstJsonObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim()
	if (!trimmed.startsWith("{")) {
		return undefined
	}
	try {
		const parsed = JSON.parse(trimmed)
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
	} catch {
		return undefined
	}
}

function readStringField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!record) {
		return undefined
	}
	for (const key of keys) {
		const value = record[key]
		if (typeof value === "string" && value.trim()) {
			return value.trim()
		}
	}
	return undefined
}

function readNumberField(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
	if (!record) {
		return undefined
	}
	for (const key of keys) {
		const value = record[key]
		if (typeof value === "number" && Number.isFinite(value)) {
			return value
		}
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value)
			if (Number.isFinite(parsed)) {
				return parsed
			}
		}
	}
	return undefined
}

function readBooleanField(record: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
	if (!record) {
		return undefined
	}
	for (const key of keys) {
		const value = record[key]
		if (typeof value === "boolean") {
			return value
		}
	}
	return undefined
}

function coerceAutoApprovalActions(actions: Record<string, unknown>): Partial<AutoApprovalSettings["actions"]> {
	const allowedKeys = [
		"readFiles",
		"readFilesExternally",
		"editFiles",
		"editFilesExternally",
		"executeSafeCommands",
		"executeAllCommands",
		"useBrowser",
		"useMcp",
	] as const
	const next: Partial<AutoApprovalSettings["actions"]> = {}
	for (const key of allowedKeys) {
		if (typeof actions[key] === "boolean") {
			next[key] = actions[key]
		}
	}
	return next
}

function extractFirstUrl(text: string): string | undefined {
	const match = text.match(/https?:\/\/\S+/u)
	return match?.[0]?.replace(/[),.;]+$/u, "")
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
