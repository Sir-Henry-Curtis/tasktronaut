import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomBytes } from "node:crypto"
import type { AgentIsolationMode, AgentRole } from "./AgentConfigLoader"
import { GlobalFileNames } from "@/core/storage/disk"
import { HostProvider } from "@/hosts/host-provider"
import type { ClineMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"

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
	| "changes_requested"
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
	native_checkpoint_hash?: string
	native_checkpoint_message_ts?: number
	run_ids: string[]
	active_run_ids: string[]
	latest_run_id?: string
	branch_name?: string
	worktree_path?: string
	latest_activity?: string
	changed_files?: string[]
	file_diffs?: CardExecutionFileDiff[]
	diff_summary?: string
	diff_excerpt?: string
	delivery_note?: string
	pull_request_number?: number
	pull_request_url?: string
	pull_request_state?: string
	pull_request_merge_status?: string
	pull_request_is_draft?: boolean
	review_note?: string
	review_requested_at_unix_ms?: number
	verified_at_unix_ms?: number
	delivery_history?: CardExecutionDeliveryHistoryEntry[]
	review_history?: CardExecutionReviewHistoryEntry[]
	updated_at_unix_ms: number
	last_requested_event_id?: string
}

interface CardExecutionRegistryFile {
	cards: CardExecutionRecord[]
}

export interface CardExecutionFileDiff {
	path: string
	status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "changed"
	start_line?: number
	end_line?: number
	diff_excerpt?: string
}

export interface CardExecutionReviewHistoryEntry {
	event: "ready_for_review" | "verified" | "changes_requested" | "review_note" | "review_comment"
	timestamp_unix_ms: number
	run_id?: string
	note?: string
	file_path?: string
	start_line?: number
	end_line?: number
}

export interface CardExecutionDeliveryHistoryEntry {
	event: "commit_requested" | "sync_requested" | "ship_check_requested" | "pr_requested" | "delivery_note"
	timestamp_unix_ms: number
	run_id?: string
	note?: string
	branch_name?: string
	worktree_path?: string
	readiness?: string
}

interface ChangedFileEntry {
	path: string
	status: CardExecutionFileDiff["status"]
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
	reviewEvent?: CardExecutionReviewHistoryEntry["event"]
	reviewFilePath?: string
	reviewStartLine?: number
	reviewEndLine?: number
}

export interface BindCardExecutionTaskHistoryParams {
	workspaceRoot: string
	cardId: string
	board: string
	taskHistoryId: string
}

export interface RecordCardExecutionDeliveryEventParams {
	workspaceRoot: string
	cardId: string
	board: string
	eventId?: string
	deliveryEvent: CardExecutionDeliveryHistoryEntry["event"]
	deliveryNote: string
	branchName?: string
	worktreePath?: string
	deliveryReadiness?: string
	pullRequestNumber?: number
	pullRequestUrl?: string
	pullRequestState?: string
	pullRequestMergeStatus?: string
	pullRequestIsDraft?: boolean
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
		// Corrupted registry (e.g. from concurrent writes to the same .tmp file) —
		// reset to empty rather than blocking all subagent execution.
		Logger.warn("[SubagentExecutionRegistry] Registry parse failed, resetting:", (error as Error).message)
		return { runs: [] }
	}
}

async function atomicWrite(tempPath: string, destPath: string): Promise<void> {
	// On Windows, renaming over an existing file held open by a concurrent reader/writer
	// fails with EPERM. Retry with backoff; fall back to a direct write if it keeps failing.
	const maxAttempts = 5
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			await fs.rename(tempPath, destPath)
			return
		} catch (err) {
			const nodeErr = err as NodeJS.ErrnoException
			if ((nodeErr.code === "EPERM" || nodeErr.code === "EBUSY") && attempt < maxAttempts - 1) {
				await new Promise<void>((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
				continue
			}
			// All retries exhausted or non-retryable error — fall back to direct (non-atomic) write.
			if (nodeErr.code === "EPERM" || nodeErr.code === "EBUSY") {
				try {
					const content = await fs.readFile(tempPath, "utf8")
					await fs.writeFile(destPath, content, "utf8")
					await fs.unlink(tempPath).catch(() => {})
					Logger.warn("[SubagentExecutionRegistry] Atomic rename failed; used direct write fallback")
					return
				} catch {
					// ignore secondary failure, fall through to rethrow original
				}
			}
			await fs.unlink(tempPath).catch(() => {})
			throw err
		}
	}
}

