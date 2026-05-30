#!/usr/bin/env node
"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")
const vm = require("vm")
const nodeRequire = require

const repoRoot = path.resolve(__dirname, "..")
const sourcePath = path.join(repoRoot, "src", "gsd", "GsdInstaller.ts")
const managedPath = path.resolve(repoRoot, "..", ".tasktronaut", "bin", "gsd-sdk.js")
function fail(message, details) {
	console.error(`[check-gsd-sdk-shim] ${message}`)
	if (details) console.error(details)
	process.exit(1)
}

function extractShimSource(source) {
	const marker = "const GSD_SDK_SHIM = String.raw`"
	const start = source.indexOf(marker)
	if (start < 0) {
		fail("Could not find raw GSD_SDK_SHIM marker in GsdInstaller.ts")
	}

	const bodyStart = start + marker.length
	const endMarker = "\n`\n\nconst GSD_TOOLS_WRAPPER"
	const end = source.indexOf(endMarker, bodyStart)
	if (end < 0) {
		fail("Could not find GSD_SDK_SHIM terminator before GSD_TOOLS_WRAPPER")
	}

	return source.slice(bodyStart, end)
}

function assertNoKnownTemplateEscapeCorruption(content) {
	const corruptionPatterns = [
		{
			name: "literal newline inside single-quoted newline append",
			pattern: /\+\s*'\r?\n'/,
		},
		{
			name: "regex split interrupted by a literal newline",
			pattern: /\.split\(\/\r?\n/,
		},
		{
			name: "regex match interrupted by a literal newline",
			pattern: /\.match\(\/\r?\n/,
		},
		{
			name: "post-shim TypeScript template content leaked into launcher",
			pattern: /^const GSD_TOOLS_WRAPPER\s*=/m,
		},
	]

	for (const { name, pattern } of corruptionPatterns) {
		if (pattern.test(content)) {
			fail(`Detected ${name}`)
		}
	}
}

function assertCompiles(content, filePath) {
	try {
		new vm.Script(content, { filename: filePath })
	} catch (error) {
		fail(`Syntax check failed for ${filePath}`, error && error.stack ? error.stack : String(error))
	}
}

function runShimQuery(content, filePath, query, workspacePath, extraArgs = []) {
	let stdout = ""
	let stderr = ""
	let exitCode = 0
	const script = new vm.Script(content, { filename: filePath })
	const sandboxProcess = {
		argv: ["node", filePath, "query", query, ...extraArgs],
		cwd: () => workspacePath,
		env: { ...process.env },
		platform: process.platform,
		stdout: {
			write: (chunk) => {
				stdout += String(chunk)
				return true
			},
		},
		stderr: {
			write: (chunk) => {
				stderr += String(chunk)
				return true
			},
		},
		exit: (code = 0) => {
			exitCode = Number(code) || 0
			throw new Error(`__TASKTRONAUT_SHIM_EXIT_${exitCode}__`)
		},
	}

	try {
		script.runInNewContext(
			{
				require: nodeRequire,
				process: sandboxProcess,
				console,
				Buffer,
				setTimeout,
				clearTimeout,
				__dirname: path.dirname(filePath),
				__filename: filePath,
			},
			{ timeout: 5000 },
		)
	} catch (error) {
		if (!String(error && error.message ? error.message : error).startsWith("__TASKTRONAUT_SHIM_EXIT_")) {
			fail(`query ${query} threw unexpectedly`, error && error.stack ? error.stack : String(error))
		}
	}

	if (exitCode !== 0) {
		fail(`query ${query} exited with ${exitCode}`, `${stdout}${stderr}`)
	}

	return stdout
}

function assertQuery(content, filePath, query, workspacePath, validate, extraArgs = []) {
	const stdout = runShimQuery(content, filePath, query, workspacePath, extraArgs)
	let payload
	try {
		payload = JSON.parse(stdout)
	} catch (error) {
		fail(`query ${query} did not return JSON`, `${error.message}\n${stdout}`)
	}

	validate(payload)
}

const source = fs.readFileSync(sourcePath, "utf8")
const extractedShim = extractShimSource(source)
assertNoKnownTemplateEscapeCorruption(extractedShim)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tasktronaut-gsd-sdk-"))
const tempShimPath = path.join(tempRoot, "gsd-sdk.js")
const tempWorkspace = path.join(tempRoot, "workspace")
fs.mkdirSync(tempWorkspace, { recursive: true })
fs.writeFileSync(tempShimPath, extractedShim, "utf8")

assertCompiles(extractedShim, tempShimPath)

assertQuery(extractedShim, tempShimPath, "init.new-project", tempWorkspace, (payload) => {
	if (!payload || payload.project_path !== ".planning/PROJECT.md") {
		fail("init.new-project returned an unexpected payload", JSON.stringify(payload, null, 2))
	}
})

const rustWorkspace = path.join(tempRoot, "rust-brownfield")
fs.mkdirSync(path.join(rustWorkspace, "src"), { recursive: true })
fs.writeFileSync(path.join(rustWorkspace, "Cargo.toml"), "[package]\nname = \"brownfield\"\nversion = \"0.1.0\"\n", "utf8")
fs.writeFileSync(path.join(rustWorkspace, "src", "main.rs"), "fn main() {}\n", "utf8")
assertQuery(extractedShim, tempShimPath, "init.new-project", rustWorkspace, (payload) => {
	if (!payload || payload.has_existing_code !== true || payload.is_brownfield !== true || payload.needs_codebase_map !== true) {
		fail("init.new-project failed to detect a Rust brownfield project", JSON.stringify(payload, null, 2))
	}
})

assertQuery(extractedShim, tempShimPath, "init.map-project", rustWorkspace, (payload) => {
	if (!payload || payload.project_kind !== "code" || payload.has_programming_signals !== true || payload.recommended_command !== "/gsd-map-codebase") {
		fail("init.map-project failed to route a Rust project to codebase mapping", JSON.stringify(payload, null, 2))
	}
})

const docsWorkspace = path.join(tempRoot, "docs-project")
fs.mkdirSync(path.join(docsWorkspace, "Contracts"), { recursive: true })
fs.writeFileSync(path.join(docsWorkspace, "Project Brief.docx"), "fake docx fixture\n", "utf8")
fs.writeFileSync(path.join(docsWorkspace, "Contracts", "Statement of Work.pdf"), "fake pdf fixture\n", "utf8")
assertQuery(extractedShim, tempShimPath, "init.map-project", docsWorkspace, (payload) => {
	if (!payload || payload.project_kind !== "documents" || payload.has_document_signals !== true || payload.has_programming_signals !== false) {
		fail("init.map-project failed to classify a document-heavy project", JSON.stringify(payload, null, 2))
	}
	if (!Array.isArray(payload.tree_preview) || !payload.tree_preview.some((line) => String(line).includes("Project Brief.docx"))) {
		fail("init.map-project did not return a useful document tree preview", JSON.stringify(payload, null, 2))
	}
})

assertQuery(extractedShim, tempShimPath, "state.load", tempWorkspace, (payload) => {
	if (!payload || typeof payload !== "object") {
		fail("state.load returned an unexpected payload", JSON.stringify(payload, null, 2))
	}
})

const existingCodebaseDir = path.join(tempWorkspace, ".planning", "codebase")
fs.mkdirSync(existingCodebaseDir, { recursive: true })
fs.writeFileSync(path.join(existingCodebaseDir, "STACK.md"), "# Stack\n\nExisting map.\n", "utf8")
assertQuery(extractedShim, tempShimPath, "init.map-codebase", tempWorkspace, (payload) => {
	if (!payload || payload.has_maps !== true || !Array.isArray(payload.existing_map_details)) {
		fail("init.map-codebase did not return existing map details", JSON.stringify(payload, null, 2))
	}
	const stack = payload.existing_map_details.find((entry) => entry.name === "STACK.md")
	if (!stack || stack.path !== ".planning/codebase/STACK.md" || stack.lines < 1 || stack.bytes < 1) {
		fail("init.map-codebase returned malformed STACK.md details", JSON.stringify(payload, null, 2))
	}
})

const codebaseDir = path.join(tempWorkspace, ".planning", "codebase")
fs.writeFileSync(path.join(codebaseDir, "CONCERNS.md"), "token: sk-testtasktronautshimsecret1234567890\n", "utf8")
const securityStdout = runShimQuery(
	extractedShim,
	tempShimPath,
	"security.scan-for-secrets",
	tempWorkspace,
	["--dir", ".planning/codebase"],
)
let securityPayload
try {
	securityPayload = JSON.parse(securityStdout)
} catch (error) {
	fail(`query security.scan-for-secrets did not return JSON`, `${error.message}\n${securityStdout}`)
}
if (!securityPayload || securityPayload.secrets_found !== true || securityPayload.findings_count < 1) {
	fail("security.scan-for-secrets failed to report a fixture secret", JSON.stringify(securityPayload, null, 2))
}
if (JSON.stringify(securityPayload).includes("sk-testtasktronautshimsecret1234567890")) {
	fail("security.scan-for-secrets returned an unmasked secret value", JSON.stringify(securityPayload, null, 2))
}

if (fs.existsSync(managedPath)) {
	const managedContent = fs.readFileSync(managedPath, "utf8")
	assertNoKnownTemplateEscapeCorruption(managedContent)
	assertCompiles(managedContent, managedPath)

	if (managedContent !== extractedShim) {
		fail("Managed .tasktronaut/bin/gsd-sdk.js does not match GSD_SDK_SHIM source")
	}
}

fs.rmSync(tempRoot, { recursive: true, force: true })
console.log("[check-gsd-sdk-shim] generated shim syntax and representative queries passed")
