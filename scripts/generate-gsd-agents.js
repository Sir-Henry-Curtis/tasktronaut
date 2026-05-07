#!/usr/bin/env node
/**
 * Generates cline/src/gsd-agents-generated.ts from GSD agent .md files.
 * Run this script whenever agent files change.
 */

const fs = require("fs")
const path = require("path")

const AGENTS_DIR = path.join(__dirname, "..", "get-shit-done", "agents")
const OUTPUT_FILE = path.join(__dirname, "..", "cline", "src", "gsd-agents-generated.ts")

// Phase-one Tasktronaut support is intentionally limited to research/mapping agents.
// Worker-style coding agents with Edit/Task semantics will be added in a later milestone.
const AGENT_TOOL_IDS = {
	"gsd-codebase-mapper": ["read_file", "write_to_file", "execute_command", "search_files", "list_files"],
	"gsd-nyquist-auditor": ["read_file", "write_to_file", "execute_command", "search_files", "list_files"],
	"gsd-pattern-mapper": ["read_file", "write_to_file", "execute_command", "search_files", "list_files"],
	"gsd-plan-checker": ["read_file", "execute_command", "search_files", "list_files"],
	"gsd-planner": ["read_file", "write_to_file", "execute_command", "search_files", "list_files", "web_fetch"],
	"gsd-phase-researcher": [
		"read_file",
		"write_to_file",
		"execute_command",
		"search_files",
		"list_files",
		"web_search",
		"web_fetch",
	],
	"gsd-project-researcher": [
		"read_file",
		"write_to_file",
		"execute_command",
		"search_files",
		"list_files",
		"web_search",
		"web_fetch",
	],
	"gsd-research-synthesizer": ["read_file", "write_to_file", "execute_command"],
	"gsd-roadmapper": ["read_file", "write_to_file", "execute_command", "search_files", "list_files"],
	"gsd-security-auditor": ["read_file", "write_to_file", "execute_command", "search_files", "list_files"],
	"gsd-ui-checker": ["read_file", "execute_command", "search_files", "list_files"],
	"gsd-ui-researcher": [
		"read_file",
		"write_to_file",
		"execute_command",
		"search_files",
		"list_files",
		"web_search",
		"web_fetch",
	],
}

const AGENTS_TO_BUNDLE = Object.keys(AGENT_TOOL_IDS)

function escapeBacktick(str) {
	return str.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
}

function parseFrontmatter(content, fieldName) {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
	if (!match) {
		throw new Error("Missing YAML frontmatter block")
	}

	const frontmatter = match[1]
	const fieldMatch = frontmatter.match(new RegExp(`^${fieldName}:\\s*(.+)$`, "m"))
	if (!fieldMatch) {
		throw new Error(`Missing '${fieldName}' in agent frontmatter`)
	}

	return {
		value: fieldMatch[1].trim(),
		body: match[2].trim(),
	}
}

function normalizeBody(body) {
	return body
		.replace(/~\/\.claude\/agents\//g, ".tasktronaut/agents/")
		.replace(/\$HOME\/\.claude\/agents\//g, ".tasktronaut/agents/")
		.replace(/\.claude\/agents\//g, ".tasktronaut/agents/")
		.replace(/@~\/\.claude\/get-shit-done\/references\//g, "@.tasktronaut/references/")
		.replace(/~\/\.claude\/get-shit-done\/references\//g, ".tasktronaut/references/")
		.replace(/\$HOME\/\.claude\/get-shit-done\/references\//g, ".tasktronaut/references/")
		.replace(/\.claude\/get-shit-done\/references\//g, ".tasktronaut/references/")
		.replace(/@~\/\.claude\/get-shit-done\/workflows\//g, "@.tasktronaut/workflows/")
		.replace(/~\/\.claude\/get-shit-done\/workflows\//g, ".tasktronaut/workflows/")
		.replace(/\$HOME\/\.claude\/get-shit-done\/workflows\//g, ".tasktronaut/workflows/")
		.replace(/\.claude\/get-shit-done\/workflows\//g, ".tasktronaut/workflows/")
		.replace(/~\/\.claude\/get-shit-done\/templates\//g, ".tasktronaut/templates/")
		.replace(/\$HOME\/\.claude\/get-shit-done\/templates\//g, ".tasktronaut/templates/")
		.replace(/\.claude\/get-shit-done\/templates\//g, ".tasktronaut/templates/")
		.replace(/"\$HOME\/\.claude\/get-shit-done\/bin\/gsd-tools\.cjs"/g, '".tasktronaut/bin/gsd-tools.cjs"')
		.replace(/~\/\.claude\/get-shit-done\/bin\/gsd-tools\.cjs/g, ".tasktronaut/bin/gsd-tools.cjs")
		.replace(/\$HOME\/\.claude\/get-shit-done\/bin\/gsd-tools\.cjs/g, ".tasktronaut/bin/gsd-tools.cjs")
}

function buildTasktronautAgentContent(agentName, sourceContent) {
	const { value: parsedName, body } = parseFrontmatter(sourceContent, "name")
	const { value: description } = parseFrontmatter(sourceContent, "description")
	const toolIds = AGENT_TOOL_IDS[agentName]

	if (!toolIds || toolIds.length === 0) {
		throw new Error(`No Tasktronaut tool mapping configured for ${agentName}`)
	}

	const frontmatterLines = [
		"---",
		`name: ${JSON.stringify(parsedName)}`,
		`description: ${JSON.stringify(description)}`,
		"tools:",
		...toolIds.map((toolId) => `  - ${toolId}`),
		"---",
		"",
	]

	return `${frontmatterLines.join("\n")}${normalizeBody(body)}\n`
}

const entries = []
const skipped = []

for (const agentName of AGENTS_TO_BUNDLE) {
	const mdPath = path.join(AGENTS_DIR, `${agentName}.md`)

	if (!fs.existsSync(mdPath)) {
		skipped.push(`${agentName} (${agentName}.md not found)`)
		continue
	}

	const sourceContent = fs.readFileSync(mdPath, "utf8")
	const content = buildTasktronautAgentContent(agentName, sourceContent)
	entries.push({ name: agentName, content })
}

if (skipped.length > 0) {
	console.warn("WARNING: No agent file found for:", skipped.join(", "))
}

const lines = [
	`// AUTO-GENERATED by scripts/generate-gsd-agents.js — do not edit manually`,
	``,
	`export interface GsdAgentDef {`,
	`\tname: string`,
	`\tcontent: string`,
	`}`,
	``,
	`export const GSD_AGENTS: GsdAgentDef[] = [`,
]

for (const { name, content } of entries) {
	lines.push(`\t{`)
	lines.push(`\t\tname: ${JSON.stringify(name)},`)
	lines.push(`\t\tcontent: \`${escapeBacktick(content)}\`,`)
	lines.push(`\t},`)
}

lines.push(`]`)
lines.push(``)

fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf8")
console.log(`Generated ${OUTPUT_FILE} with ${entries.length} agents.`)