async function writeRegistry(registryPath: string, registry: SubagentExecutionRegistryFile): Promise<void> {
	await fs.mkdir(path.dirname(registryPath), { recursive: true })
	const trimmedRuns = registry.runs.slice(-MAX_EXECUTION_RECORDS)
	const payload = JSON.stringify({ runs: trimmedRuns }, null, 2)
	// Use a unique temp path per write so concurrent parallel-subagent writes
	// don't overwrite each other's temp file and corrupt the registry.
	const tempPath = `${registryPath}.${randomBytes(4).toString("hex")}.tmp`
	await fs.writeFile(tempPath, payload)
	await atomicWrite(tempPath, registryPath)
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
		Logger.warn("[SubagentExecutionRegistry] Card registry parse failed, resetting:", (error as Error).message)
		return { cards: [] }
	}
}

async function writeCardRegistry(registryPath: string, registry: CardExecutionRegistryFile): Promise<void> {
	await fs.mkdir(path.dirname(registryPath), { recursive: true })
	const trimmedCards = registry.cards.slice(-MAX_CARD_EXECUTION_RECORDS)
	const payload = JSON.stringify({ cards: trimmedCards }, null, 2)
	const tempPath = `${registryPath}.${randomBytes(4).toString("hex")}.tmp`
	await fs.writeFile(tempPath, payload)
	await atomicWrite(tempPath, registryPath)
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

function appendReviewHistory(
	existing: CardExecutionRecord,
	entry?: CardExecutionReviewHistoryEntry,
): CardExecutionReviewHistoryEntry[] | undefined {
	const current = existing.review_history ?? []
	if (!entry) {
		return current.length > 0 ? current : undefined
	}
	return [...current, entry].slice(-24)
}

function appendDeliveryHistory(
	existing: CardExecutionRecord,
	entry?: CardExecutionDeliveryHistoryEntry,
): CardExecutionDeliveryHistoryEntry[] | undefined {
	const current = existing.delivery_history ?? []
	if (!entry) {
		return current.length > 0 ? current : undefined
	}
	return [...current, entry].slice(-24)
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
		(
			existing.status === "verified" ||
			existing.status === "ready_for_review" ||
			existing.status === "review" ||
			existing.status === "changes_requested"
		) &&
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

export async function refreshCardExecutionRecordsForWorkspace(workspaceRoot: string): Promise<void> {
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
		Promise<{ changedFiles: string[]; fileDiffs: CardExecutionFileDiff[]; diffSummary?: string; diffExcerpt?: string } | undefined>
	>()
	const checkpointCache = new Map<
		string,
		Promise<{ nativeCheckpointHash?: string; nativeCheckpointMessageTs?: number } | undefined>
	>()
	const nextCards = await Promise.all(cardRegistry.cards.map(async (card) => {
		const matchingRuns = runRegistry.runs.filter((run) => cardRecordMatchesRun(card, run))
		const activeRuns = matchingRuns.filter((run) => run.status === "running")
		const latestRun = [...matchingRuns].sort((left, right) => right.updated_at_unix_ms - left.updated_at_unix_ms)[0]
		const reviewWorkspacePath =
			card.worktree_path || activeRuns[0]?.worktree_path || latestRun?.worktree_path || latestRun?.execution_cwd
		let reviewEvidence:
			| { changedFiles: string[]; fileDiffs: CardExecutionFileDiff[]; diffSummary?: string; diffExcerpt?: string }
			| undefined
		if (reviewWorkspacePath) {
			const cached =
				evidenceCache.get(reviewWorkspacePath) ||
				collectCardReviewEvidence(reviewWorkspacePath)
			evidenceCache.set(reviewWorkspacePath, cached)
			reviewEvidence = await cached
		}
		const nativeCheckpointPromise =
			card.task_history_id
				? checkpointCache.get(card.task_history_id) ||
					readLatestTaskCheckpoint(card.task_history_id)
				: undefined
		if (card.task_history_id && nativeCheckpointPromise && !checkpointCache.has(card.task_history_id)) {
			checkpointCache.set(card.task_history_id, nativeCheckpointPromise)
		}
		const nativeCheckpoint = nativeCheckpointPromise ? await nativeCheckpointPromise : undefined
		return {
			...card,
			status: deriveCardExecutionStatus(card, matchingRuns),
			native_checkpoint_hash:
				nativeCheckpoint?.nativeCheckpointHash ?? card.native_checkpoint_hash,
			native_checkpoint_message_ts:
				nativeCheckpoint?.nativeCheckpointMessageTs ?? card.native_checkpoint_message_ts,
			run_ids: matchingRuns.map((run) => run.run_id),
			active_run_ids: activeRuns.map((run) => run.run_id),
			latest_run_id: latestRun?.run_id,
			branch_name: activeRuns[0]?.branch_name || latestRun?.branch_name,
			worktree_path: activeRuns[0]?.worktree_path || latestRun?.worktree_path || latestRun?.execution_cwd,
			latest_activity: latestRunActivity(latestRun) ?? card.latest_activity,
			changed_files: reviewEvidence?.changedFiles ?? card.changed_files,
			file_diffs: reviewEvidence?.fileDiffs ?? card.file_diffs,
			diff_summary: reviewEvidence?.diffSummary ?? card.diff_summary,
			diff_excerpt: reviewEvidence?.diffExcerpt ?? card.diff_excerpt,
			delivery_note: card.delivery_note,
			pull_request_number: card.pull_request_number,
			pull_request_url: card.pull_request_url,
			pull_request_state: card.pull_request_state,
			pull_request_merge_status: card.pull_request_merge_status,
			pull_request_is_draft: card.pull_request_is_draft,
			updated_at_unix_ms: latestRun?.updated_at_unix_ms || card.updated_at_unix_ms,
		}
	}))

	await writeCardRegistry(cardRegistryPath, { cards: nextCards })
}

async function readLatestTaskCheckpoint(
	taskHistoryId: string,
): Promise<{ nativeCheckpointHash?: string; nativeCheckpointMessageTs?: number } | undefined> {
	let uiMessagesPath: string | undefined
	try {
		uiMessagesPath = path.join(
			HostProvider.get().globalStorageFsPath,
			"tasks",
			taskHistoryId,
			GlobalFileNames.uiMessages,
		)
	} catch {
		return undefined
	}

	try {
		const content = await fs.readFile(uiMessagesPath, "utf8")
		const messages = JSON.parse(content) as ClineMessage[]
		if (!Array.isArray(messages)) {
			return undefined
		}
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index]
			const checkpointHash =
				typeof message?.lastCheckpointHash === "string" ? message.lastCheckpointHash.trim() : ""
			if (!checkpointHash) {
				continue
			}
			return {
				nativeCheckpointHash: checkpointHash,
				nativeCheckpointMessageTs:
					typeof message.ts === "number" && Number.isFinite(message.ts) ? message.ts : undefined,
			}
		}
		return undefined
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException
		if (nodeError.code === "ENOENT") {
			return undefined
		}
		throw error
	}
}

