import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AgentIsolationMode, AgentRole } from "./AgentConfigLoader"

const TASKTRONAUT_DIRECTORY_NAME = ".tasktronaut"
const RUNTIME_DIRECTORY_NAME = "runtime"
const EXECUTION_REGISTRY_FILE_NAME = "subagent-executions.json"
const CARD_EXECUTION_REGISTRY_FILE_NAME = "card-executions.json"
const IPC_FILE_NAME = "ipc.jsonl"
const MAX_EXECUTION_RECORDS = 200
const MAX_CARD_EXECUTION_RECORDS = 500
const execFileAsync = promisify(execFile)

export type SubagentExecutionRecordStatus = "running" | "completed" | "failed" | "abandoned"
export type SubagentExecutionCleanupStatus = "not_required" | "pending" | "cleaned"
export type CardExecutionRecordStatus =
	| "queued"
	| "running"
	| "paused"
	| "aborted"
	| "review"
	| "ready_for_review"
	| "verified"
	| "done"
	| "failed"

export interface SubagentExecutionRecord {
	run_id: string
	task_ulid: string
	agent_name: string
	phase_number?: string
	plan_id?: string
	role: AgentRole
	isolation: AgentIsolationMode
	status: SubagentExecutionRecordStatus
	base_workspace_cwd: string
	execution_cwd: string
	worktree_path?: string
	branch_name?: string
	prompt_preview?: string
	latest_tool_call?: string
	latest_output?: string
	last_event_unix_ms?: number
	created_at_unix_ms: number
	updated_at_unix_ms: number
	completed_at_unix_ms?: number
	error?: string
	cleanup_status: SubagentExecutionCleanupStatus
	cleanup_updated_at_unix_ms?: number
}

interface SubagentExecutionRegistryFile {
	runs: SubagentExecutionRecord[]
}

export interface CardExecutionRecord {
	card_key: string
	board: string
	card_id: string
	phase_number?: string
	wave?: number
	source_ref?: string
	requested_command?: string
	actor_id?: string
	status: CardExecutionRecordStatus
	task_history_id?: string
	run_ids: string[]
	active_run_ids: string[]
	latest_run_id?: string
	branch_name?: string
	worktree_path?: string
	latest_activity?: string
	changed_files?: string[]
	diff_summary?: string
	diff_excerpt?: string
	review_note?: string
	review_requested_at_unix_ms?: number
	verified_at_unix_ms?: number
	updated_at_unix_ms: number
	last_requested_event_id?: string
}

interface CardExecutionRegistryFile {
	cards: CardExecutionRecord[]
}

export interface QueueCardExecutionRequestParams {
	workspaceRoot: string
	cardId: string
	board: string
	actorId?: string
	phaseNumber?: string
	wave?: number
	command?: string
	sourceRef?: string
	eventId?: string
}

export interface SetCardExecutionLifecycleStateParams {
	workspaceRoot: string
	cardId: string
	board: string
	status: CardExecutionRecordStatus
	eventId?: string
	reviewNote?: string
}

export interface BindCardExecutionTaskHistoryParams {
	workspaceRoot: string
	cardId: string
	board: string
	taskHistoryId: string
}

function createRegistryPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, TASKTRONAUT_DIRECTORY_NAME, RUNTIME_DIRECTORY_NAME, EXECUTION_REGISTRY_FILE_NAME)
}

function createCardExecutionRegistryPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, TASKTRONAUT_DIRECTORY_NAME, RUNTIME_DIRECTORY_NAME, CARD_EXECUTION_REGISTRY_FILE_NAME)
}

function createBridgePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, TASKTRONAUT_DIRECTORY_NAME, IPC_FILE_NAME)
}

async function readRegistry(registryPath: string): Promise<SubagentExecutionRegistryFile> {
	try {
		const content = await fs.readFile(registryPath, "utf8")
		const parsed = JSON.parse(content) as Partial<SubagentExecutionRegistryFile>
		return {
			runs: Array.isArray(parsed.runs)
				? parsed.runs.map((record) => ({
						...record,
						cleanup_status:
							record && typeof record === "object" && "cleanup_status" in record
								? (record.cleanup_status as SubagentExecutionCleanupStatus)
								: "not_required",
					}))
				: [],
		}
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException
		if (nodeError.code === "ENOENT") {
			return { runs: [] }
		}
		throw error
	}
}

