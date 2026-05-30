#!/usr/bin/env node
/**
 * Generates tasktronaut/src/gsd-workflows-generated.ts from GSD workflow .md files.
 * Run this script whenever workflow files change.
 */

const fs = require("fs")
const path = require("path")

const WORKFLOWS_DIR = path.join(__dirname, "..", "get-shit-done", "get-shit-done", "workflows")
const OUTPUT_FILE = path.join(__dirname, "..", "tasktronaut", "src", "gsd-workflows-generated.ts")

// Mapping from gsd-<command> to workflow filename (without .md).
// If the key strips to the filename directly, no explicit entry needed.
const COMMAND_TO_FILE = {
	"gsd-resume-work": "resume-project",
}

// Commands registered in slashCommands.ts
const REGISTERED_COMMANDS = [
	"gsd-map-codebase",
	"gsd-new-project",
	"gsd-discuss-phase",
	"gsd-plan-phase",
	"gsd-execute-phase",
	"gsd-verify-work",
	"gsd-ship",
	"gsd-next",
	"gsd-quick",
	"gsd-fast",
	"gsd-add-phase",
	"gsd-insert-phase",
	"gsd-edit-phase",
	"gsd-remove-phase",
	"gsd-list-phase-assumptions",
	"gsd-audit-milestone",
	"gsd-complete-milestone",
	"gsd-new-milestone",
	"gsd-milestone-summary",
	"gsd-pause-work",
	"gsd-resume-work",
	"gsd-session-report",
	"gsd-ingest-docs",
	"gsd-review",
	"gsd-code-review-fix",
	"gsd-secure-phase",
	"gsd-validate-phase",
	"gsd-pr-branch",
	"gsd-audit-uat",
	"gsd-docs-update",
	"gsd-ui-phase",
	"gsd-ui-review",
	"gsd-spike",
	"gsd-sketch",
	"gsd-spike-wrap-up",
	"gsd-sketch-wrap-up",
	"gsd-forensics",
	"gsd-debug",
	"gsd-health",
	"gsd-plant-seed",
	"gsd-add-backlog",
	"gsd-review-backlog",
	"gsd-thread",
	"gsd-add-todo",
	"gsd-note",
	"gsd-do",
	"gsd-progress",
	"gsd-help",
	"gsd-stats",
	"gsd-manager",
	"gsd-settings",
	"gsd-set-profile",
	"gsd-profile-user",
]

function escapeBacktick(str) {
	return str.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
}

const TASKTRONAUT_PREAMBLE = `> **TASKTRONAUT RUNTIME NOTE — read before executing this workflow:**
> \`AskUserQuestion\` is a Claude Code CLI tool that does NOT exist in Tasktronaut/Cline.
> Whenever this workflow says \`Use AskUserQuestion:\` or \`AskUserQuestion([...])\`, call \`ask_followup_question\` instead:
> - Set \`question\` = the workflow's \`question\` field.
> - Set \`options\` = a JSON string array of the option labels only — no descriptions, no header, no objects.
>   Example: \`["Approve", "Adjust phases", "Review full file"]\`
> - For multi-question batches \`AskUserQuestion([q1, q2, ...])\`, ask each question sequentially as separate \`ask_followup_question\` calls.
> - For options written as \`{ label: "X", description: "..." }\`, use only the \`label\` string value.
> - For options written as \`"Label — description"\`, strip the \` — description\` part and use only \`"Label"\`.
> This note overrides any conflicting instruction in the workflow below.

`

function normalizeWorkflowContent(content) {
	return TASKTRONAUT_PREAMBLE + content
		.replace(/node\s+["']\$HOME\/\.claude\/get-shit-done\/bin\/gsd-tools\.cjs["']?/g, "gsd-tools")
		.replace(/node\s+["']~\/\.claude\/get-shit-done\/bin\/gsd-tools\.cjs["']?/g, "gsd-tools")
		.replace(/node\s+["']?\.tasktronaut\/bin\/gsd-tools\.cjs["']?/g, "gsd-tools")
		.replace(/Do a brief web search for best practices related to what the user described/g, "Do a brief review of official documentation and approved MCP research sources related to what the user described")
		.replace(/Use web search for APIs\/services without a context7 entry\./g, "Use official docs and approved MCP research sources for APIs/services without a context7 entry.")
		.replace(/or web search to answer:/g, "or approved MCP research sources to answer:")
		.replace(/Research best practices before asking questions\? \(web search during new-project and discuss-phase\)/g, "Research best practices before asking questions? (official docs / approved MCP research during new-project and discuss-phase)")
		.replace(/- `graphify\.enabled` — enable project knowledge graph \(\/gsd-graphify\) \(default: false if absent\)\n/g, "")
		.replace(/Intel, Graphify/g, "Intel")
		.replace(/\n\s*\{\s*"label": "Enable Graphify\?[\s\S]*?\n\s*\}\n\s*\]/g, "\n    ]")
		.replace(/\n\s*"graphify": \{[\s\S]*?\n\s*\},?/g, "")
		.replace(/\| Graphify\s+\| \{On\/Off\} \|\n/g, "")
		.replace(/context window, gitignored search, graphify build timeout, and runtime model tier overrides\./g, "context window, gitignored search, and runtime model tier overrides.")
		.replace(/- `graphify\.build_timeout` \(default: `300`\)\n/g, "")
		.replace(/`\\*_threshold`, `context_window`, `graphify\.build_timeout`\), if the user types a value that/g, "`*_threshold`, `context_window`), if the user types a value that")
		.replace(/\n\s*\{\s*"label": "Graphify build timeout[\s\S]*?\n\s*\}\n\s*\]/g, "\n    ]")
		.replace(/~\/\.gsd\b/g, "~/.tasktronaut/gsd")
		.replace(/~\/\.claude\/get-shit-done\//g, ".tasktronaut/")
		.replace(/~\/\.claude\/agents\/gsd-/g, ".tasktronaut/agents/gsd-")
}

const entries = []
const skipped = []

for (const cmd of REGISTERED_COMMANDS) {
	const baseName = COMMAND_TO_FILE[cmd] || cmd.replace(/^gsd-/, "")
	const mdPath = path.join(WORKFLOWS_DIR, `${baseName}.md`)

	if (!fs.existsSync(mdPath)) {
		skipped.push(`${cmd} (${baseName}.md not found)`)
		continue
	}

	const content = normalizeWorkflowContent(fs.readFileSync(mdPath, "utf8"))
	entries.push({ name: cmd, content })
}

if (skipped.length > 0) {
	console.warn("WARNING: No workflow file found for:", skipped.join(", "))
}

const lines = [
	`// AUTO-GENERATED by scripts/generate-gsd-workflows.js — do not edit manually`,
	`import type { GlobalInstructionsFile } from "@shared/remote-config/schema"`,
	``,
	`export const GSD_WORKFLOWS: GlobalInstructionsFile[] = [`,
]

for (const { name, content } of entries) {
	lines.push(`\t{`)
	lines.push(`\t\talwaysEnabled: true,`)
	lines.push(`\t\tname: ${JSON.stringify(name)},`)
	lines.push(`\t\tcontents: \`${escapeBacktick(content)}\`,`)
	lines.push(`\t},`)
}

lines.push(`]`)
lines.push(``)

fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf8")
console.log(`Generated ${OUTPUT_FILE} with ${entries.length} workflows.`)