async function collectCardReviewEvidence(
	cwd: string,
): Promise<{ changedFiles: string[]; fileDiffs: CardExecutionFileDiff[]; diffSummary?: string; diffExcerpt?: string } | undefined> {
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
	const changedFileEntries = parseChangedFileEntriesFromStatus(statusOutput)
	const changedFiles = changedFileEntries.map((entry) => entry.path)
	const fileDiffs = await collectFileDiffs(cwd, changedFileEntries)
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
		fileDiffs,
		diffSummary,
		diffExcerpt,
	}
}

async function runGitCommand(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd })
	return stdout.trim()
}

function parseChangedFileEntriesFromStatus(statusOutput: string): ChangedFileEntry[] {
	if (!statusOutput.trim()) {
		return []
	}

	return statusOutput
		.split(/\r?\n/u)
		.map((line) => line.replace(/\s+$/u, ""))
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const match = line.match(/^([ MADRCU?!]{1,2})\s+(.*)$/u)
			const statusCode = match?.[1] || "??"
			const remainder = match?.[2]?.trim() || line.trim().replace(/^[MADRCU?!]{1,2}\s+/u, "")
			const status = parseChangedFileStatus(statusCode, remainder)
			if (remainder.includes(" -> ")) {
				return {
					path: remainder.split(" -> ").at(-1)?.trim() || remainder,
					status,
				}
			}
			return {
				path: remainder,
				status,
			}
		})
		.filter((entry) => Boolean(entry.path) && !entry.path.startsWith(".tasktronaut/"))
}