async function writeRegistry(registryPath: string, registry: SubagentExecutionRegistryFile): Promise<void> {
	await fs.mkdir(path.dirname(registryPath), { recursive: true })
	const trimmedRuns = registry.runs.slice(-MAX_EXECUTION_RECORDS)
	const payload = JSON.stringify({ runs: trimmedRuns }, null, 2)
	const tempPath = `${registryPath}.tmp`
	await fs.writeFile(tempPath, payload)
	await fs.rename(tempPath, registryPath)
}

async function readCardRegistry(registryPath: string): Promise<CardExecutionRegistryFile> {
	try {
		const content = await fs.readFile(registryPath, "utf8")
		const parsed = JSON.parse(content) as Partial<CardExecutionRegistryFile>
		return {
			cards: Array.isArray(parsed.cards) ? parsed.cards : [],
		}
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException
		if (nodeError.code === "ENOENT") {
			return { cards: [] }
		}
		throw error
	}
}

async function writeCardRegistry(registryPath: string, registry: CardExecutionRegistryFile): Promise<void> {
	await fs.mkdir(path.dirname(registryPath), { recursive: true })
	const trimmedCards = registry.cards.slice(-MAX_CARD_EXECUTION_RECORDS)
	const payload = JSON.stringify({ cards: trimmedCards }, null, 2)
	const tempPath = `${registryPath}.tmp`
	await fs.writeFile(tempPath, payload)
	await fs.rename(tempPath, registryPath)
}

function upsertRecord(runs: SubagentExecutionRecord[], nextRecord: SubagentExecutionRecord): SubagentExecutionRecord[] {
	const filtered = runs.filter((record) => record.run_id !== nextRecord.run_id)
	return [...filtered, nextRecord].sort((left, right) => left.created_at_unix_ms - right.created_at_unix_ms)
}

function createCardKey(board: string, cardId: string): string {
	return `${board}:${cardId}`
}

function upsertCardRecord(cards: CardExecutionRecord[], nextRecord: CardExecutionRecord): CardExecutionRecord[] {
	const filtered = cards.filter((record) => record.card_key !== nextRecord.card_key)
	return [...filtered, nextRecord].sort((left, right) => left.updated_at_unix_ms - right.updated_at_unix_ms)
}

function cardRecordMatchesRun(card: CardExecutionRecord, run: SubagentExecutionRecord): boolean {
	if (card.phase_number && run.phase_number && card.phase_number === run.phase_number) {
		return true
	}
	if (typeof card.wave === "number" && parseWaveNumber(run.phase_number) === card.wave) {
		return true
	}
	return false
}

function deriveCardExecutionStatus(
	existing: CardExecutionRecord,
	matchingRuns: SubagentExecutionRecord[],
): CardExecutionRecordStatus {
	if (existing.status === "aborted" && matchingRuns.length === 0) {
		return "aborted"
	}
	if (existing.status === "paused" && !matchingRuns.some((run) => run.status === "running")) {
		return "paused"
	}
	if (
		(existing.status === "verified" || existing.status === "ready_for_review" || existing.status === "review") &&
		!matchingRuns.some((run) => run.status === "running")
	) {
		return existing.status
	}
	if (matchingRuns.some((run) => run.status === "failed" || run.status === "abandoned" || Boolean(run.error))) {
		return "failed"
	}
	if (matchingRuns.some((run) => run.status === "running")) {
		return "running"
	}
	if (existing.requested_command?.includes("verify") || existing.requested_command?.includes("review")) {
		return matchingRuns.length > 0 ? "review" : existing.status
	}
	if (matchingRuns.some((run) => run.status === "completed")) {
		return "done"
	}
	return existing.status
}

function latestRunActivity(run?: SubagentExecutionRecord): string | undefined {
	if (!run) {
		return undefined
	}
	return run.latest_tool_call || run.latest_output || run.prompt_preview
}

