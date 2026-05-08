import { NewTaskRequest } from "@shared/proto/cline/task"
import { useCallback, useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"

type GsdState = {
	current_phase: string
	current_step: string
	phase_name?: string
} | null

function parseGsdState(content: string): GsdState {
	const phase = content.match(/current_phase:\s*(\S+)/)?.[1]
	const step = content.match(/current_step:\s*(\S+)/)?.[1]
	if (!phase || !step) return null
	return {
		current_phase: phase,
		current_step: step,
		phase_name: content.match(/phase_name:\s*(.+)/)?.[1]?.trim(),
	}
}

const STEP_LABELS: Record<string, string> = {
	discuss: "Discuss",
	plan: "Plan",
	execute: "Execute",
	verify: "Verify",
	ship: "Ship",
}

const STEP_ORDER = ["discuss", "plan", "execute", "verify", "ship"]

type Cmd = { id: string; label: string; cmd: string; description: string }
type CmdGroup = { id: string; label: string; open?: boolean; commands: Cmd[] }

const GSD_COMMAND_GROUPS: CmdGroup[] = [
	{
		id: "core",
		label: "Core Workflow",
		open: true,
		commands: [
			{
				id: "map-codebase",
				label: "Map Codebase",
				cmd: "/gsd-map-codebase",
				description: "Analyze existing codebase before starting a new project",
			},
			{
				id: "new-project",
				label: "New Project",
				cmd: "/gsd-new-project",
				description: "Initialize project with requirements and roadmap",
			},
			{
				id: "discuss",
				label: "Discuss Phase",
				cmd: "/gsd-discuss-phase",
				description: "Capture implementation decisions before planning",
			},
			{ id: "plan", label: "Plan Phase", cmd: "/gsd-plan-phase", description: "Research and create atomic task plans" },
			{
				id: "execute",
				label: "Execute Phase",
				cmd: "/gsd-execute-phase",
				description: "Run phase plans in parallel waves",
			},
			{
				id: "verify",
				label: "Verify Work",
				cmd: "/gsd-verify-work",
				description: "User acceptance testing against specifications",
			},
			{ id: "ship", label: "Ship", cmd: "/gsd-ship", description: "Create pull request from verified work" },
			{ id: "next", label: "Next Step", cmd: "/gsd-next", description: "Auto-detect and run next workflow step" },
			{ id: "quick", label: "Quick Task", cmd: "/gsd-quick", description: "Ad-hoc task with GSD guarantees" },
			{ id: "fast", label: "Fast Task", cmd: "/gsd-fast", description: "Execute trivial tasks without planning" },
		],
	},
	{
		id: "phase-mgmt",
		label: "Phase Management",
		commands: [
			{ id: "add-phase", label: "Add Phase", cmd: "/gsd-add-phase", description: "Append phase to roadmap" },
			{
				id: "insert-phase",
				label: "Insert Phase",
				cmd: "/gsd-insert-phase",
				description: "Insert urgent work between phases",
			},
			{ id: "edit-phase", label: "Edit Phase", cmd: "/gsd-edit-phase", description: "Modify phase fields in place" },
			{ id: "remove-phase", label: "Remove Phase", cmd: "/gsd-remove-phase", description: "Remove a future phase" },
			{
				id: "list-phase-assumptions",
				label: "List Phase Assumptions",
				cmd: "/gsd-list-phase-assumptions",
				description: "Preview intended approach for a phase",
			},
		],
	},
	{
		id: "milestones",
		label: "Milestones",
		commands: [
			{
				id: "audit-milestone",
				label: "Audit Milestone",
				cmd: "/gsd-audit-milestone",
				description: "Verify milestone achieved definition of done",
			},
			{
				id: "complete-milestone",
				label: "Complete Milestone",
				cmd: "/gsd-complete-milestone",
				description: "Archive milestone and tag release",
			},
			{
				id: "new-milestone",
				label: "New Milestone",
				cmd: "/gsd-new-milestone",
				description: "Start next version with full planning",
			},
			{
				id: "milestone-summary",
				label: "Milestone Summary",
				cmd: "/gsd-milestone-summary",
				description: "Generate comprehensive project summary",
			},
		],
	},
	{
		id: "session",
		label: "Session",
		commands: [
			{
				id: "pause-work",
				label: "Pause Work",
				cmd: "/gsd-pause-work",
				description: "Create handoff document when stopping mid-phase",
			},
			{
				id: "resume-work",
				label: "Resume Work",
				cmd: "/gsd-resume-work",
				description: "Restore context from last session",
			},
			{
				id: "session-report",
				label: "Session Report",
				cmd: "/gsd-session-report",
				description: "Generate session summary",
			},
		],
	},
	{
		id: "brownfield",
		label: "Existing Projects",
		commands: [
			{
				id: "ingest-docs",
				label: "Ingest Docs",
				cmd: "/gsd-ingest-docs",
				description: "Bootstrap setup from mixed docs and specs",
			},
		],
	},
	{
		id: "quality",
		label: "Code Quality",
		commands: [
			{ id: "review", label: "Review", cmd: "/gsd-review", description: "Cross-AI peer code review" },
			{
				id: "code-review-fix",
				label: "Code Review Fix",
				cmd: "/gsd-code-review-fix",
				description: "Automated issue remediation from review",
			},
			{
				id: "secure-phase",
				label: "Secure Phase",
				cmd: "/gsd-secure-phase",
				description: "Security enforcement with threat models",
			},
			{
				id: "pr-branch",
				label: "PR Branch",
				cmd: "/gsd-pr-branch",
				description: "Create clean PR branch filtering planning commits",
			},
			{
				id: "audit-uat",
				label: "Audit UAT",
				cmd: "/gsd-audit-uat",
				description: "Find phases missing user acceptance testing",
			},
			{
				id: "docs-update",
				label: "Docs Update",
				cmd: "/gsd-docs-update",
				description: "Verified documentation generation",
			},
		],
	},
	{
		id: "ui",
		label: "UI Design",
		commands: [
			{
				id: "ui-phase",
				label: "UI Phase",
				cmd: "/gsd-ui-phase",
				description: "Generate UI design contract (spacing, color, copy standards)",
			},
			{
				id: "ui-review",
				label: "UI Review",
				cmd: "/gsd-ui-review",
				description: "Six-pillar visual audit of frontend code",
			},
		],
	},
	{
		id: "experimentation",
		label: "Experimentation",
		commands: [
			{ id: "spike", label: "Spike", cmd: "/gsd-spike", description: "Validate feasibility with throwaway experiments" },
			{ id: "sketch", label: "Sketch", cmd: "/gsd-sketch", description: "Generate throwaway HTML mockups" },
			{
				id: "spike-wrap-up",
				label: "Spike Wrap-up",
				cmd: "/gsd-spike-wrap-up",
				description: "Package spike findings into a skill",
			},
			{
				id: "sketch-wrap-up",
				label: "Sketch Wrap-up",
				cmd: "/gsd-sketch-wrap-up",
				description: "Package design findings into a skill",
			},
		],
	},
	{
		id: "debugging",
		label: "Debugging",
		commands: [
			{
				id: "forensics",
				label: "Forensics",
				cmd: "/gsd-forensics",
				description: "Post-mortem investigation of failed runs",
			},
			{ id: "debug", label: "Debug", cmd: "/gsd-debug", description: "Systematic debugging with persistent state" },
			{ id: "health", label: "Health Check", cmd: "/gsd-health", description: "Validate .planning/ directory integrity" },
		],
	},
	{
		id: "backlog",
		label: "Backlog & Capture",
		commands: [
			{ id: "plant-seed", label: "Plant Seed", cmd: "/gsd-plant-seed", description: "Capture a forward-looking idea" },
			{
				id: "add-backlog",
				label: "Add to Backlog",
				cmd: "/gsd-add-backlog",
				description: "Add idea to parking lot (999.x numbering)",
			},
			{
				id: "review-backlog",
				label: "Review Backlog",
				cmd: "/gsd-review-backlog",
				description: "Review and promote backlog items",
			},
			{ id: "thread", label: "Thread", cmd: "/gsd-thread", description: "Persistent cross-session context threads" },
			{ id: "add-todo", label: "Add Todo", cmd: "/gsd-add-todo", description: "Capture an idea for later" },
			{ id: "note", label: "Note", cmd: "/gsd-note", description: "Zero-friction idea capture" },
			{ id: "do", label: "Do", cmd: "/gsd-do", description: "Route freeform text to the appropriate command" },
		],
	},
	{
		id: "navigation",
		label: "Navigation",
		commands: [
			{ id: "progress", label: "Progress", cmd: "/gsd-progress", description: "Display current position and next steps" },
			{ id: "help", label: "Help", cmd: "/gsd-help", description: "Show all commands and usage guide" },
			{ id: "stats", label: "Stats", cmd: "/gsd-stats", description: "Display project statistics" },
			{ id: "manager", label: "Manager", cmd: "/gsd-manager", description: "Interactive command center" },
		],
	},
	{
		id: "config",
		label: "Configuration",
		commands: [
			{
				id: "settings",
				label: "Settings",
				cmd: "/gsd-settings",
				description: "Configure model profile and workflow agents",
			},
			{
				id: "set-profile",
				label: "Set Profile",
				cmd: "/gsd-set-profile",
				description: "Switch model profile (quality / balanced / budget)",
			},
			{
				id: "profile-user",
				label: "Profile User",
				cmd: "/gsd-profile-user",
				description: "Generate developer behavioral profile",
			},
		],
	},
]

type GsdViewProps = {
	onDone: () => void
}

const CmdButton = ({ c, onSend }: { c: Cmd; onSend: (cmd: string) => void }) => (
	<button
		className="flex flex-col text-left px-3 py-2 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
		key={c.id}
		onClick={() => onSend(c.cmd)}
		type="button">
		<div className="flex items-baseline gap-2">
			<span className="text-xs font-medium text-[var(--vscode-foreground)]">{c.label}</span>
			<span className="text-[10px] font-mono text-[var(--vscode-descriptionForeground)]">{c.cmd}</span>
		</div>
		<span className="text-[10px] text-[var(--vscode-descriptionForeground)] mt-0.5">{c.description}</span>
	</button>
)

const CollapsibleGroup = ({ group, onSend }: { group: CmdGroup; onSend: (cmd: string) => void }) => {
	const [open, setOpen] = useState(!!group.open)
	return (
		<div className="rounded border border-[var(--vscode-panel-border)] overflow-hidden">
			<button
				className="w-full px-3 py-2 text-left text-xs font-semibold cursor-pointer text-[var(--vscode-foreground)] bg-[var(--vscode-sideBarSectionHeader-background,var(--vscode-editor-background))] hover:bg-[var(--vscode-list-hoverBackground)] flex items-center justify-between"
				onClick={() => setOpen((v) => !v)}
				type="button">
				<span>{group.label}</span>
				<span className="text-[var(--vscode-descriptionForeground)] text-[10px]">{open ? "▾" : "▸"}</span>
			</button>
			{open && (
				<div className="p-2 bg-[var(--vscode-editor-background)] flex flex-col gap-1.5">
					{group.commands.map((c) => (
						<CmdButton c={c} key={c.id} onSend={onSend} />
					))}
				</div>
			)}
		</div>
	)
}

const GsdView = ({ onDone }: GsdViewProps) => {
	const { navigateToChat } = useExtensionState()
	const [gsdState, setGsdState] = useState<GsdState>(null)

	const sendCommand = useCallback(
		async (cmd: string) => {
			try {
				await TaskServiceClient.newTask(NewTaskRequest.create({ text: cmd, images: [] }))
				navigateToChat()
			} catch (_) {
				// ignore
			}
		},
		[navigateToChat],
	)

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const msg = event.data
			if (msg?.type === "gsdState" && msg.content) {
				setGsdState(parseGsdState(msg.content))
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	const stepIndex = gsdState ? STEP_ORDER.indexOf(gsdState.current_step) : -1

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* Fixed header + state */}
			<div className="flex-none px-4 pt-4 flex flex-col gap-4">
				<div className="flex items-center justify-between">
					<div>
						<h2 className="text-base font-semibold text-[var(--vscode-foreground)]">GSD Workflow</h2>
						<p className="text-xs text-[var(--vscode-descriptionForeground)] mt-0.5">
							Get Shit Done — spec-driven AI development
						</p>
					</div>
					<button
						aria-label="Close"
						className="text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] p-1 rounded"
						onClick={onDone}
						type="button">
						✕
					</button>
				</div>

				{/* Current State */}
				{gsdState ? (
					<div className="rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-3">
						<div className="text-xs text-[var(--vscode-descriptionForeground)] mb-2 uppercase tracking-wide">
							Active Project
						</div>
						<div className="font-medium text-sm text-[var(--vscode-foreground)]">
							{gsdState.phase_name ?? `Phase ${gsdState.current_phase}`}
						</div>
						<div className="flex gap-1 mt-3">
							{STEP_ORDER.map((s, i) => (
								<div
									className={`flex-1 h-1 rounded-full ${
										i < stepIndex
											? "bg-[var(--vscode-charts-green)]"
											: i === stepIndex
												? "bg-[var(--vscode-focusBorder)]"
												: "bg-[var(--vscode-panel-border)]"
									}`}
									key={s}
								/>
							))}
						</div>
						<div className="flex justify-between mt-1">
							{STEP_ORDER.map((s, i) => (
								<span
									className={`text-[10px] ${
										i === stepIndex
											? "text-[var(--vscode-focusBorder)]"
											: "text-[var(--vscode-descriptionForeground)]"
									}`}
									key={s}>
									{STEP_LABELS[s]}
								</span>
							))}
						</div>
					</div>
				) : (
					<div className="rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-3 text-xs text-[var(--vscode-descriptionForeground)]">
						No active GSD project. Use <span className="font-mono">/gsd-new-project</span> to start one.
					</div>
				)}
			</div>
			{/* Scrollable command groups */}
			<div className="flex-1 overflow-y-auto min-h-0 px-4 pb-4 pt-3 flex flex-col gap-2">
				{GSD_COMMAND_GROUPS.map((group) => (
					<CollapsibleGroup group={group} key={group.id} onSend={sendCommand} />
				))}
			</div>
		</div>
	)
}

export default GsdView
