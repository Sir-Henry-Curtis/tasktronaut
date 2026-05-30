import { type AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { useCallback } from "react"
import { updateAutoApproveSettings } from "@/components/chat/auto-approve-menu/AutoApproveSettingsAPI"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useExtensionState } from "@/context/ExtensionStateContext"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

interface GeneralSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const groupClassName = "rounded-sm border border-white/10 bg-black/10 p-3 space-y-3"

const languageOptions = [
	"English",
	"Arabic - العربية",
	"Portuguese - Português (Brasil)",
	"Czech - Čeština",
	"French - Français",
	"German - Deutsch",
	"Hindi - हिन्दी",
	"Hungarian - Magyar",
	"Italian - Italiano",
	"Japanese - 日本語",
	"Korean - 한국어",
	"Polish - Polski",
	"Portuguese - Português (Portugal)",
	"Russian - Русский",
	"Simplified Chinese - 简体中文",
	"Spanish - Español",
	"Traditional Chinese - 繁體中文",
	"Turkish - Türkçe",
]

const FieldRow = ({ label, description, control }: { label: string; description: string; control: React.ReactNode }) => (
	<div className="space-y-2 py-2">
		<div className="space-y-1">
			<Label className="block text-sm font-medium">{label}</Label>
			<div className="text-xs leading-5 text-description">{description}</div>
		</div>
		<div className="w-full max-w-[320px]">{control}</div>
	</div>
)