async function refreshCardExecutionRecordsForWorkspace(workspaceRoot: string): Promise<void> {
	const registryPath = createRegistryPath(workspaceRoot)
	const cardRegistryPath = createCardExecutionRegistryPath(workspaceRoot)
	const [runRegistry, cardRegistry] = await Promise.all([
		readRegistry(registryPath),
		readCardRegistry(cardRegistryPath),
	])
	if (cardRegistry.cards.length === 0) {
		return
	}

	const evidenceCache = new Map<
		string,
		Promise<{ changedFiles: string[]; diffSummary?: string; diffExcerpt?: string } | undefined>
	>()
	const nextCards = await Promise.all(cardRegistry.cards.map(async (card) => {
		const matchingRuns = runRegistry.runs.filter((run) => cardRecordMatchesRun(card, run))
		const activeRuns = matchingRuns.filter((run) => run.status === "running")
		const latestRun = [...matchingRuns].sort((left, right) => right.updated_at_unix_ms - left.updated_at_unix_ms)[0]
		const reviewWorkspacePath =
			card.worktree_path || activeRuns[0]?.worktree_path || latestRun?.worktree_path || latestRun?.execution_cwd
		let reviewEvidence:
			| { changedFiles: string[]; diffSummary?: string; diffExcerpt?: string }
			| undefined
		if (reviewWorkspacePath) {
			const cached =
				evidenceCache.get(reviewWorkspacePath) ||
				collectCardReviewEvidence(reviewWorkspacePath)
			evidenceCache.set(reviewWorkspacePath, cached)
			reviewEvidence = await cached
		}
		return {
			...card,
			status: deriveCardExecutionStatus(card, matchingRuns),
			run_ids: matchingRuns.map((run) => run.run_id),
			active_run_ids: activeRuns.map((run) => run.run_id),
			latest_run_id: latestRun?.run_id,
			branch_name: activeRuns[0]?.branch_name || latestRun?.branch_name,
			worktree_path: activeRuns[0]?.worktree_path || latestRun?.worktree_path || latestRun?.execution_cwd,
			latest_activity: latestRunActivity(latestRun),
			changed_files: reviewEvidence?.changedFiles ?? card.changed_files,
			diff_summary: reviewEvidence?.diffSummary ?? card.diff_summary,
			diff_excerpt: reviewEvidence?.diffExcerpt ?? card.diff_excerpt,
			updated_at_unix_ms: latestRun?.updated_at_unix_ms || card.updated_at_unix_ms,
		}
	}))

	await writeCardRegistry(cardRegistryPath, { cards: nextCards })
}

async function collectCardReviewEvidence(
	cwd: string,
): Promise<{ changedFiles: string[]; diffSummary?: string; diffExcerpt?: string } | undefined> {
	const workspaceExists = await fs
		.access(cwd)
		.then(() => true)
		.catch(() => false)
	if (!workspaceExists) {
		return undefined
	}

	const isGitRepo = await runGitCommand(["rev-parse", "--git-dir"], cwd)
		.then(() => true)
		.catch(() => false)
	if (!isGitRepo) {
		return undefined
	}

	const statusOutput = await runGitCommand(["status", "--short", "--untracked-files=all"], cwd).catch(() => "")
	const changedFiles = parseChangedFilesFromStatus(statusOutput)
	const hasHead = await runGitCommand(["rev-parse", "HEAD"], cwd)
		.then(() => true)
		.catch(() => false)

	let diffSummary = hasHead
		? (await runGitCommand(["diff", "--shortstat", "HEAD", "--"], cwd).catch(() => "")).trim()
		: ""
	const diffExcerpt = hasHead
		? truncateDiffExcerpt(await runGitCommand(["--no-pager", "diff", "--unified=1", "HEAD", "--"], cwd).catch(() => ""))
		: undefined

	if (!diffSummary) {
		if (changedFiles.length === 0) {
			return undefined
		} else if (hasHead) {
			diffSummary = `${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"} pending review`
		} else {
			diffSummary = `New repository changes across ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}`
		}
	}

	return {
		changedFiles: changedFiles.slice(0, 24),
		diffSummary,
		diffExcerpt,
	}
}

async function runGitCommand(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd })
	return stdout.trim()
}

function parseChangedFilesFromStatus(statusOutput: string): string[] {
	if (!statusOutput.trim()) {
		return []
	}

	return statusOutput
		.split(/\r?\n/u)
		.map((line) => line.replace(/\s+$/u, ""))
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const remainder = line.match(/^[ MADRCU?!]{1,2}\s+(.*)$/u)?.[1]?.trim() || line.trim()
			if (remainder.includes(" -> ")) {
				return remainder.split(" -> ").at(-1)?.trim() || remainder
			}
			return remainder
		})
		.filter((file) => Boolean(file) && !file.startsWith(".tasktronaut/"))
}

