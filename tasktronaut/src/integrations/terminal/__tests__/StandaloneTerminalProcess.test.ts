import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "mocha"
import { StandaloneTerminalProcess } from "../standalone/StandaloneTerminalProcess"
import type { ITerminal } from "../types"

describe("StandaloneTerminalProcess", () => {
	let tempDir: string | undefined

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true })
			tempDir = undefined
		}
	})

	it("prepends workspace .tasktronaut/bin so managed gsd-sdk resolves as a bare command", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tasktronaut-terminal-"))
		const binDir = path.join(tempDir, ".tasktronaut", "bin")
		await fs.mkdir(binDir, { recursive: true })

		if (process.platform === "win32") {
			await fs.writeFile(path.join(binDir, "gsd-sdk.cmd"), "@echo off\r\necho managed-gsd-sdk\r\n", "utf8")
		} else {
			const launcherPath = path.join(binDir, "gsd-sdk")
			await fs.writeFile(launcherPath, "#!/bin/sh\necho managed-gsd-sdk\n", "utf8")
			await fs.chmod(launcherPath, 0o755)
		}

		const terminal = {
			_cwd: tempDir,
			_shellPath: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
		} as unknown as ITerminal
		const processRunner = new StandaloneTerminalProcess()
		const lines: string[] = []
		processRunner.on("line", (line) => {
			if (line) {
				lines.push(line)
			}
		})

		const completed = new Promise<void>((resolve, reject) => {
			processRunner.once("completed", () => resolve())
			processRunner.once("error", reject)
		})
		await processRunner.run(terminal, "gsd-sdk")
		await completed

		const output = [processRunner.getUnretrievedOutput(), ...lines].join("\n")
		const completion = processRunner.getCompletionDetails()
		assert.ok(
			output.includes("managed-gsd-sdk"),
			`expected managed gsd-sdk output, got: ${output}; completion=${JSON.stringify(completion)}`,
		)
	})
})