function parseChangedFileStatus(statusCode: string, remainder: string): CardExecutionFileDiff["status"] {
	if (statusCode === "??") {
		return "untracked"
	}
	if (statusCode.includes("R") || remainder.includes(" -> ")) {
		return "renamed"
	}
	if (statusCode.includes("D")) {
		return "deleted"
	}
	if (statusCode.includes("A")) {
		return "added"
	}
	if (statusCode.includes("M")) {
		return "modified"
	}
	return "changed"
}

async function collectFileDiffs(cwd: string, changedFiles: ChangedFileEntry[]): Promise<CardExecutionFileDiff[]> {
	const visibleFiles = changedFiles.slice(0, 6)
	return Promise.all(
		visibleFiles.map(async (entry) => {
			const details = await collectFileDiffDetails(cwd, entry)
			return {
				path: entry.path,
				status: entry.status,
				start_line: details.startLine,
				end_line: details.endLine,
				diff_excerpt: details.diffExcerpt,
			}
		}),
	)
}

async function collectFileDiffDetails(
	cwd: string,
	entry: ChangedFileEntry,
): Promise<{ startLine?: number; endLine?: number; diffExcerpt?: string }> {
	const diffOutput = await runGitCommand(["--no-pager", "diff", "--unified=1", "HEAD", "--", entry.path], cwd).catch(() => "")
	const diffExcerpt = truncateDiffExcerpt(diffOutput, 28, 1800)
	const anchor = extractDiffAnchor(diffOutput)
	if (diffExcerpt) {
		return {
			startLine: anchor?.startLine,
			endLine: anchor?.endLine,
			diffExcerpt,
		}
	}

	if (entry.status === "untracked" || entry.status === "added") {
		const preview = await readFilePreview(path.resolve(cwd, entry.path))
		return {
			startLine: 0,
			endLine: 0,
			diffExcerpt: preview ? `New file preview: ${entry.path}\n${preview}` : undefined,
		}
	}

	if (entry.status === "deleted") {
		return {
			startLine: 0,
			endLine: 0,
			diffExcerpt: `Deleted file: ${entry.path}`,
		}
	}

	return {
		startLine: anchor?.startLine,
		endLine: anchor?.endLine,
		diffExcerpt: undefined,
	}
}

async function readFilePreview(filePath: string): Promise<string | undefined> {
	try {
		const content = await fs.readFile(filePath, "utf8")
		const trimmed = content.trim()
		if (!trimmed) {
			return "File is currently empty."
		}
		const lines = trimmed.split(/\r?\n/u).slice(0, 28)
		const excerpt = lines.join("\n")
		return excerpt.length > 1800 ? `${excerpt.slice(0, 1797)}...` : excerpt
	} catch {
		return undefined
	}
}

function truncateDiffExcerpt(diffOutput: string, maxLines = 60, maxChars = 4000): string | undefined {
	const trimmed = diffOutput.trim()
	if (!trimmed) {
		return undefined
	}

	const lines = trimmed.split(/\r?\n/u).slice(0, maxLines)
	const excerpt = lines.join("\n")
	return excerpt.length > maxChars ? `${excerpt.slice(0, Math.max(0, maxChars - 3))}...` : excerpt
}

function extractDiffAnchor(diffOutput: string): { startLine: number; endLine: number } | undefined {
	const lines = diffOutput.split(/\r?\n/u)
	for (const line of lines) {
		const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u)
		if (!match) {
			continue
		}
		const startLineOneBased = Number.parseInt(match[1] || "1", 10)
		const lineCount = Number.parseInt(match[2] || "1", 10)
		if (!Number.isFinite(startLineOneBased)) {
			return undefined
		}
		const startLine = Math.max(0, startLineOneBased - 1)
		const endLine = Math.max(startLine, startLine + Math.max(1, lineCount) - 1)
		return { startLine, endLine }
	}
	return undefined
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
		task_history_id: existing?.task_history_id,
		native_checkpoint_hash: existing?.native_checkpoint_hash,
		native_checkpoint_message_ts: existing?.native_checkpoint_message_ts,
		run_ids: existing?.run_ids ?? [],
		active_run_ids: existing?.active_run_ids ?? [],
		latest_run_id: existing?.latest_run_id,
		branch_name: existing?.branch_name,
		worktree_path: existing?.worktree_path,
		latest_activity: existing?.latest_activity,
		changed_files: undefined,
		file_diffs: undefined,
		diff_summary: undefined,
		diff_excerpt: undefined,
		delivery_note: existing?.delivery_note,
		pull_request_number: existing?.pull_request_number,
		pull_request_url: existing?.pull_request_url,
		pull_request_state: existing?.pull_request_state,
		pull_request_merge_status: existing?.pull_request_merge_status,
		pull_request_is_draft: existing?.pull_request_is_draft,
		review_note: undefined,
		review_requested_at_unix_ms: undefined,
		verified_at_unix_ms: undefined,
		delivery_history: existing?.delivery_history,
		review_history: existing?.review_history,
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
		delivery_note: existing.delivery_note,
		pull_request_number: existing.pull_request_number,
		pull_request_url: existing.pull_request_url,
		pull_request_state: existing.pull_request_state,
		pull_request_merge_status: existing.pull_request_merge_status,
		pull_request_is_draft: existing.pull_request_is_draft,
		delivery_history: existing.delivery_history,
		review_history: appendReviewHistory(existing, buildReviewHistoryEntry(existing, params, timestamp)),
		updated_at_unix_ms: timestamp,
		last_requested_event_id: params.eventId ?? existing.last_requested_event_id,
	}
	await writeCardRegistry(registryPath, {
		cards: upsertCardRecord(registry.cards, nextRecord),
	})
	await refreshCardExecutionRecordsForWorkspace(params.workspaceRoot)
}