function truncateDiffExcerpt(diffOutput: string): string | undefined {
	const trimmed = diffOutput.trim()
	if (!trimmed) {
		return undefined
	}

	const lines = trimmed.split(/\r?\n/u).slice(0, 60)
	const excerpt = lines.join("\n")
	return excerpt.length > 4000 ? `${excerpt.slice(0, 3997)}...` : excerpt
}

function toPromptPreview(prompt: string): string | undefined {
	const trimmed = prompt.trim()
	if (!trimmed) {
		return undefined
	}
	return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed
}

function parseWaveNumber(phaseNumber?: string): number | undefined {
	if (!phaseNumber) {
		return undefined
	}
	const parsed = Number.parseInt(phaseNumber, 10)
	return Number.isFinite(parsed) ? parsed : undefined
}

function createRuntimeEventId(runId: string, timestamp: number): string {
	return `runtime-${runId}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`
}

function buildRuntimePayload(record: SubagentExecutionRecord, extras?: Record<string, unknown>): Record<string, unknown> {
	return {
		run_id: record.run_id,
		task_ulid: record.task_ulid,
		agent_name: record.agent_name,
		phase_number: record.phase_number,
		plan_id: record.plan_id,
		role: record.role,
		isolation: record.isolation,
		status: record.status,
		cleanup_status: record.cleanup_status,
		execution_cwd: record.execution_cwd,
		worktree_path: record.worktree_path,
		branch_name: record.branch_name,
		prompt_preview: record.prompt_preview,
		latest_tool_call: record.latest_tool_call,
		latest_output: record.latest_output,
		updated_at_unix_ms: record.updated_at_unix_ms,
		completed_at_unix_ms: record.completed_at_unix_ms,
		error: record.error,
		...(extras ?? {}),
	}
}

async function appendRuntimeBridgeEvent(
	workspaceRoot: string,
	eventType: "task_status_updated" | "task_output_updated",
	record: SubagentExecutionRecord,
	extras?: Record<string, unknown>,
): Promise<void> {
	const timestamp = Date.now()
	const bridgePath = createBridgePath(workspaceRoot)
	await fs.mkdir(path.dirname(bridgePath), { recursive: true })
	const eventRecord = {
		event_id: createRuntimeEventId(record.run_id, timestamp),
		event: eventType,
		workspace_root: workspaceRoot,
		wave: parseWaveNumber(record.phase_number),
		card_id: record.plan_id,
		source: "tasktronaut",
		timestamp_unix_ms: timestamp,
		payload: buildRuntimePayload(record, extras),
	}
	await fs.appendFile(bridgePath, `${JSON.stringify(eventRecord)}\n`, "utf8")
}

export interface RegisterSubagentExecutionParams {
	workspaceRoot: string
	runId: string
	taskUlid: string
	agentName: string
	phaseNumber?: string
	planId?: string
	role: AgentRole
	isolation: AgentIsolationMode
	baseWorkspaceCwd: string
	executionCwd: string
	worktreePath?: string
	branchName?: string
	prompt: string
}

export interface FinalizeSubagentExecutionParams {
	workspaceRoot: string
	runId: string
	status: Exclude<SubagentExecutionRecordStatus, "running">
	error?: string
}

export interface UpdateSubagentExecutionProgressParams {
	workspaceRoot: string
	runId: string
	latestToolCall?: string
	latestOutput?: string
	error?: string
}

export async function registerSubagentExecution(params: RegisterSubagentExecutionParams): Promise<void> {
	const timestamp = Date.now()
	const registryPath = createRegistryPath(params.workspaceRoot)
	const registry = await readRegistry(registryPath)
	const nextRecord: SubagentExecutionRecord = {
		run_id: params.runId,
		task_ulid: params.taskUlid,
		agent_name: params.agentName,
		phase_number: params.phaseNumber,
		plan_id: params.planId,
		role: params.role,
		isolation: params.isolation,
		status: "running",
		base_workspace_cwd: params.baseWorkspaceCwd,
		execution_cwd: params.executionCwd,
		worktree_path: params.worktreePath,
		branch_name: params.branchName,
		prompt_preview: toPromptPreview(params.prompt),
		created_at_unix_ms: timestamp,
		updated_at_unix_ms: timestamp,
		cleanup_status: params.isolation === "worktree" ? "pending" : "not_required",
		cleanup_updated_at_unix_ms: timestamp,
	}

	await writeRegistry(registryPath, {
		runs: upsertRecord(registry.runs, nextRecord),
	})
	await appendRuntimeBridgeEvent(params.workspaceRoot, "task_status_updated", nextRecord, {
		status_source: "registry",
	})
	await refreshCardExecutionRecordsForWorkspace(params.workspaceRoot)
}

