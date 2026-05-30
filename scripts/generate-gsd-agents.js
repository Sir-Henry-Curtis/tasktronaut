#!/usr/bin/env node
/**
 * Generates tasktronaut/src/gsd-agents-generated.ts from GSD agent .md files.
 * Run this script whenever agent files change.
 */

const fs = require("fs")
const path = require("path")

const AGENTS_DIR = path.join(__dirname, "..", "get-shit-done", "agents")
const OUTPUT_FILE = path.join(__dirname, "..", "tasktronaut", "src", "gsd-agents-generated.ts")

const AGENT_TOOL_IDS = {
	"gsd-codebase-mapper": ["read_file", "write_to_file", "execute_command", "search_files", "list_files"],
	"gsd-executor": ["read_file", "write_to_file", "replace_in_file", "execute_command", "search_files", "list_files"],
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
		"web_fetch",
	],
	"gsd-project-researcher": [
		"read_file",
		"write_to_file",
		"execute_command",
		"search_files",
		"list_files",
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
		"web_fetch",
	],
	"gsd-verifier": ["read_file", "write_to_file", "execute_command", "search_files", "list_files"],
	"gsd-user-profiler": ["read_file", "write_to_file", "execute_command", "search_files", "list_files"],
}

const AGENTS_TO_BUNDLE = Object.keys(AGENT_TOOL_IDS)
const AGENT_RUNTIME_CONFIG = {
	"gsd-codebase-mapper": { role: "worker", isolation: "inherit", allowParallelSharedWorkspace: true },
	"gsd-executor": { role: "worker", isolation: "worktree" },
	"gsd-verifier": { role: "worker", isolation: "inherit" },
}

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
		.replace(/<step name="load_graph_context">[\s\S]*?<\/step>/g, "")
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
		.replace(/node\s+["']?\.tasktronaut\/bin\/gsd-tools\.cjs["']?/g, "gsd-tools")
		.replace(/\|\s*3rd\s*\|\s*WebSearch\s*\|\s*Ecosystem discovery, community patterns, pitfalls\s*\|\s*Needs verification\s*\|/g, "| 3rd | Official web sources via WebFetch | Known official docs, changelogs, package pages | Needs explicit URL |")
		.replace(/\|\s*5th\s*\|\s*WebSearch\s*\|\s*Fallback keyword search for ecosystem discovery\s*\|\s*Needs verification\s*\|/g, "| 5th | Official web sources via WebFetch | Last-resort retrieval from known official URLs | Needs explicit URL |")
		.replace(/\*\*WebSearch tips:\*\*.*$/gm, "**Tasktronaut policy:** Do not use built-in web search. Prefer Context7 first, then approved MCP research tools, then known official URLs with WebFetch.")
		.replace(/## Enhanced Web Search \(Brave API\)[\s\S]*?### Exa Semantic Search \(MCP\)/g, "### Exa Semantic Search (MCP)")
		.replace(/### Enhanced Web Search \(Brave API\)[\s\S]*?### Exa Semantic Search \(MCP\)/g, "### Exa Semantic Search (MCP)")
		.replace(/```bash\s*gsd-sdk query websearch "your query" --limit 10\s*```/g, "")
		.replace(/If `exa_search: false` \(or not set\), fall back to WebSearch or Brave Search\./g, "If `exa_search: false` (or not set), fall back to known official URLs with WebFetch.")
		.replace(/Use after finding a URL from Exa, WebSearch, or known docs\./g, "Use after finding a URL from Exa or known docs.")
		.replace(/Use after finding a relevant URL from Exa, WebSearch, or known docs\./g, "Use after finding a relevant URL from Exa or known docs.")
		.replace(/\*\*Verify every WebSearch finding:\*\*/g, "**Verify every externally sourced finding:**")
		.replace(/\*\*WebSearch findings must be verified:\*\*/g, "**Externally sourced findings must be verified:**")
		.replace(/For each WebSearch finding:/g, "For each externally sourced finding:")
		.replace(/For each finding:/g, "For each externally sourced finding:")
		.replace(/\| MEDIUM \| WebSearch verified with official source, multiple credible sources \| State with attribution \|/g, "| MEDIUM | External finding verified with official source, multiple credible sources | State with attribution |")
		.replace(/\| MEDIUM \| WebSearch verified with official source, multiple credible sources agree \| State with attribution \|/g, "| MEDIUM | External finding verified with official source, multiple credible sources agree | State with attribution |")
		.replace(/\| LOW \| WebSearch only, single source, unverified \| Flag as needing validation \|/g, "| LOW | External source only, single source, unverified | Flag as needing validation |")
		.replace(/Priority: Context7 > Exa \(verified\) > Firecrawl \(official docs\) > Official GitHub > Brave\/WebSearch \(verified\) > WebSearch \(unverified\)/g, "Priority: Context7 > Exa (verified) > Firecrawl (official docs) > Official GitHub > WebFetch from official sources")
		.replace(/\*\*Source priority:\*\* Context7 → Exa \(verified\) → Firecrawl \(official docs\) → Official GitHub → Brave\/WebSearch \(verified\) → WebSearch \(unverified\)/g, "**Source priority:** Context7 → Exa (verified) → Firecrawl (official docs) → Official GitHub → WebFetch from official sources")
		.replace(/### 3\. WebSearch — Ecosystem Discovery/g, "### 3. Official External Research — Ecosystem Discovery")
		.replace(/Use multiple query variations\. Mark WebSearch-only findings as LOW confidence\./g, "Use multiple source variations and mark any unverified external finding as LOW confidence.")
		.replace(/If `brave_search: false` \(or not set\), use built-in WebSearch tool instead\./g, "Do not use built-in web search in Tasktronaut's baseline profile. Prefer approved MCP research tools or known official URLs with WebFetch.")
		.replace(/For each domain: Context7 first → Official docs → WebSearch → Cross-verify\./g, "For each domain: Context7 first → Official docs → approved MCP research or known official URLs → Cross-verify.")
		.replace(/For each domain: Context7 → Official Docs → WebSearch → Verify\./g, "For each domain: Context7 → Official Docs → approved MCP research or known official URLs → Verify.")
		.replace(/- \[WebSearch verified with official source\]/g, "- [External finding verified with official source]")
		.replace(/- \[WebSearch only, marked for validation\]/g, "- [External finding only, marked for validation]")
		.replace(/- \[ \] Source hierarchy followed \(Context7 → Official → WebSearch\)/g, "- [ ] Source hierarchy followed (Context7 → Official → approved external sources)")
		.replace(/prefer Exa for discovery and Firecrawl for scraping over WebSearch\/WebFetch\./g, "prefer Exa for discovery and Firecrawl for scraping over direct URL fetches.")
}

function buildTasktronautAgentContent(agentName, sourceContent) {
	const { value: parsedName, body } = parseFrontmatter(sourceContent, "name")
	const { value: description } = parseFrontmatter(sourceContent, "description")
	const toolIds = AGENT_TOOL_IDS[agentName]
	const runtimeConfig = AGENT_RUNTIME_CONFIG[agentName] ?? {
		role: toolIds.some((toolId) => toolId === "write_to_file" || toolId === "replace_in_file") ? "worker" : "research",
		isolation: "inherit",
	}

	if (!toolIds || toolIds.length === 0) {
		throw new Error(`No Tasktronaut tool mapping configured for ${agentName}`)
	}

	const frontmatterLines = [
		"---",
		`name: ${JSON.stringify(parsedName)}`,
		`description: ${JSON.stringify(description)}`,
		`role: ${runtimeConfig.role}`,
		`isolation: ${runtimeConfig.isolation}`,
		...(runtimeConfig.allowParallelSharedWorkspace ? ["allowParallelSharedWorkspace: true"] : []),
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