const GeneralSettingsSection = ({ renderSectionHeader }: GeneralSettingsSectionProps) => {
	const { preferredLanguage, mcpDisplayMode, maxConsecutiveMistakes, customPrompt, autoApprovalSettings } = useExtensionState()

	const parseNumberInput = (value: string, fallback: number) => {
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : fallback
	}

	const saveAutoApprovalSettings = useCallback(
		async (nextSettings: AutoApprovalSettings) => {
			await updateAutoApproveSettings({
				...nextSettings,
				version: (autoApprovalSettings.version ?? 1) + 1,
			})
		},
		[autoApprovalSettings.version],
	)

	const updateAutoApprovalAction = useCallback(
		async (key: keyof AutoApprovalSettings["actions"], checked: boolean) => {
			const nextActions = { ...autoApprovalSettings.actions, [key]: checked }

			if (!checked) {
				if (key === "readFiles") {
					nextActions.readFilesExternally = false
				}
				if (key === "editFiles") {
					nextActions.editFilesExternally = false
				}
				if (key === "executeSafeCommands") {
					nextActions.executeAllCommands = false
				}
			}

			if (checked) {
				if (key === "readFilesExternally") {
					nextActions.readFiles = true
				}
				if (key === "editFilesExternally") {
					nextActions.editFiles = true
				}
				if (key === "executeAllCommands") {
					nextActions.executeSafeCommands = true
				}
			}

			await saveAutoApprovalSettings({
				...autoApprovalSettings,
				actions: nextActions,
			})
		},
		[autoApprovalSettings, saveAutoApprovalSettings],
	)

	return (
		<div>
			{renderSectionHeader("general")}
			<Section className="gap-4">
				<div className={groupClassName}>
					<div className="text-sm font-medium">Communication</div>
					<FieldRow
						control={
							<Select
								onValueChange={(value) => updateSetting("preferredLanguage", value)}
								value={preferredLanguage || "English"}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{languageOptions.map((language) => (
										<SelectItem key={language} value={language}>
											{language}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="The language Tasktronaut should use for user-facing communication and prompts."
						label="Preferred language"
					/>
				</div>

				<div className={groupClassName}>
					<div className="text-sm font-medium">Runtime behavior</div>
					<FieldRow
						control={
							<Select
								onValueChange={(value) => updateSetting("mcpDisplayMode", value)}
								value={mcpDisplayMode || "rich"}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="rich">Rich</SelectItem>
									<SelectItem value="plain">Plain</SelectItem>
									<SelectItem value="markdown">Markdown</SelectItem>
								</SelectContent>
							</Select>
						}
						description="Choose how MCP tool results are rendered in chat: rich cards, plain text, or markdown."
						label="MCP display mode"
					/>
					<FieldRow
						control={
							<Select
								onValueChange={(value) => updateSetting("customPrompt", value)}
								value={customPrompt === "compact" ? "compact" : "standard"}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="standard">Standard</SelectItem>
									<SelectItem value="compact">Compact</SelectItem>
								</SelectContent>
							</Select>
						}
						description="Use the compact prompt variant when you want a smaller system prompt footprint for constrained or weaker models."
						label="Prompt mode"
					/>
					<FieldRow
						control={
							<Input
								min={1}
								onChange={(event) =>
									updateSetting(
										"maxConsecutiveMistakes",
										parseNumberInput(event.target.value, maxConsecutiveMistakes || 3),
									)
								}
								type="number"
								value={String(maxConsecutiveMistakes || 3)}
							/>
						}
						description="How many repeated model mistakes Tasktronaut tolerates before it stops and surfaces the recovery warning."
						label="Max consecutive mistakes"
					/>
				</div>

				<div className={groupClassName}>
					<div className="text-sm font-medium">Approvals</div>
					<FieldRow
						control={
							<Switch
								checked={autoApprovalSettings.enableNotifications}
								onCheckedChange={(checked) =>
									saveAutoApprovalSettings({
										...autoApprovalSettings,
										enableNotifications: checked,
									})
								}
								size="lg"
							/>
						}
						description="Show desktop notifications for approvals and task completion events."
						label="Approval notifications"
					/>
					<FieldRow
						control={
							<Switch
								checked={autoApprovalSettings.actions.readFiles}
								onCheckedChange={(checked) => updateAutoApprovalAction("readFiles", checked)}
								size="lg"
							/>
						}
						description="Automatically allow reads inside the current workspace."
						label="Read project files"
					/>
					<FieldRow
						control={
							<Switch
								checked={autoApprovalSettings.actions.readFilesExternally ?? false}
								onCheckedChange={(checked) => updateAutoApprovalAction("readFilesExternally", checked)}
								size="lg"
							/>
						}
						description="Automatically allow file reads outside the current workspace root."
						label="Read files outside workspace"
					/>
					<FieldRow
						control={
							<Switch
								checked={autoApprovalSettings.actions.editFiles}
								onCheckedChange={(checked) => updateAutoApprovalAction("editFiles", checked)}
								size="lg"
							/>
						}
						description="Automatically allow file edits inside the current workspace."
						label="Edit project files"
					/>
					<FieldRow
						control={
							<Switch
								checked={autoApprovalSettings.actions.editFilesExternally ?? false}
								onCheckedChange={(checked) => updateAutoApprovalAction("editFilesExternally", checked)}
								size="lg"
							/>
						}
						description="Automatically allow edits outside the current workspace root."
						label="Edit files outside workspace"
					/>
					<FieldRow
						control={
							<Switch
								checked={autoApprovalSettings.actions.executeSafeCommands ?? false}
								onCheckedChange={(checked) => updateAutoApprovalAction("executeSafeCommands", checked)}
								size="lg"
							/>
						}
						description="Automatically allow commands classified as safe by Tasktronaut."
						label="Execute safe commands"
					/>
					<FieldRow
						control={
							<Switch
								checked={autoApprovalSettings.actions.executeAllCommands ?? false}
								onCheckedChange={(checked) => updateAutoApprovalAction("executeAllCommands", checked)}
								size="lg"
							/>
						}
						description="Automatically allow all command execution, including non-safe commands."
						label="Execute all commands"
					/>
					<FieldRow
						control={
							<Switch
								checked={autoApprovalSettings.actions.useMcp}
								onCheckedChange={(checked) => updateAutoApprovalAction("useMcp", checked)}
								size="lg"
							/>
						}
						description="Automatically allow MCP tool and resource calls without pausing for approval."
						label="Use MCP servers"
					/>
				</div>
			</Section>
		</div>
	)
}

export default GeneralSettingsSection
