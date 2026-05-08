export interface SlashCommand {
	name: string
	description?: string
	section?: "default" | "custom" | "mcp"
	cliCompatible?: boolean
}

export const BASE_SLASH_COMMANDS: SlashCommand[] = [
	{
		name: "newtask",
		description: "Create a new task with context from the current task",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "deep-planning",
		description: "Create a comprehensive implementation plan before coding",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "smol",
		description: "Condenses your current context window",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "newrule",
		description: "Create a new Cline rule based on your conversation",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "reportbug",
		description: "Create a Github issue with Cline",
		section: "default",
		cliCompatible: true,
	},
]

// VS Code-only slash commands
export const VSCODE_ONLY_COMMANDS: SlashCommand[] = [
	{
		name: "explain-changes",
		description: "Explain code changes between git refs (PRs, commits, branches, etc.)",
		section: "default",
	},
	// GSD core workflow
	{ name: "gsd-map-codebase", description: "Analyze existing codebase before starting a new project", section: "default" },
	{ name: "gsd-new-project", description: "Initialize project with requirements and roadmap", section: "default" },
	{ name: "gsd-discuss-phase", description: "Capture implementation decisions before planning", section: "default" },
	{ name: "gsd-plan-phase", description: "Research and create atomic task plans", section: "default" },
	{ name: "gsd-execute-phase", description: "Run phase plans in parallel waves", section: "default" },
	{ name: "gsd-verify-work", description: "User acceptance testing against specifications", section: "default" },
	{ name: "gsd-ship", description: "Create pull request from verified work", section: "default" },
	{ name: "gsd-next", description: "Auto-detect and run next workflow step", section: "default" },
	{ name: "gsd-quick", description: "Ad-hoc task with GSD guarantees", section: "default" },
	{ name: "gsd-fast", description: "Execute trivial tasks without planning", section: "default" },
	// GSD phase management
	{ name: "gsd-add-phase", description: "Append phase to roadmap", section: "default" },
	{ name: "gsd-insert-phase", description: "Insert urgent work between phases", section: "default" },
	{ name: "gsd-edit-phase", description: "Modify phase fields in place", section: "default" },
	{ name: "gsd-remove-phase", description: "Remove a future phase", section: "default" },
	{ name: "gsd-list-phase-assumptions", description: "Preview intended approach for a phase", section: "default" },
	// GSD milestones
	{ name: "gsd-audit-milestone", description: "Verify milestone achieved definition of done", section: "default" },
	{ name: "gsd-complete-milestone", description: "Archive milestone and tag release", section: "default" },
	{ name: "gsd-new-milestone", description: "Start next version with full planning", section: "default" },
	{ name: "gsd-milestone-summary", description: "Generate comprehensive project summary", section: "default" },
	// GSD session
	{ name: "gsd-pause-work", description: "Create handoff document when stopping mid-phase", section: "default" },
	{ name: "gsd-resume-work", description: "Restore context from last session", section: "default" },
	{ name: "gsd-session-report", description: "Generate session summary", section: "default" },
	// GSD existing projects
	{ name: "gsd-ingest-docs", description: "Bootstrap setup from mixed docs and specs", section: "default" },
	// GSD code quality
	{ name: "gsd-review", description: "Cross-AI peer code review", section: "default" },
	{ name: "gsd-code-review-fix", description: "Automated issue remediation from review", section: "default" },
	{ name: "gsd-secure-phase", description: "Security enforcement with threat models", section: "default" },
	{ name: "gsd-validate-phase", description: "Retroactively audit and fill Nyquist validation gaps", section: "default" },
	{ name: "gsd-pr-branch", description: "Create clean PR branch filtering planning commits", section: "default" },
	{ name: "gsd-audit-uat", description: "Find phases missing user acceptance testing", section: "default" },
	{ name: "gsd-docs-update", description: "Verified documentation generation", section: "default" },
	// GSD UI design
	{ name: "gsd-ui-phase", description: "Generate UI design contract (spacing, color, copy standards)", section: "default" },
	{ name: "gsd-ui-review", description: "Six-pillar visual audit of frontend code", section: "default" },
	// GSD experimentation
	{ name: "gsd-spike", description: "Validate feasibility with throwaway experiments", section: "default" },
	{ name: "gsd-sketch", description: "Generate throwaway HTML mockups", section: "default" },
	{ name: "gsd-spike-wrap-up", description: "Package spike findings into a skill", section: "default" },
	{ name: "gsd-sketch-wrap-up", description: "Package design findings into a skill", section: "default" },
	// GSD debugging
	{ name: "gsd-forensics", description: "Post-mortem investigation of failed runs", section: "default" },
	{ name: "gsd-debug", description: "Systematic debugging with persistent state", section: "default" },
	{ name: "gsd-health", description: "Validate .planning/ directory integrity", section: "default" },
	// GSD backlog & capture
	{ name: "gsd-plant-seed", description: "Capture a forward-looking idea", section: "default" },
	{ name: "gsd-add-backlog", description: "Add idea to parking lot", section: "default" },
	{ name: "gsd-review-backlog", description: "Review and promote backlog items", section: "default" },
	{ name: "gsd-thread", description: "Persistent cross-session context threads", section: "default" },
	{ name: "gsd-add-todo", description: "Capture an idea for later", section: "default" },
	{ name: "gsd-note", description: "Zero-friction idea capture", section: "default" },
	{ name: "gsd-do", description: "Route freeform text to the appropriate GSD command", section: "default" },
	// GSD navigation
	{ name: "gsd-progress", description: "Display current position and next steps", section: "default" },
	{ name: "gsd-help", description: "Show all GSD commands and usage guide", section: "default" },
	{ name: "gsd-stats", description: "Display project statistics", section: "default" },
	{ name: "gsd-manager", description: "Interactive GSD command center", section: "default" },
	// GSD configuration
	{ name: "gsd-settings", description: "Configure model profile and workflow agents", section: "default" },
	{ name: "gsd-set-profile", description: "Switch model profile (quality / balanced / budget)", section: "default" },
	{ name: "gsd-profile-user", description: "Generate developer behavioral profile", section: "default" },
]

// CLI-only slash commands (handled locally, not sent to backend)
export const CLI_ONLY_COMMANDS: SlashCommand[] = [
	{
		name: "help",
		description: "Learn how to use Cline CLI",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "settings",
		description: "Change API provider, auto-approve, and feature settings",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "models",
		description: "Change the model used for the current mode",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "history",
		description: "Browse and search task history",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "clear",
		description: "Clear the current task and start fresh",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "exit",
		description: "Alternative to Ctrl+C",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "q",
		description: "Alternative to Ctrl+C",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "skills",
		description: "View and manage installed skills",
		section: "default",
		cliCompatible: true,
	},
]
