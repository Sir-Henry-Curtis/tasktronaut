const { execFile } = require("child_process")
const { mkdir, readFile, rm, writeFile } = require("fs/promises")
const path = require("path")
const { promisify } = require("util")
const { afterEach, describe, it } = require("mocha")
require("should")
const vscode = require("vscode")

const execFileAsync = promisify(execFile)
const VERIFY_COMMAND_ID = "tasktronaut.gsd.verifyManagedAssets"

describe("GSD helper tail runtime", () => {
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
		return targetPath
	}

	async function queryManagedSdk(...args) {
		const gsdSdkPath = path.join(workspacePath, ".tasktronaut", "bin", "gsd-sdk.js")
		const { stdout } = await execFileAsync(process.execPath, [gsdSdkPath, "query", ...args], {
			cwd: workspacePath,
			env: {
				...process.env,
				HOME: workspacePath,
			},
		})
		return JSON.parse(stdout)
	}

	it("runtime-verifies learnings, intel, and planning helper queries through the managed sdk", async () => {
		await mkdir(workspacePath, { recursive: true })
		await vscode.commands.executeCommand(VERIFY_COMMAND_ID)

		await writeWorkspaceFile(
			".planning/config.json",
			JSON.stringify(
				{
					intel: {
						enabled: true,
					},
				},
				null,
				2,
			),
		)

		await writeWorkspaceFile(
			".planning/LEARNINGS.md",
			`# Learnings

## Caching Strategies
Prefer deterministic cache keys and short TTLs for volatile data.

## Session Recovery
Preserve explicit resume markers so paused work can be restored safely.
`,
		)

		await writeWorkspaceFile(
			".planning/phases/03-research/03-01-PLAN.md",
			`---
phase: "03"
plan: "03-01"
wave: 2
autonomous: false
depends_on:
  - "02-01"
---

# Plan

<task type="implementation">
  <name>Capture baseline state</name>
</task>

<task type="checkpoint">
  <name>Review captured evidence</name>
</task>
`,
		)

		await writeWorkspaceFile(
			".planning/intel/files.json",
			JSON.stringify(
				{
					_meta: {
						updated_at: "2026-05-10T10:00:00.000Z",
						version: 1,
					},
					files: [{ path: "src/example-module.js", summary: "example adapter entrypoint" }],
				},
				null,
				2,
			) + "\n",
		)
		await writeWorkspaceFile(
			".planning/intel/apis.json",
			JSON.stringify(
				{
					_meta: {
						updated_at: "2026-05-10T10:00:00.000Z",
						version: 1,
					},
					apis: [{ name: "adapter-api", summary: "adapter contract" }],
				},
				null,
				2,
			) + "\n",
		)
		await writeWorkspaceFile(
			".planning/intel/deps.json",
			JSON.stringify(
				{
					_meta: {
						updated_at: "2026-05-10T10:00:00.000Z",
						version: 1,
					},
					deps: [{ name: "serde", reason: "serialization" }],
				},
				null,
				2,
			) + "\n",
		)
		await writeWorkspaceFile(".planning/intel/arch.md", "# Architecture\n\nThe adapter layer owns request normalization.\n")
		await writeWorkspaceFile(
			".planning/intel/stack.json",
			JSON.stringify(
				{
					_meta: {
						updated_at: "2026-05-10T10:00:00.000Z",
						version: 1,
					},
					stack: ["node", "typescript"],
				},
				null,
				2,
			) + "\n",
		)
		await writeWorkspaceFile(
			"src/example-module.js",
			`module.exports = {
  alpha,
  beta: helper,
}
exports.gamma = gamma
`,
		)

		const copied = await queryManagedSdk("learnings.copy")
		copied.copied.should.equal(true)
		copied.created.should.equal(2)

		const listed = await queryManagedSdk("learnings.list")
		listed.count.should.equal(2)
		listed.learnings.map((entry) => entry.context).should.containEql("Caching Strategies")

		const queried = await queryManagedSdk("learnings.query", "--tag", "caching", "--limit", "1")
		queried.count.should.equal(1)
		queried.learnings[0].context.should.equal("Caching Strategies")

		const staleRecordPath = path.join(workspacePath, ".tasktronaut", "gsd", "knowledge", `${listed.learnings[0].id}.json`)
		const staleRecord = JSON.parse(await readFile(staleRecordPath, "utf8"))
		staleRecord.date = "2020-01-01T00:00:00.000Z"
		await writeFile(staleRecordPath, JSON.stringify(staleRecord, null, 2), "utf8")

		const pruned = await queryManagedSdk("learnings.prune", "--older-than", "30d")
		pruned.removed.should.equal(1)

		const remaining = await queryManagedSdk("learnings.list")
		remaining.count.should.equal(1)

		const deleted = await queryManagedSdk("learnings.delete", remaining.learnings[0].id)
		deleted.deleted.should.equal(true)

		const intelStatus = await queryManagedSdk("intel.status")
		intelStatus.overall_stale.should.equal(false)
		intelStatus.files["files.json"].exists.should.equal(true)
		intelStatus.files["arch.md"].exists.should.equal(true)

		const intelSnapshot = await queryManagedSdk("intel.snapshot")
		intelSnapshot.saved.should.equal(true)
		intelSnapshot.files.should.equal(5)

		const intelQuery = await queryManagedSdk("intel.query", "adapter")
		intelQuery.total.should.be.greaterThan(0)

		const intelExports = await queryManagedSdk("intel.extract-exports", "src/example-module.js")
		intelExports.exports.should.containEql("alpha")
		intelExports.exports.should.containEql("gamma")

		const intelPatched = await queryManagedSdk("intel.patch-meta", ".planning/intel/files.json")
		intelPatched.patched.should.equal(true)

		const intelValidate = await queryManagedSdk("intel.validate")
		intelValidate.valid.should.equal(true)

		const intelUpdate = await queryManagedSdk("intel.update")
		intelUpdate.action.should.equal("spawn_agent")

		const listedPlans = await queryManagedSdk("phase.list-plans", "03", "--with-schema", "wave")
		listedPlans.phase.should.equal("03")
		listedPlans.plans.should.have.length(1)
		listedPlans.plans[0].wave.should.equal(2)
		listedPlans.plans[0].autonomous.should.equal(false)

		const planStructure = await queryManagedSdk("plan.task-structure", ".planning/phases/03-research/03-01-PLAN.md")
		planStructure.task_count.should.equal(2)
		planStructure.checkpoint_count.should.equal(1)
		planStructure.depends_on.should.containEql("02-01")
	})

	it("runtime-verifies disabled and invalid helper-tail paths through the managed sdk", async () => {
		await mkdir(workspacePath, { recursive: true })
		await vscode.commands.executeCommand(VERIFY_COMMAND_ID)

		await writeWorkspaceFile(
			".planning/config.json",
			JSON.stringify(
				{
					intel: {
						enabled: false,
					},
				},
				null,
				2,
			),
		)

		const noLearnings = await queryManagedSdk("learnings.copy")
		noLearnings.copied.should.equal(false)
		noLearnings.reason.should.match(/No LEARNINGS\.md found/i)

		const badPrune = await queryManagedSdk("learnings.prune")
		badPrune.error.should.match(/Usage: learnings\.prune/i)

		const badDelete = await queryManagedSdk("learnings.delete", "not-a-real-id")
		badDelete.error.should.match(/Invalid learning ID/i)

		const disabledStatus = await queryManagedSdk("intel.status")
		disabledStatus.disabled.should.equal(true)

		const disabledValidate = await queryManagedSdk("intel.validate")
		disabledValidate.disabled.should.equal(true)

		const disabledUpdate = await queryManagedSdk("intel.update")
		disabledUpdate.disabled.should.equal(true)

		const missingPlans = await queryManagedSdk("phase.list-plans", "99")
		missingPlans.error.should.equal("Phase not found")
		missingPlans.plans.should.have.length(0)

		const missingStructure = await queryManagedSdk("plan.task-structure", ".planning/phases/99-missing/99-01-PLAN.md")
		missingStructure.classification.should.equal("blocked")
		missingStructure.error.should.match(/cannot read plan file/i)
	})
})
