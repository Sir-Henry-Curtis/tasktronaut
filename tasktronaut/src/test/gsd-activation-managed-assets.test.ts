import { readFile } from "fs/promises"
import path from "path"
import { describe, it } from "mocha"
import "should"
import * as vscode from "vscode"
import { verifyManagedAssetsForWorkspace } from "@/gsd/GsdInstaller"

const packagePath = path.join(__dirname, "..", "..", "package.json")
const staleManagedAsset = "// stale managed asset seeded before extension startup\n"

describe("GSD activation managed assets", () => {
	const workspacePath = path.resolve(__dirname, "..", "..", "..", "test-workspace")
	const managedDir = path.join(workspacePath, ".tasktronaut")
	const stalePatterns = ["- web_search", "gsd-sdk query websearch", "use built-in WebSearch tool instead"]

	it("installs and verifies managed GSD assets during extension activation", async () => {
		const packageJson = JSON.parse(await readFile(packagePath, "utf8"))
		const extensionId = `${packageJson.publisher}.${packageJson.name}`
		const extension = vscode.extensions.getExtension(extensionId)

		should.exist(extension)
		await extension?.activate()

		const manifestPath = path.join(managedDir, "managed-manifest.json")
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
		manifest.assets.should.be.an.Array()
		manifest.assets.length.should.be.greaterThan(0)

		const verification = await verifyManagedAssetsForWorkspace(workspacePath)
		verification.ok.should.equal(true)
		verification.assetCount.should.equal(manifest.assets.length)
		verification.mismatches.should.have.length(0)
	})

	it("repairs stale managed GSD assets during extension activation", async () => {
		const packageJson = JSON.parse(await readFile(packagePath, "utf8"))
		const extensionId = `${packageJson.publisher}.${packageJson.name}`
		const extension = vscode.extensions.getExtension(extensionId)

		should.exist(extension)
		await extension?.activate()

		const gsdSdkPath = path.join(managedDir, "bin", "gsd-sdk.js")
		const gsdSdkContent = await readFile(gsdSdkPath, "utf8")
		gsdSdkContent.should.not.equal(staleManagedAsset)

		const refreshedAgentPath = path.join(managedDir, "agents", "gsd-project-researcher.md")
		const refreshedAgentContent = await readFile(refreshedAgentPath, "utf8")
		for (const pattern of stalePatterns) {
			refreshedAgentContent.includes(pattern).should.equal(false)
		}

		const verification = await verifyManagedAssetsForWorkspace(workspacePath)
		verification.ok.should.equal(true)
		verification.mismatches.should.have.length(0)
	})
})
