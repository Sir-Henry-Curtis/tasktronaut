import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WebviewProvider } from "@core/webview"
import * as vscode from "vscode"
import { HostProvider } from "@/hosts/host-provider"
import { HostRegistryInfo } from "@/registry"
import { bindCardExecutionTaskHistory, listCardExecutionRecords, queueCardExecutionRequest, reconcileSubagentExecutionRegistry, setCardExecutionLifecycleState } from "@/core/task/tools/subagent/SubagentExecutionRegistry"
import { getDistinctId } from "@/services/logging/distinctId"
import { Logger } from "@/shared/services/Logger"
import { type ActorLeaseRecord, getBridgeEventCommand, parseBridgeEventLine, shouldExecuteBridgeEvent } from "./bridge-contract"

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
const HEARTBEAT_INTERVAL_MS = 30_000
const POLL_INTERVAL_MS = 2_000
const PROCESSED_EVENT_CACHE_LIMIT = 500

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
			await this.writeHeartbeat()
			await this.captureCurrentBridgeTail(nextWorkspaceRoot)
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
			const nextActors = registry.actors.filter((actor) => actor.actor_id !== this.actorId)
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

	private async executeBridgeCommand(command: string, eventType: string, eventId: string): Promise<string | undefined> {
		try {
			Logger.info(`[LaikaBridge] Executing ${eventType} (${eventId}) via Tasktronaut: ${command}`)
			await HostProvider.workspace.openClineSidebarPanel({})
			const webview = WebviewProvider.getInstance()
			const taskId = await webview.controller.initTask(command)
			await webview.controller.postStateToWebview()
			return taskId
		} catch (error) {
			Logger.warn(`[LaikaBridge] Failed to execute ${eventType} (${eventId}): ${getErrorMessage(error)}`)
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
				const taskId = await this.executeBridgeCommand(command, eventType, eventId)
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
				const taskId = await this.executeBridgeCommand(command, eventType, eventId)
				await this.bindTaskHistoryForEvent(workspaceRoot, event, taskId)
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
			case "task_add_review_note": {
				await this.updateReviewNote(workspaceRoot, event)
				Logger.info(`[LaikaBridge] Attached review note via ${eventType} (${eventId})`)
				return
			}
			default: {
				const command = getBridgeEventCommand(event)
				if (!command) {
					Logger.warn(`[LaikaBridge] Ignored ${eventType} (${eventId}) because it did not include an executable command`)
					return
				}
				await this.queueExecutionOwnership(workspaceRoot, event, command)
				const taskId = await this.executeBridgeCommand(command, eventType, eventId)
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
		status: "paused" | "aborted" | "ready_for_review" | "verified",
	): Promise<void> {
		const payload = event.payload
		const board = payload && typeof payload.board === "string" ? payload.board : undefined
		if (!event.card_id || !board) {
			return
		}
		await setCardExecutionLifecycleState({
			workspaceRoot,
			cardId: event.card_id,
			board,
			status,
			eventId: event.event_id,
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
		})
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

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
