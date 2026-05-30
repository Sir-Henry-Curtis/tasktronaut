import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, it } from "mocha"
import { GlobalFileNames } from "@/core/storage/disk"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import {
	bindCardExecutionTaskHistory,
	finalizeSubagentExecution,
	listCardExecutionRecords,
	listSubagentExecutions,
	queueCardExecutionRequest,
	reconcileSubagentExecutionRegistry,
	recordCardExecutionDeliveryEvent,
	registerSubagentExecution,
	setCardExecutionLifecycleState,
	updateSubagentExecutionProgress,
} from "../SubagentExecutionRegistry"

const execFileAsync = promisify(execFile)

describe("SubagentExecutionRegistry", () => {
	const createdWorkspaces: string[] = []

	afterEach(async () => {
		await Promise.all(
			createdWorkspaces.splice(0).map(async (workspaceRoot) => {
				await fs.rm(workspaceRoot, { recursive: true, force: true })
			}),
		)
	})

	it("marks completed worktree runs as cleaned once their worktree disappears", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		createdWorkspaces.push(workspaceRoot)
		const worktreePath = path.join(workspaceRoot, ".tasktronaut", "worktrees", "agent-cleanup")
		await fs.mkdir(worktreePath, { recursive: true })

		await registerSubagentExecution({
			workspaceRoot,
			runId: "run-cleanup",
			taskUlid: "task-1",
			agentName: "gsd-executor",
			phaseNumber: "02",
			planId: "02-03",
			role: "worker",
			isolation: "worktree",
			baseWorkspaceCwd: workspaceRoot,
			executionCwd: worktreePath,
			worktreePath,
			branchName: "tasktronaut/agent-cleanup",
			prompt: "Execute plan",
		})
		await finalizeSubagentExecution({
			workspaceRoot,
			runId: "run-cleanup",
			status: "completed",
		})
		await fs.rm(worktreePath, { recursive: true, force: true })

		const reconciliation = await reconcileSubagentExecutionRegistry(workspaceRoot)
		assert.equal(reconciliation.reconciled, 1)
		assert.equal(reconciliation.cleaned, 1)
		assert.equal(reconciliation.abandoned, 0)

		const [record] = await listSubagentExecutions(workspaceRoot)
		assert.equal(record.phase_number, "02")
		assert.equal(record.plan_id, "02-03")
		assert.equal(record.status, "completed")
		assert.equal(record.cleanup_status, "cleaned")
		assert.ok(record.cleanup_updated_at_unix_ms)
	})

	it("marks running worktree runs as abandoned when their worktree is gone", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		createdWorkspaces.push(workspaceRoot)
		const worktreePath = path.join(workspaceRoot, ".tasktronaut", "worktrees", "agent-abandoned")
		await fs.mkdir(worktreePath, { recursive: true })

		await registerSubagentExecution({
			workspaceRoot,
			runId: "run-abandoned",
			taskUlid: "task-2",
			agentName: "gsd-executor",
			phaseNumber: "03",
			planId: "03-01",
			role: "worker",
			isolation: "worktree",
			baseWorkspaceCwd: workspaceRoot,
			executionCwd: worktreePath,
			worktreePath,
			branchName: "tasktronaut/agent-abandoned",
			prompt: "Execute plan",
		})
		await fs.rm(worktreePath, { recursive: true, force: true })

		const reconciliation = await reconcileSubagentExecutionRegistry(workspaceRoot)
		assert.equal(reconciliation.reconciled, 1)
		assert.equal(reconciliation.cleaned, 1)
		assert.equal(reconciliation.abandoned, 1)

		const [record] = await listSubagentExecutions(workspaceRoot)
		assert.equal(record.status, "abandoned")
		assert.equal(record.cleanup_status, "cleaned")
		assert.match(record.error || "", /completion signal/i)
		assert.ok(record.completed_at_unix_ms)
	})

	it("emits bridge runtime events for register, progress, and finalize", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		createdWorkspaces.push(workspaceRoot)

		await registerSubagentExecution({
			workspaceRoot,
			runId: "run-events",
			taskUlid: "task-3",
			agentName: "gsd-executor",
			phaseNumber: "04",
			planId: "04-01",
			role: "worker",
			isolation: "inherit",
			baseWorkspaceCwd: workspaceRoot,
			executionCwd: workspaceRoot,
			branchName: "tasktronaut/run-events",
			prompt: "Execute plan",
		})

		await updateSubagentExecutionProgress({
			workspaceRoot,
			runId: "run-events",
			latestToolCall: "read_file(path=src/main.ts)",
			latestOutput: "Read the current workspace entrypoint.",
		})

		await finalizeSubagentExecution({
			workspaceRoot,
			runId: "run-events",
			status: "completed",
		})

		const bridgePath = path.join(workspaceRoot, ".tasktronaut", "ipc.jsonl")
		const content = await fs.readFile(bridgePath, "utf8")
		const events = content
			.trim()
			.split(/\r?\n/u)
			.map((line) => JSON.parse(line) as { event: string; payload?: Record<string, unknown> })

		assert.equal(events.length, 3)
		assert.deepEqual(
			events.map((event) => event.event),
			["task_status_updated", "task_output_updated", "task_status_updated"],
		)
		assert.equal(events[1]?.payload?.latest_tool_call, "read_file(path=src/main.ts)")
		assert.equal(events[1]?.payload?.latest_output, "Read the current workspace entrypoint.")
		assert.equal(events[2]?.payload?.status, "completed")
	})

	it("persists card execution ownership and links matching runs", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		createdWorkspaces.push(workspaceRoot)

		await queueCardExecutionRequest({
			workspaceRoot,
			cardId: "phase-2",
			board: "roadmap",
			actorId: "actor-2",
			phaseNumber: "2",
			wave: 2,
			command: "/gsd-execute-phase 2",
			sourceRef: ".planning/ROADMAP.md",
			eventId: "evt-phase-2",
		})

		await registerSubagentExecution({
			workspaceRoot,
			runId: "run-owned",
			taskUlid: "task-4",
			agentName: "gsd-executor",
			phaseNumber: "2",
			planId: "02-01",
			role: "worker",
			isolation: "worktree",
			baseWorkspaceCwd: workspaceRoot,
			executionCwd: workspaceRoot,
			worktreePath: path.join(workspaceRoot, ".tasktronaut", "worktrees", "phase-2"),
			branchName: "tasktronaut/phase-2",
			prompt: "Execute phase 2 plan 02-01",
		})

		await updateSubagentExecutionProgress({
			workspaceRoot,
			runId: "run-owned",
			latestToolCall: "read_file(path=src/main.ts)",
		})

		const [record] = await listCardExecutionRecords(workspaceRoot)
		assert.equal(record.card_key, "roadmap:phase-2")
		assert.equal(record.status, "running")
		assert.deepEqual(record.run_ids, ["run-owned"])
		assert.deepEqual(record.active_run_ids, ["run-owned"])
		assert.equal(record.latest_run_id, "run-owned")
		assert.equal(record.actor_id, "actor-2")
		assert.equal(record.branch_name, "tasktronaut/phase-2")
		assert.match(record.latest_activity || "", /read_file/)
	})

	it("supports paused lifecycle state for owned cards", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		createdWorkspaces.push(workspaceRoot)

		await queueCardExecutionRequest({
			workspaceRoot,
			cardId: "phase-3",
			board: "stage",
			actorId: "actor-3",
			phaseNumber: "3",
			wave: 3,
			command: "/gsd-execute-phase 3",
			sourceRef: ".planning/PLANS/03-EXECUTE.md",
			eventId: "evt-phase-3",
		})

		await setCardExecutionLifecycleState({
			workspaceRoot,
			cardId: "phase-3",
			board: "stage",
			status: "paused",
		})

		const [record] = await listCardExecutionRecords(workspaceRoot)
		assert.equal(record.status, "paused")
		assert.deepEqual(record.active_run_ids, [])
	})

	it("binds a Tasktronaut task history id for exact resume", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		createdWorkspaces.push(workspaceRoot)

		await queueCardExecutionRequest({
			workspaceRoot,
			cardId: "phase-4",
			board: "roadmap",
			actorId: "actor-4",
			phaseNumber: "4",
			wave: 4,
			command: "/gsd-execute-phase 4",
			sourceRef: ".planning/ROADMAP.md",
			eventId: "evt-phase-4",
		})

		await bindCardExecutionTaskHistory({
			workspaceRoot,
			cardId: "phase-4",
			board: "roadmap",
			taskHistoryId: "task-history-42",
		})

		const [record] = await listCardExecutionRecords(workspaceRoot)
		assert.equal(record.task_history_id, "task-history-42")
	})

	it("records review-ready and verified lifecycle evidence for owned cards", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		createdWorkspaces.push(workspaceRoot)

		await queueCardExecutionRequest({
			workspaceRoot,
			cardId: "phase-5",
			board: "roadmap",
			actorId: "actor-5",
			phaseNumber: "5",
			wave: 5,
			command: "/gsd-execute-phase 5",
			sourceRef: ".planning/ROADMAP.md",
			eventId: "evt-phase-5",
		})

		await setCardExecutionLifecycleState({
			workspaceRoot,
			cardId: "phase-5",
			board: "roadmap",
			status: "ready_for_review",
			reviewNote: "Executor believes acceptance evidence is complete.",
		})

		let [record] = await listCardExecutionRecords(workspaceRoot)
		assert.equal(record.status, "ready_for_review")
		assert.equal(record.review_note, "Executor believes acceptance evidence is complete.")
		assert.ok(record.review_requested_at_unix_ms)
		assert.equal(record.review_history?.at(-1)?.event, "ready_for_review")
		assert.equal(record.review_history?.at(-1)?.run_id, undefined)

		await setCardExecutionLifecycleState({
			workspaceRoot,
			cardId: "phase-5",
			board: "roadmap",
			status: "verified",
		})

		;[record] = await listCardExecutionRecords(workspaceRoot)
		assert.equal(record.status, "verified")
		assert.ok(record.verified_at_unix_ms)
		assert.equal(record.review_note, "Executor believes acceptance evidence is complete.")
		assert.equal(record.review_history?.at(-1)?.event, "verified")
	})

	it("records a changes-requested review state with reviewer feedback", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		createdWorkspaces.push(workspaceRoot)

		await queueCardExecutionRequest({
			workspaceRoot,
			cardId: "phase-5b",
			board: "roadmap",
			actorId: "actor-5",
			phaseNumber: "5",
			wave: 5,
			command: "/gsd-execute-phase 5",
			sourceRef: ".planning/ROADMAP.md",
			eventId: "evt-phase-5b",
		})

		await setCardExecutionLifecycleState({
			workspaceRoot,
			cardId: "phase-5b",
			board: "roadmap",
			status: "changes_requested",
			reviewNote: "Please tighten the acceptance evidence and revisit the failing edge case.",
		})

		const [record] = await listCardExecutionRecords(workspaceRoot)
		assert.equal(record.status, "changes_requested")
		assert.equal(record.review_note, "Please tighten the acceptance evidence and revisit the failing edge case.")
		assert.equal(record.review_history?.at(-1)?.event, "changes_requested")
	})

	it("records file-scoped review comment history on the owned execution", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		createdWorkspaces.push(workspaceRoot)

		await queueCardExecutionRequest({
			workspaceRoot,
			cardId: "phase-5c",
			board: "roadmap",
			actorId: "actor-5",
			phaseNumber: "5",
			wave: 5,
			command: "/gsd-execute-phase 5",
			sourceRef: ".planning/ROADMAP.md",
			eventId: "evt-phase-5c",
		})

		await setCardExecutionLifecycleState({
			workspaceRoot,
			cardId: "phase-5c",
			board: "roadmap",
			status: "review",
			reviewEvent: "review_comment",
			reviewNote: "Please simplify this branch and tighten the guard.",
			reviewFilePath: "src/main.ts",
			reviewStartLine: 12,
			reviewEndLine: 18,
		})

		const [record] = await listCardExecutionRecords(workspaceRoot)
		assert.equal(record.review_history?.at(-1)?.event, "review_comment")
		assert.equal(record.review_history?.at(-1)?.note, "Please simplify this branch and tighten the guard.")
		assert.equal(record.review_history?.at(-1)?.file_path, "src/main.ts")
		assert.equal(record.review_history?.at(-1)?.start_line, 12)
		assert.equal(record.review_history?.at(-1)?.end_line, 18)
	})

	it("records delivery request history on the owned execution", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		createdWorkspaces.push(workspaceRoot)

		await queueCardExecutionRequest({
			workspaceRoot,
			cardId: "phase-5d",
			board: "roadmap",
			actorId: "actor-5",
			phaseNumber: "5",
			wave: 5,
			command: "/gsd-execute-phase 5",
			sourceRef: ".planning/ROADMAP.md",
			eventId: "evt-phase-5d",
		})

	await recordCardExecutionDeliveryEvent({
		workspaceRoot,
		cardId: "phase-5d",
		board: "roadmap",
		deliveryEvent: "pr_requested",
		deliveryNote: "Opened the existing pull request for tasktronaut/phase-5 after human confirmation.",
		branchName: "tasktronaut/phase-5",
		worktreePath: path.join(workspaceRoot, ".tasktronaut", "worktrees", "phase-5"),
		deliveryReadiness: "clean",
		pullRequestNumber: 42,
		pullRequestUrl: "https://github.com/example/tasktronaut/pull/42",
		pullRequestState: "OPEN",
		pullRequestMergeStatus: "CLEAN",
		pullRequestIsDraft: false,
	})

	const [record] = await listCardExecutionRecords(workspaceRoot)
	assert.equal(record.delivery_note, "Opened the existing pull request for tasktronaut/phase-5 after human confirmation.")
	assert.equal(record.delivery_history?.at(-1)?.event, "pr_requested")
	assert.equal(record.delivery_history?.at(-1)?.branch_name, "tasktronaut/phase-5")
	assert.equal(record.delivery_history?.at(-1)?.readiness, "clean")
	assert.equal(record.pull_request_number, 42)
	assert.equal(record.pull_request_url, "https://github.com/example/tasktronaut/pull/42")
	assert.equal(record.pull_request_state, "OPEN")
	assert.equal(record.pull_request_merge_status, "CLEAN")
	assert.equal(record.pull_request_is_draft, false)
	})

	it("captures changed files and diff summary from the owned worktree", async function () {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		createdWorkspaces.push(workspaceRoot)
		const worktreePath = workspaceRoot

		try {
			await execFileAsync("git", ["init"], { cwd: workspaceRoot })
		} catch {
			this.skip()
			return
		}

		await fs.writeFile(path.join(workspaceRoot, "tracked.txt"), "initial\n", "utf8")
		await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspaceRoot })
		await execFileAsync(
			"git",
			["-c", "user.name=Tasktronaut", "-c", "user.email=tasktronaut@example.com", "commit", "-m", "initial"],
			{ cwd: workspaceRoot },
		)

		await fs.writeFile(path.join(worktreePath, "tracked.txt"), "initial\nchanged\n", "utf8")
		await fs.writeFile(path.join(worktreePath, "notes.md"), "# review me\n", "utf8")

		await queueCardExecutionRequest({
			workspaceRoot,
			cardId: "phase-6",
			board: "roadmap",
			actorId: "actor-6",
			phaseNumber: "6",
			wave: 6,
			command: "/gsd-execute-phase 6",
			sourceRef: ".planning/ROADMAP.md",
			eventId: "evt-phase-6",
		})

		await registerSubagentExecution({
			workspaceRoot,
			runId: "run-review-evidence",
			taskUlid: "task-6",
			agentName: "gsd-executor",
			phaseNumber: "6",
			planId: "06-01",
			role: "worker",
			isolation: "worktree",
			baseWorkspaceCwd: workspaceRoot,
			executionCwd: worktreePath,
			worktreePath,
			branchName: "tasktronaut/phase-6",
			prompt: "Execute phase 6 plan 06-01",
		})

		const [record] = await listCardExecutionRecords(workspaceRoot)
		assert.ok(record.changed_files?.includes("tracked.txt"))
		assert.ok(record.changed_files?.includes("notes.md"))
		assert.ok(record.file_diffs?.some((file) => file.path === "tracked.txt" && /modified|changed/u.test(file.status)))
		assert.ok(record.file_diffs?.some((file) => file.path === "notes.md" && /added|untracked/u.test(file.status)))
		assert.ok((record.file_diffs?.find((file) => file.path === "tracked.txt")?.start_line ?? -1) >= 0)
		assert.ok(
			(record.file_diffs?.find((file) => file.path === "tracked.txt")?.end_line ?? -1) >=
				(record.file_diffs?.find((file) => file.path === "tracked.txt")?.start_line ?? 0),
		)
		assert.equal(record.file_diffs?.find((file) => file.path === "notes.md")?.start_line, 0)
		assert.match(record.file_diffs?.find((file) => file.path === "tracked.txt")?.diff_excerpt || "", /tracked\.txt|changed/i)
		assert.match(record.file_diffs?.find((file) => file.path === "notes.md")?.diff_excerpt || "", /New file preview|review me/i)
		assert.match(record.diff_summary || "", /file|insertions?|deletions?|changed/i)
		assert.match(record.diff_excerpt || "", /tracked\.txt|changed/i)
	})

	it("captures native checkpoint identity from the bound task history", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-subagent-registry-"))
		const globalStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-global-storage-"))
		createdWorkspaces.push(workspaceRoot, globalStorageRoot)
		setVscodeHostProviderMock({ globalStorageFsPath: globalStorageRoot })

		await queueCardExecutionRequest({
			workspaceRoot,
			cardId: "phase-4",
			board: "stage",
			actorId: "actor-4",
			phaseNumber: "4",
			wave: 4,
			command: "/gsd-execute-phase 4",
			sourceRef: ".planning/PLANS/04-EXECUTE.md",
			eventId: "evt-phase-4",
		})

		const taskHistoryId = "task-checkpointed"
		const taskDir = path.join(globalStorageRoot, "tasks", taskHistoryId)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(
			path.join(taskDir, GlobalFileNames.uiMessages),
			JSON.stringify([
				{ ts: 1000, type: "say", say: "text", text: "No checkpoint yet." },
				{ ts: 2345, type: "say", say: "checkpoint_created", lastCheckpointHash: "abc123hash" },
			]),
		)

		await bindCardExecutionTaskHistory({
			workspaceRoot,
			cardId: "phase-4",
			board: "stage",
			taskHistoryId,
		})

		const [record] = await listCardExecutionRecords(workspaceRoot)
		assert.equal(record.task_history_id, taskHistoryId)
		assert.equal(record.native_checkpoint_hash, "abc123hash")
		assert.equal(record.native_checkpoint_message_ts, 2345)
	})
})
