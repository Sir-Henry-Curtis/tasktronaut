const { execFile } = require("child_process")
const { mkdir, rm, writeFile } = require("fs/promises")
const path = require("path")
const { promisify } = require("util")
const { afterEach, describe, it } = require("mocha")
require("should")
const vscode = require("vscode")

const execFileAsync = promisify(execFile)
const VERIFY_COMMAND_ID = "tasktronaut.gsd.verifyManagedAssets"

describe("GSD workflow reliability", () => {
	const workspacePath = path.resolve(__dirname, "..", "..", "..", "test-workspace")
	const managedDir = path.join(workspacePath, ".tasktronaut")
	const rulesDir = path.join(workspacePath, ".tasktronautrules")
	const planningDir = path.join(workspacePath, ".planning")

	afterEach(async () => {
		await rm(planningDir, { recursive: true, force: true })
		await rm(managedDir, { recursive: true, force: true })
		await rm(rulesDir, { recursive: true, force: true })
	})

	async function writeWorkspaceFile(relativePath, content) {
		const targetPath = path.join(workspacePath, relativePath)
		await mkdir(path.dirname(targetPath), { recursive: true })
		await writeFile(targetPath, content, "utf8")
	}

	async function queryNextAction() {
		const gsdSdkPath = path.join(workspacePath, ".tasktronaut", "bin", "gsd-sdk.js")
		const { stdout } = await execFileAsync(process.execPath, [gsdSdkPath, "query", "route.next-action"], {
			cwd: workspacePath,
		})
		return JSON.parse(stdout)
	}

	it("routes discuss, plan, execute, verify, and completion in the managed runtime", async () => {
		await mkdir(workspacePath, { recursive: true })
		await vscode.commands.executeCommand(VERIFY_COMMAND_ID)

		await writeWorkspaceFile(
			".planning/STATE.md",
			`---
current_phase: "01"
status: active
---
`,
		)

		await writeWorkspaceFile(
			".planning/ROADMAP.md",
			`# Roadmap

## Milestone v0.1

### Phase 01: Discovery
**Goal:** Validate the first delivery loop

- [ ] **Phase 01: Discovery**
`,
		)

		await writeWorkspaceFile(".planning/phases/01-discovery/README.md", "# Phase 01\n")

		const discuss = await queryNextAction()
		discuss.command.should.equal("/gsd-discuss-phase")
		discuss.args.should.equal("01")
		discuss.reason.should.match(/No CONTEXT\.md or RESEARCH\.md/i)

		await writeWorkspaceFile(
			".planning/phases/01-discovery/01-CONTEXT.md",
			`# Context

This phase has context but no plans yet.
`,
		)

		const plan = await queryNextAction()
		plan.command.should.equal("/gsd-plan-phase")
		plan.args.should.equal("01")
		plan.reason.should.match(/no PLAN\.md files/i)

		await writeWorkspaceFile(
			".planning/phases/01-discovery/01-01-PLAN.md",
			`---
wave: 1
---

# Plan

<task type="implementation">
Ship the first slice.
</task>
`,
		)

		const execute = await queryNextAction()
		execute.command.should.equal("/gsd-execute-phase")
		execute.args.should.equal("01")
		execute.reason.should.match(/still need SUMMARY\.md/i)

		await writeWorkspaceFile(
			".planning/phases/01-discovery/01-01-SUMMARY.md",
			`# Summary

Implementation finished for the only plan.
`,
		)

		const verify = await queryNextAction()
		verify.command.should.equal("/gsd-verify-work")
		verify.args.should.equal("")
		verify.reason.should.match(/run verification/i)

		await writeWorkspaceFile(
			".planning/phases/01-discovery/01-VERIFICATION.md",
			`| Check | Status | Notes |
| --- | --- | --- |
| Routing | PASS | Good |
`,
		)

		const complete = await queryNextAction()
		complete.command.should.equal("/gsd-complete-milestone")
		complete.args.should.equal("")
		complete.reason.should.match(/complete milestone/i)
	})

	it("routes paused, blocked, error, and next-phase advancement states in the managed runtime", async () => {
		await mkdir(workspacePath, { recursive: true })
		await vscode.commands.executeCommand(VERIFY_COMMAND_ID)

		await writeWorkspaceFile(
			".planning/ROADMAP.md",
			`# Roadmap

## Milestone v0.2

### Phase 01: Discovery
**Goal:** Validate the first delivery loop

- [x] **Phase 01: Discovery**

### Phase 02: Delivery
**Goal:** Continue the milestone after verification

- [ ] **Phase 02: Delivery**
`,
		)

		await writeWorkspaceFile(
			".planning/phases/01-discovery/01-CONTEXT.md",
			`# Context

Phase 01 context
`,
		)
		await writeWorkspaceFile(
			".planning/phases/01-discovery/01-01-PLAN.md",
			`---
wave: 1
---

# Plan

<task type="implementation">
Finish the validated slice.
</task>
`,
		)
		await writeWorkspaceFile(
			".planning/phases/01-discovery/01-01-SUMMARY.md",
			`# Summary

Validated summary.
`,
		)
		await writeWorkspaceFile(
			".planning/phases/01-discovery/01-VERIFICATION.md",
			`| Check | Status | Notes |
| --- | --- | --- |
| Routing | PASS | Good |
`,
		)
		await writeWorkspaceFile(".planning/phases/02-delivery/README.md", "# Phase 02\n")

		await writeWorkspaceFile(
			".planning/STATE.md",
			`---
current_phase: "01"
status: active
paused_at: "2026-05-10T12:00:00.000Z"
---
`,
		)

		const paused = await queryNextAction()
		paused.command.should.equal("/gsd-resume-work")
		paused.reason.should.match(/Paused - resume work/i)

		await writeWorkspaceFile(
			".planning/STATE.md",
			`---
current_phase: "01"
status: active
---
`,
		)
		await writeWorkspaceFile(".planning/.continue-here.md", "Continue here before doing anything else.\n")

		const blockedByContinueHere = await queryNextAction()
		blockedByContinueHere.command.should.equal("")
		blockedByContinueHere.reason.should.match(/Blocked: \.planning\/\.continue-here\.md exists/i)

		await rm(path.join(workspacePath, ".planning", ".continue-here.md"), { force: true })

		await writeWorkspaceFile(
			".planning/STATE.md",
			`---
current_phase: "01"
status: failed
---
`,
		)

		const blockedByError = await queryNextAction()
		blockedByError.command.should.equal("")
		blockedByError.reason.should.match(/Blocked: STATE\.md status is error or failed/i)

		await writeWorkspaceFile(
			".planning/STATE.md",
			`---
current_phase: "01"
status: active
---
`,
		)

		const nextPhase = await queryNextAction()
		nextPhase.command.should.equal("/gsd-discuss-phase")
		nextPhase.args.should.equal("02")
		nextPhase.current_phase.should.equal("02")
		nextPhase.reason.should.match(/advance to next phase/i)
	})
})