function buildReviewHistoryEntry(
	existing: CardExecutionRecord,
	params: SetCardExecutionLifecycleStateParams,
	timestamp: number,
): CardExecutionReviewHistoryEntry | undefined {
	const event =
		params.reviewEvent ??
		(params.status === "ready_for_review" || params.status === "verified" || params.status === "changes_requested"
			? params.status
			: undefined)
	if (!event) {
		return undefined
	}

	return {
		event,
		timestamp_unix_ms: timestamp,
		run_id: existing.latest_run_id,
		note: params.reviewNote ?? existing.review_note,
		file_path: params.reviewFilePath,
		start_line: params.reviewStartLine,
		end_line: params.reviewEndLine,
	}
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
	const nativeCheckpoint = await readLatestTaskCheckpoint(params.taskHistoryId).catch(() => undefined)

	const nextRecord: CardExecutionRecord = {
		...existing,
		task_history_id: params.taskHistoryId,
		native_checkpoint_hash: nativeCheckpoint?.nativeCheckpointHash ?? existing.native_checkpoint_hash,
		native_checkpoint_message_ts:
			nativeCheckpoint?.nativeCheckpointMessageTs ?? existing.native_checkpoint_message_ts,
		updated_at_unix_ms: timestamp,
	}
	await writeCardRegistry(registryPath, {
		cards: upsertCardRecord(registry.cards, nextRecord),
	})
}

export async function recordCardExecutionDeliveryEvent(params: RecordCardExecutionDeliveryEventParams): Promise<void> {
	const timestamp = Date.now()
	const registryPath = createCardExecutionRegistryPath(params.workspaceRoot)
	const registry = await readCardRegistry(registryPath)
	const cardKey = createCardKey(params.board, params.cardId)
	const existing = registry.cards.find((record) => record.card_key === cardKey)
	if (!existing) {
		return
	}

	const entry: CardExecutionDeliveryHistoryEntry = {
		event: params.deliveryEvent,
		timestamp_unix_ms: timestamp,
		run_id: existing.latest_run_id,
		note: params.deliveryNote,
		branch_name: params.branchName ?? existing.branch_name,
		worktree_path: params.worktreePath ?? existing.worktree_path,
		readiness: params.deliveryReadiness,
	}

	const nextRecord: CardExecutionRecord = {
		...existing,
		branch_name: params.branchName ?? existing.branch_name,
		worktree_path: params.worktreePath ?? existing.worktree_path,
		latest_activity: params.deliveryNote,
		delivery_note: params.deliveryNote,
		pull_request_number: params.pullRequestNumber ?? existing.pull_request_number,
		pull_request_url: params.pullRequestUrl ?? existing.pull_request_url,
		pull_request_state: params.pullRequestState ?? existing.pull_request_state,
		pull_request_merge_status: params.pullRequestMergeStatus ?? existing.pull_request_merge_status,
		pull_request_is_draft: params.pullRequestIsDraft ?? existing.pull_request_is_draft,
		delivery_history: appendDeliveryHistory(existing, entry),
		updated_at_unix_ms: timestamp,
		last_requested_event_id: params.eventId ?? existing.last_requested_event_id,
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
