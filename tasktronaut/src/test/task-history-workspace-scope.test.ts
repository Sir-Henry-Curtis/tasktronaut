import { strict as assert } from "node:assert"
import { historyItemMatchesWorkspace } from "../core/controller/task/getTaskHistory"
import type { HistoryItem } from "../shared/HistoryItem"

const makeHistoryItem = (overrides: Partial<HistoryItem>): HistoryItem => ({
	id: "task-1",
	ts: Date.now(),
	task: "test task",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...overrides,
})

describe("task history workspace scoping", () => {
	it("matches tasks by cwd captured at task initialization", () => {
		const item = makeHistoryItem({ cwdOnTaskInitialization: "/workspace/project-a" })

		assert.equal(historyItemMatchesWorkspace(item, "/workspace/project-a"), true)
		assert.equal(historyItemMatchesWorkspace(item, "/workspace/project-b"), false)
	})

	it("matches older checkpointed tasks by shadow worktree path", () => {
		const item = makeHistoryItem({ shadowGitConfigWorkTree: "/workspace/project-a" })

		assert.equal(historyItemMatchesWorkspace(item, "/workspace/project-a"), true)
		assert.equal(historyItemMatchesWorkspace(item, "/workspace/project-b"), false)
	})

	it("does not show unscoped global history in a workspace-specific view", () => {
		const item = makeHistoryItem({})

		assert.equal(historyItemMatchesWorkspace(item, "/workspace/project-a"), false)
		assert.equal(historyItemMatchesWorkspace(item, undefined), false)
	})
})
