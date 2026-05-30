import { mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { afterEach, describe, it } from "mocha"
import "should"
import * as vscode from "vscode"
import { verifyManagedAssetsForWorkspace } from "@/gsd/GsdInstaller"

const COMMAND_ID = "tasktronaut.gsd.verifyManagedAssets"

describe("GSD managed assets", () => {
	const workspacePath = path.resolve(__dirname, "..", "..", "..", "test-workspace")
	const managedDir = path.join(workspacePath, ".tasktronaut")
	const rulesDir = path.join(workspacePath, ".tasktronautrules")

	afterEach(async () => {
		await rm(managedDir, { recursive: true, force: true })
		await rm(rulesDir, { recursive: true, force: true })
	})

	it("refreshes and verifies managed GSD assets in the VS Code runtime", async () => {
		await mkdir(workspacePath, { recursive: true })

		await vscode.commands.executeCommand(COMMAND_ID)

		const manifestPath = path.join(managedDir, "managed-manifest.json")
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
		manifest.assets.should.be.an.Array()
		manifest.assets.length.should.be.greaterThan(0)

		const verification = await verifyManagedAssetsForWorkspace(workspacePath)
		verification.ok.should.equal(true)
		verification.assetCount.should.equal(manifest.assets.length)
		verification.mismatches.should.have.length(0)
	})

	it("repairs drifted managed GSD assets in the VS Code runtime", async () => {
		await mkdir(workspacePath, { recursive: true })

		await vscode.commands.executeCommand(COMMAND_ID)

		const driftedAssetPath = path.join(managedDir, "bin", "gsd-sdk.js")
		await writeFile(driftedAssetPath, "// drifted test asset\n", "utf8")

		const driftedVerification = await verifyManagedAssetsForWorkspace(workspacePath)
		driftedVerification.ok.should.equal(false)
		driftedVerification.mismatches.some((mismatch) => mismatch.path === path.join(".tasktronaut", "bin", "gsd-sdk.js")).should.equal(
			true,
		)

		await vscode.commands.executeCommand(COMMAND_ID)

		const repairedVerification = await verifyManagedAssetsForWorkspace(workspacePath)
		repairedVerification.ok.should.equal(true)
		repairedVerification.mismatches.should.have.length(0)
	})
})