export async function finalizeSubagentExecution(params: FinalizeSubagentExecutionParams): Promise<void> {
	const timestamp = Date.now()
	const registryPath = createRegistryPath(params.workspaceRoot)
	const registry = await readRegistry(registryPath)
	const existing = registry.runs.find((record) => record.run_id === params.runId)
	if (!existing) {
		return
	}

	const nextRecord: SubagentExecutionRecord = {
		...existing,
		status: params.status,
		error: params.error,
		updated_at_unix_ms: timestamp,
		completed_at_unix_ms: timestamp,
		cleanup_updated_at_unix_ms: timestamp,
	}

	await writeRegistry(registryPath, {
		runs: upsertRecord(registry.runs, nextRecord),
	})
	await appendRuntimeBridgeEvent(params.workspaceRoot, "task_status_updated", nextRecord, {
		status_source: "registry",
	})
	await refreshCardExecutionRecordsForWorkspace(params.workspaceRoot)
}

export async function updateSubagentExecutionProgress(params: UpdateSubagentExecutionProgressParams): Promise<void> {
	const timestamp = Date.now()
	const registryPath = createRegistryPath(params.workspaceRoot)
	const registry = await readRegistry(registryPath)
	const existing = registry.runs.find((record) => record.run_id === params.runId)
	if (!existing) {
		return
	}

	const nextRecord: SubagentExecutionRecord = {
		...existing,
		latest_tool_call: params.latestToolCall ?? existing.latest_tool_call,
		latest_output: params.latestOutput ?? existing.latest_output,
		error: params.error ?? existing.error,
		last_event_unix_ms: timestamp,
		updated_at_unix_ms: timestamp,
	}

	await writeRegistry(registryPath, {
		runs: upsertRecord(registry.runs, nextRecord),
	})
	await appendRuntimeBridgeEvent(params.workspaceRoot, "task_output_updated", nextRecord, {
		output_kind: params.latestOutput ? "result" : "tool_call",
	})
	await refreshCardExecutionRecordsForWorkspace(params.workspaceRoot)
}

export async function queueCardExecutionRequest(params: QueueCardExecutionRequestParams): Promise<void> {
	const timestamp = Date.now()
	const registryPath = createCardExecutionRegistryPath(params.workspaceRoot)
	const registry = await readCardRegistry(registryPath)
	const cardKey = createCardKey(params.board, params.cardId)
	const existing = registry.cards.find((record) => record.card_key === cardKey)
	const nextRecord: CardExecutionRecord = {
		card_key: cardKey,
		board: params.board,
		card_id: params.cardId,
		phase_number: params.phaseNumber ?? existing?.phase_number,
		wave: params.wave ?? existing?.wave,
		source_ref: params.sourceRef ?? existing?.source_ref,
		requested_command: params.command ?? existing?.requested_command,
		actor_id: params.actorId ?? existing?.actor_id,
		status: existing?.status === "running" ? "running" : "queued",
		run_ids: existing?.run_ids ?? [],
		active_run_ids: existing?.active_run_ids ?? [],
		latest_run_id: existing?.latest_run_id,
		branch_name: existing?.branch_name,
		worktree_path: existing?.worktree_path,
		latest_activity: existing?.latest_activity,
		changed_files: undefined,
		diff_summary: undefined,
		diff_excerpt: undefined,
		review_note: undefined,
		review_requested_at_unix_ms: undefined,
		verified_at_unix_ms: undefined,
		updated_at_unix_ms: timestamp,
		last_requested_event_id: params.eventId ?? existing?.last_requested_event_id,
	}
	await writeCardRegistry(registryPath, {
		cards: upsertCardRecord(registry.cards, nextRecord),
	})
	await refreshCardExecutionRecordsForWorkspace(params.workspaceRoot)
}

