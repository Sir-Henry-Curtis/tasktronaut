import { existsSync, readFileSync } from "fs"
import path from "node:path"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { WebviewProvider } from "../core/webview"

interface GsdState {
	current_phase: string
	current_step: string
	phase_name?: string
}

const STEP_TO_COMMAND: Record<string, string> = {
	discuss: "/gsd-discuss-phase",
	plan: "/gsd-plan-phase",
	execute: "/gsd-execute-phase",
	verify: "/gsd-verify-work",
	ship: "/gsd-ship",
}

export class GsdOrchestrator {
	private autoModeEnabled = false
	private stateWatcher: vscode.FileSystemWatcher | undefined
	private lastKnownState: string | undefined
	private statusBar: vscode.StatusBarItem

	constructor(private readonly context: vscode.ExtensionContext) {
		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
		this.statusBar.command = "gsd.toggleAutoMode"
		context.subscriptions.push(this.statusBar)
	}

	activate(): void {
		this.context.subscriptions.push(
			vscode.commands.registerCommand("gsd.toggleAutoMode", () => this.toggleAutoMode()),
		)

		this.context.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.startWatcher()),
		)

		this.startWatcher()
		this.updateStatusBar()
	}

	private startWatcher(): void {
		this.stateWatcher?.dispose()

		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders || workspaceFolders.length === 0) return

		const primaryRoot = workspaceFolders[0].uri.fsPath
		const pattern = new vscode.RelativePattern(primaryRoot, ".planning/STATE.md")

		this.stateWatcher = vscode.workspace.createFileSystemWatcher(pattern)
		this.context.subscriptions.push(this.stateWatcher)

		this.stateWatcher.onDidChange(() => this.onStateChange(primaryRoot))
		this.stateWatcher.onDidCreate(() => this.onStateChange(primaryRoot))

		this.checkCurrentState(primaryRoot)
	}

	private checkCurrentState(workspaceRoot: string): void {
		const statePath = path.join(workspaceRoot, ".planning", "STATE.md")
		if (existsSync(statePath)) {
			const content = readFileSync(statePath, "utf8")
			this.lastKnownState = content
			this.updateStatusBar(this.parseState(content))
		}
	}

	private async onStateChange(workspaceRoot: string): Promise<void> {
		const statePath = path.join(workspaceRoot, ".planning", "STATE.md")
		if (!existsSync(statePath)) return

		const content = readFileSync(statePath, "utf8")
		if (content === this.lastKnownState) return
		this.lastKnownState = content

		const state = this.parseState(content)
		this.updateStatusBar(state)

		if (!state || !this.autoModeEnabled) return

		const nextCommand = STEP_TO_COMMAND[state.current_step]
		if (!nextCommand) return

		const phaseName = state.phase_name || `Phase ${state.current_phase}`
		const choice = await vscode.window.showInformationMessage(
			`GSD Auto: ${phaseName} → ${nextCommand}`,
			"Run",
			"Skip",
			"Stop Auto",
		)

		if (choice === "Stop Auto") {
			this.autoModeEnabled = false
			this.updateStatusBar(state)
			return
		}

		if (choice === "Run") {
			await this.sendGsdCommand(nextCommand)
		}
	}

	private parseState(content: string): GsdState | null {
		try {
			const phase = content.match(/current_phase:\s*(\S+)/)?.[1]
			const step = content.match(/current_step:\s*(\S+)/)?.[1]
			if (!phase || !step) return null
			return {
				current_phase: phase,
				current_step: step,
				phase_name: content.match(/phase_name:\s*(.+)/)?.[1]?.trim(),
			}
		} catch (_e) {
			return null
		}
	}

	private async sendGsdCommand(command: string): Promise<void> {
		try {
			await vscode.commands.executeCommand("tasktronaut.plusButtonClicked")
			await new Promise((resolve) => setTimeout(resolve, 500))

			const instance = WebviewProvider.getInstance()
			await instance.controller.initTask(command)
			Logger.info(`[GSD] Auto-advanced with command: ${command}`)
		} catch (error) {
			Logger.warn("[GSD] Failed to send command: " + (error instanceof Error ? error.message : String(error)))
		}
	}

	private toggleAutoMode(): void {
		this.autoModeEnabled = !this.autoModeEnabled

		const folders = vscode.workspace.workspaceFolders
		const state = folders?.[0]
			? (() => {
					const sp = path.join(folders[0].uri.fsPath, ".planning", "STATE.md")
					return existsSync(sp) ? this.parseState(readFileSync(sp, "utf8")) : null
				})()
			: null

		this.updateStatusBar(state)
		vscode.window.showInformationMessage(
			this.autoModeEnabled ? "GSD Auto Mode ON — will prompt to advance on state changes." : "GSD Auto Mode OFF",
		)
	}

	private updateStatusBar(state?: GsdState | null): void {
		const folders = vscode.workspace.workspaceFolders
		const hasPlanning =
			folders?.[0] && existsSync(path.join(folders[0].uri.fsPath, ".planning", "STATE.md"))

		if (!state && !hasPlanning) {
			this.statusBar.hide()
			return
		}

		const autoIcon = this.autoModeEnabled ? "$(sync~spin)" : "$(sync)"
		const phaseInfo = state ? ` P${state.current_phase}:${state.current_step}` : ""
		this.statusBar.text = `${autoIcon} GSD${phaseInfo}`
		this.statusBar.tooltip = this.autoModeEnabled
			? "GSD Auto Mode ON — click to disable"
			: "GSD Auto Mode OFF — click to enable"
		this.statusBar.show()
	}
}
