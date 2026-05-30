import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "mocha"
import {
	getCheckpointStorageRoot,
	getShadowGitPath,
	hashWorkingDir,
	migrateLegacyCheckpointRoot,
} from "@/integrations/checkpoints/CheckpointUtils"
import { setVscodeHostProviderMock } from "./host-provider-test-utils"

describe("checkpoint storage path", () => {
	const originalCheckpointDir = process.env.TASKTRONAUT_CHECKPOINTS_DIR

	afterEach(() => {
		if (originalCheckpointDir === undefined) {
			delete process.env.TASKTRONAUT_CHECKPOINTS_DIR
		} else {
			process.env.TASKTRONAUT_CHECKPOINTS_DIR = originalCheckpointDir
		}
	})

	it("stores shadow Git repos outside host globalStorage", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tasktronaut-checkpoints-"))
		const globalStoragePath = path.join(tempRoot, "theia-globalStorage")
		const checkpointStoragePath = path.join(tempRoot, "tasktronaut-data")
		process.env.TASKTRONAUT_CHECKPOINTS_DIR = checkpointStoragePath
		setVscodeHostProviderMock({ globalStorageFsPath: globalStoragePath })

		const cwdHash = hashWorkingDir(path.join(tempRoot, "workspace"))
		const gitPath = await getShadowGitPath(cwdHash)

		assert.equal(getCheckpointStorageRoot(), checkpointStoragePath)
		assert.equal(gitPath, path.join(checkpointStoragePath, "checkpoints", cwdHash, ".git"))
		assert.ok(!gitPath.startsWith(globalStoragePath), "checkpoint .git path must not live under host globalStorage")
	})

	it("migrates legacy globalStorage checkpoint workspaces to the Tasktronaut data directory", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tasktronaut-checkpoints-"))
		const globalStoragePath = path.join(tempRoot, "theia-globalStorage")
		const checkpointStoragePath = path.join(tempRoot, "tasktronaut-data")
		process.env.TASKTRONAUT_CHECKPOINTS_DIR = checkpointStoragePath
		setVscodeHostProviderMock({ globalStorageFsPath: globalStoragePath })

		const cwdHash = hashWorkingDir(path.join(tempRoot, "workspace"))
		const legacyGitPath = path.join(globalStoragePath, "checkpoints", cwdHash, ".git")
		await mkdir(legacyGitPath, { recursive: true })
		await writeFile(path.join(legacyGitPath, "HEAD"), "ref: refs/heads/main\n", "utf8")

		const migratedGitPath = await getShadowGitPath(cwdHash)

		assert.equal(migratedGitPath, path.join(checkpointStoragePath, "checkpoints", cwdHash, ".git"))
		assert.equal(await readFile(path.join(migratedGitPath, "HEAD"), "utf8"), "ref: refs/heads/main\n")
		await assert.rejects(stat(legacyGitPath))
	})

	it("migrates the legacy globalStorage checkpoint root on startup", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tasktronaut-checkpoints-"))
		const globalStoragePath = path.join(tempRoot, "theia-globalStorage")
		const checkpointStoragePath = path.join(tempRoot, "tasktronaut-data")
		process.env.TASKTRONAUT_CHECKPOINTS_DIR = checkpointStoragePath
		setVscodeHostProviderMock({ globalStorageFsPath: globalStoragePath })

		const cwdHash = hashWorkingDir(path.join(tempRoot, "workspace"))
		const legacyGitPath = path.join(globalStoragePath, "checkpoints", cwdHash, ".git")
		await mkdir(legacyGitPath, { recursive: true })
		await writeFile(path.join(legacyGitPath, "HEAD"), "ref: refs/heads/main\n", "utf8")

		const result = await migrateLegacyCheckpointRoot()
		const migratedGitPath = path.join(checkpointStoragePath, "checkpoints", cwdHash, ".git")

		assert.deepEqual(result, { migrated: 1, failed: 0 })
		assert.equal(await readFile(path.join(migratedGitPath, "HEAD"), "utf8"), "ref: refs/heads/main\n")
		await assert.rejects(stat(legacyGitPath))
	})
})
