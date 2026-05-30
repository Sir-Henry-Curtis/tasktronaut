import assert from "node:assert/strict"
import { describe, it } from "mocha"
import {
	isLikelyLongRunningCommand,
	normalizeManagedGsdSdkCommand,
	resolveCommandTimeoutSeconds,
} from "../ExecuteCommandToolHandler"

describe("ExecuteCommandToolHandler timeout policy", () => {
	it("returns undefined when managed timeout is disabled", () => {
		const timeout = resolveCommandTimeoutSeconds("npm test", undefined, false)
		assert.equal(timeout, undefined)
	})

	it("uses explicit timeout when provided", () => {
		const timeout = resolveCommandTimeoutSeconds("npm test", "45", true)
		assert.equal(timeout, 45)
	})

	it("falls back to default timeout for short commands", () => {
		const timeout = resolveCommandTimeoutSeconds("ls -la", undefined, true)
		assert.equal(timeout, 30)
	})

	it("uses extended timeout for known long-running commands", () => {
		const timeout = resolveCommandTimeoutSeconds("npm run build", undefined, true)
		assert.equal(timeout, 300)
	})

	it("detects common long-running command families", () => {
		assert.equal(isLikelyLongRunningCommand("cargo build --release"), true)
		assert.equal(isLikelyLongRunningCommand("docker build ."), true)
		assert.equal(isLikelyLongRunningCommand("pytest -q"), true)
	})
})

describe("ExecuteCommandToolHandler managed GSD SDK command normalization", () => {
	it("rewrites bare gsd-sdk to the Windows workspace launcher", () => {
		assert.equal(
			normalizeManagedGsdSdkCommand("gsd-sdk query init.new-project", "win32"),
			".tasktronaut\\bin\\gsd-sdk.cmd query init.new-project",
		)
	})

	it("rewrites POSIX-style managed gsd-sdk paths to the Windows workspace launcher", () => {
		assert.equal(
			normalizeManagedGsdSdkCommand(".tasktronaut/bin/gsd-sdk query commit \"docs: map\" --files .planning/codebase", "win32"),
			'.tasktronaut\\bin\\gsd-sdk.cmd query commit "docs: map" --files .planning/codebase',
		)
	})

	it("leaves non-GSD commands unchanged", () => {
		assert.equal(normalizeManagedGsdSdkCommand("cargo test", "win32"), "cargo test")
	})
})
