import path from "node:path"
import process from "node:process"
import { installGsdToWorkspace, verifyManagedAssetsForWorkspace } from "../src/gsd/GsdInstaller.ts"

async function main() {
	const workspacePath = path.resolve(process.argv[2] || process.cwd())

	await installGsdToWorkspace(workspacePath)
	const verification = await verifyManagedAssetsForWorkspace(workspacePath)

	process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`)

	if (!verification.ok) {
		process.exitCode = 1
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
	process.exit(1)
})
