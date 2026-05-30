import { defineConfig } from "@vscode/test-cli"
import { existsSync } from "fs"
import path from "path"
const vscodeTestVersion = process.env.VSCODE_TEST_VERSION ?? "stable"
const localCodePath = process.env.VSCODE_EXECUTABLE_PATH || (existsSync("/usr/bin/code") ? "/usr/bin/code" : undefined)

export default defineConfig({
	files: "{out/**/*.test.js,src/**/*.test.js,!src/test/e2e/**/*.test.js,!out/src/test/e2e/**/*.test.js}",
	mocha: {
		ui: "bdd",
		timeout: 20000, // Maximum time (in ms) that a test can run before failing
		/** Set up alias path resolution during tests
		 * @See {@link file://./test-setup.js}
		 */
		require: ["./test-setup.js"],
	},
	workspaceFolder: "test-workspace",
	version: vscodeTestVersion,
	useInstallation: localCodePath ? { fromPath: localCodePath } : undefined,
	extensionDevelopmentPath: path.resolve("./"),
	launchArgs: ["--disable-extensions"],
})