export async function setCardExecutionLifecycleState(params: SetCardExecutionLifecycleStateParams): Promise<void> {
	const timestamp = Date.now()
	const registryPath = createCardExecutionRegistryPath(params.workspaceRoot)
	const registry = await readCardRegistry(registryPath)
	const cardKey = createCardKey(params.board, params.cardId)
	const existing = registry.cards.find((record) => record.card_key === cardKey)
	if (!existing) {
		return
	}

	const nextRecord: CardExecutionRecord = {
		...existing,
		status: params.status,
		active_run_ids: params.status === "paused" || params.status === "aborted" ? [] : existing.active_run_ids,
		review_note: params.reviewNote ?? existing.review_note,
		review_requested_at_unix_ms:
			params.status === "ready_for_review" || params.status === "review"
				? timestamp
				: existing.review_requested_at_unix_ms,
		verified_at_unix_ms: params.status === "verified" ? timestamp : existing.verified_at_unix_ms,
		updated_at_unix_ms: timestamp,
		last_requested_event_id: params.eventId ?? existing.last_requested_event_id,
	}
	await writeCardRegistry(registryPath, {
		cards: upsertCardRecord(registry.cards, nextRecord),
	})
	await refreshCardExecutionRecordsForWorkspace(params.workspaceRoot)
}

export async function bindCardExecutionTaskHistory(params: BindCardExecutionTaskHistoryParams): Promise<void> {
	const timestamp = Date.now()
	const registryPath = createCardExecutionRegistryPath(params.workspaceRoot)
	const registry = await readCardRegistry(registryPath)
	const cardKey = createCardKey(params.board, params.cardId)
	const existing = registry.cards.find((record) => record.card_key === cardKey)
	if (!existing) {
		return
	}

	const nextRecord: CardExecutionRecord = {
		...existing,
		task_history_id: params.taskHistoryId,
		updated_at_unix_ms: timestamp,
	}
	await writeCardRegistry(registryPath, {
		cards: upsertCardRecord(registry.cards, nextRecord),
	})
}

export async function listSubagentExecutions(workspaceRoot: string): Promise<SubagentExecutionRecord[]> {
	const registryPath = createRegistryPath(workspaceRoot)
	const registry = await readRegistry(registryPath)
	return [...registry.runs]
}

export async function listCardExecutionRecords(workspaceRoot: string): Promise<CardExecutionRecord[]> {
	const registryPath = createCardExecutionRegistryPath(workspaceRoot)
	const registry = await readCardRegistry(registryPath)
	return [...registry.cards]
}

export async function reconcileSubagentExecutionRegistry(workspaceRoot: string): Promise<{
	reconciled: number
	abandoned: number
	cleaned: number
}> {
	const registryPath = createRegistryPath(workspaceRoot)
	const registry = await readRegistry(registryPath)
	if (registry.runs.length === 0) {
		return { reconciled: 0, abandoned: 0, cleaned: 0 }
	}

	const timestamp = Date.now()
	let reconciled = 0
	let abandoned = 0
	let cleaned = 0
	const changedRuns: SubagentExecutionRecord[] = []
	const nextRuns = await Promise.all(
		registry.runs.map(async (record) => {
			if (!record.worktree_path || record.isolation !== "worktree") {
				return record
			}

			const worktreeExists = await fs
				.access(record.worktree_path)
				.then(() => true)
				.catch(() => false)

			if (worktreeExists) {
				return record
			}

			const nextCleanupStatus: SubagentExecutionCleanupStatus = "cleaned"
			if (record.status === "running") {
				reconciled += 1
				abandoned += 1
				cleaned += 1
				const nextRecord = {
					...record,
					status: "abandoned" as const,
					error: record.error || "Worker run ended without a completion signal; reconciled after its worktree disappeared.",
					updated_at_unix_ms: timestamp,
					completed_at_unix_ms: record.completed_at_unix_ms ?? timestamp,
					cleanup_status: nextCleanupStatus,
					cleanup_updated_at_unix_ms: timestamp,
				}
				changedRuns.push(nextRecord)
				return nextRecord
			}

			if (record.cleanup_status !== nextCleanupStatus) {
				reconciled += 1
				cleaned += 1
				const nextRecord = {
					...record,
					cleanup_status: nextCleanupStatus,
					cleanup_updated_at_unix_ms: timestamp,
					updated_at_unix_ms: timestamp,
				}
				changedRuns.push(nextRecord)
				return nextRecord
			}

			return record
		}),
	)

	if (reconciled > 0) {
		await writeRegistry(registryPath, { runs: nextRuns })
		await Promise.all(
			changedRuns.map((record) =>
				appendRuntimeBridgeEvent(workspaceRoot, "task_status_updated", record, {
					status_source: "reconcile",
				}),
			),
		)
		await refreshCardExecutionRecordsForWorkspace(workspaceRoot)
	}

	return { reconciled, abandoned, cleaned }
}
