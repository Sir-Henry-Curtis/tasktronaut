#!/usr/bin/env node
/**
 * Generates tasktronaut/src/gsd-research-assets-generated.ts from selected GSD
 * reference, template, and workflow files needed by Tasktronaut-native GSD flows.
 * Run this script whenever those source files change.
 */

const fs = require("fs")
const path = require("path")

const GSD_ROOT = path.join(__dirname, "..", "get-shit-done", "get-shit-done")
const OUTPUT_FILE = path.join(__dirname, "..", "tasktronaut", "src", "gsd-research-assets-generated.ts")

const ASSETS = [
	{
		source: path.join(GSD_ROOT, "references", "mandatory-initial-read.md"),
		target: "references/mandatory-initial-read.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "project-skills-discovery.md"),
		target: "references/project-skills-discovery.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "thinking-models-research.md"),
		target: "references/thinking-models-research.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "questioning.md"),
		target: "references/questioning.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "domain-probes.md"),
		target: "references/domain-probes.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "ui-brand.md"),
		target: "references/ui-brand.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "revision-loop.md"),
		target: "references/revision-loop.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "gate-prompts.md"),
		target: "references/gate-prompts.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "agent-contracts.md"),
		target: "references/agent-contracts.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "context-budget.md"),
		target: "references/context-budget.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "checkpoints.md"),
		target: "references/checkpoints.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "gates.md"),
		target: "references/gates.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "planner-source-audit.md"),
		target: "references/planner-source-audit.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "planner-antipatterns.md"),
		target: "references/planner-antipatterns.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "planner-chunked.md"),
		target: "references/planner-chunked.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "tdd.md"),
		target: "references/tdd.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "executor-examples.md"),
		target: "references/executor-examples.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "ios-scaffold.md"),
		target: "references/ios-scaffold.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "thinking-models-execution.md"),
		target: "references/thinking-models-execution.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "thinking-models-planning.md"),
		target: "references/thinking-models-planning.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "thinking-models-verification.md"),
		target: "references/thinking-models-verification.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "verification-overrides.md"),
		target: "references/verification-overrides.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "few-shot-examples", "plan-checker.md"),
		target: "references/few-shot-examples/plan-checker.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "few-shot-examples", "verifier.md"),
		target: "references/few-shot-examples/verifier.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "continuation-format.md"),
		target: "references/continuation-format.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "scout-codebase.md"),
		target: "references/scout-codebase.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "sketch-interactivity.md"),
		target: "references/sketch-interactivity.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "sketch-theme-system.md"),
		target: "references/sketch-theme-system.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "sketch-tooling.md"),
		target: "references/sketch-tooling.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "sketch-variant-patterns.md"),
		target: "references/sketch-variant-patterns.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "universal-anti-patterns.md"),
		target: "references/universal-anti-patterns.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "research-project", "STACK.md"),
		target: "templates/research-project/STACK.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "research-project", "FEATURES.md"),
		target: "templates/research-project/FEATURES.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "research-project", "ARCHITECTURE.md"),
		target: "templates/research-project/ARCHITECTURE.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "research-project", "PITFALLS.md"),
		target: "templates/research-project/PITFALLS.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "research-project", "SUMMARY.md"),
		target: "templates/research-project/SUMMARY.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "VALIDATION.md"),
		target: "templates/VALIDATION.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "UI-SPEC.md"),
		target: "templates/UI-SPEC.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "SECURITY.md"),
		target: "templates/SECURITY.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "summary.md"),
		target: "templates/summary.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "UAT.md"),
		target: "templates/UAT.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "retrospective.md"),
		target: "templates/retrospective.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "roadmap.md"),
		target: "templates/roadmap.md",
	},
	{
		source: path.join(GSD_ROOT, "templates", "state.md"),
		target: "templates/state.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "git-integration.md"),
		target: "references/git-integration.md",
	},
	{
		source: path.join(GSD_ROOT, "references", "user-profiling.md"),
		target: "references/user-profiling.md",
	},
	{
		source: path.join(GSD_ROOT, "workflows", "diagnose-issues.md"),
		target: "workflows/diagnose-issues.md",
	},
	{
		source: path.join(GSD_ROOT, "workflows", "transition.md"),
		target: "workflows/transition.md",
	},
	{
		source: path.join(GSD_ROOT, "workflows", "execute-plan.md"),
		target: "workflows/execute-plan.md",
	},
	{
		source: path.join(GSD_ROOT, "workflows", "next.md"),
		target: "workflows/next.md",
	},
	{
		source: path.join(GSD_ROOT, "workflows", "graduation.md"),
		target: "workflows/graduation.md",
	},
]

function escapeBacktick(str) {
	return str.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
}

function normalizeContent(str) {
	return str
		.replace(/~\/\.claude\/get-shit-done\//g, ".tasktronaut/")
		.replace(/~\/\.claude\/agents\/gsd-/g, ".tasktronaut/agents/gsd-")
}

const lines = [
	`// AUTO-GENERATED by scripts/generate-gsd-research-assets.js — do not edit manually`,
	``,
	`export interface GsdResearchAssetDef {`,
	`\ttargetPath: string`,
	`\tcontent: string`,
	`}`,
	``,
	`export const GSD_RESEARCH_ASSETS: GsdResearchAssetDef[] = [`,
]

for (const asset of ASSETS) {
	if (!fs.existsSync(asset.source)) {
		throw new Error(`Missing research asset source: ${asset.source}`)
	}

	const content = normalizeContent(fs.readFileSync(asset.source, "utf8"))
	lines.push(`\t{`)
	lines.push(`\t\ttargetPath: ${JSON.stringify(asset.target)},`)
	lines.push(`\t\tcontent: \`${escapeBacktick(content)}\`,`)
	lines.push(`\t},`)
}

lines.push(`]`)
lines.push(``)

fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf8")
console.log(`Generated ${OUTPUT_FILE} with ${ASSETS.length} research assets.`)
