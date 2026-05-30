import { EmptyRequest } from "@shared/proto/cline/common"
import { GsdSettings, type GsdSettingsResponse, UpdateGsdSettingsRequest } from "@shared/proto/cline/state"
import { RefreshCcw, Save } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { StateServiceClient } from "@/services/grpc-client"
import Section from "../Section"

interface GsdSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

type GsdFormState = {
	modelProfile: string
	projectResearcherModel: string
	synthesizerModel: string
	roadmapperModel: string
	mapperModel: string
	researcherModel: string
	plannerModel: string
	checkerModel: string
	executorModel: string
	verifierModel: string
	researchEnabled: boolean
	planCheck: boolean
	autoAdvance: boolean
	discussMode: string
	skipDiscuss: boolean
	textMode: boolean
	useWorktrees: boolean
	planChunked: boolean
	tddMode: boolean
	nyquistValidation: boolean
	patternMapper: boolean
	verifier: boolean
	uiPhase: boolean
	uiSafetyGate: boolean
	uiReview: boolean
	aiIntegrationPhase: boolean
	codeReview: boolean
	codeReviewDepth: string
	autoPruneState: boolean
	securityEnforcement: boolean
	securityAsvsLevel: number
	securityBlockOn: string
	driftThreshold: number
	driftAction: string
	buildCommand: string
	testCommand: string
	researchBeforeQuestions: boolean
	maxDiscussPasses: number
	nodeRepair: boolean
	nodeRepairBudget: number
	postPlanningGaps: boolean
	contextCoverageGate: boolean
	subagentTimeout: number
	inlinePlanThreshold: number
	commitDocs: boolean
	contextWindow: number
	responseLanguage: string
	branchingStrategy: string
	gitProvider: string
	gitProviderBaseUrl: string
	gitProviderTransport: string
	gitProviderMcpServer: string
	gitProviderMcpPrStatusTool: string
	gitProviderMcpOpenPrTool: string
	gitProviderMcpCommitTool: string
	gitProviderMcpSyncTool: string
	thinkingPartner: boolean
	globalLearnings: boolean
	intelEnabled: boolean
}

const DEFAULTS: GsdFormState = {
	modelProfile: "balanced",
	projectResearcherModel: "",
	synthesizerModel: "",
	roadmapperModel: "",
	mapperModel: "",
	researcherModel: "",
	plannerModel: "",
	checkerModel: "",
	executorModel: "",
	verifierModel: "",
	researchEnabled: true,
	planCheck: true,
	autoAdvance: false,
	discussMode: "discuss",
	skipDiscuss: false,
	textMode: false,
	useWorktrees: true,
	planChunked: false,
	tddMode: false,
	nyquistValidation: true,
	patternMapper: true,
	verifier: true,
	uiPhase: true,
	uiSafetyGate: true,
	uiReview: true,
	aiIntegrationPhase: true,
	codeReview: true,
	codeReviewDepth: "standard",
	autoPruneState: false,
	securityEnforcement: true,
	securityAsvsLevel: 1,
	securityBlockOn: "high",
	driftThreshold: 3,
	driftAction: "warn",
	buildCommand: "",
	testCommand: "",
	researchBeforeQuestions: false,
	maxDiscussPasses: 3,
	nodeRepair: true,
	nodeRepairBudget: 2,
	postPlanningGaps: true,
	contextCoverageGate: true,
	subagentTimeout: 600,
	inlinePlanThreshold: 3,
	commitDocs: true,
	contextWindow: 200000,
	responseLanguage: "",
	branchingStrategy: "none",
	gitProvider: "github",
	gitProviderBaseUrl: "",
	gitProviderTransport: "web",
	gitProviderMcpServer: "",
	gitProviderMcpPrStatusTool: "",
	gitProviderMcpOpenPrTool: "",
	gitProviderMcpCommitTool: "",
	gitProviderMcpSyncTool: "",
	thinkingPartner: false,
	globalLearnings: false,
	intelEnabled: false,
}

function responseToForm(response?: GsdSettingsResponse | null): GsdFormState {
	const settings = response?.settings
	return {
		modelProfile: settings?.modelProfile ?? DEFAULTS.modelProfile,
		projectResearcherModel: settings?.projectResearcherModel ?? DEFAULTS.projectResearcherModel,
		synthesizerModel: settings?.synthesizerModel ?? DEFAULTS.synthesizerModel,
		roadmapperModel: settings?.roadmapperModel ?? DEFAULTS.roadmapperModel,
		mapperModel: settings?.mapperModel ?? DEFAULTS.mapperModel,
		researcherModel: settings?.researcherModel ?? DEFAULTS.researcherModel,
		plannerModel: settings?.plannerModel ?? DEFAULTS.plannerModel,
		checkerModel: settings?.checkerModel ?? DEFAULTS.checkerModel,
		executorModel: settings?.executorModel ?? DEFAULTS.executorModel,
		verifierModel: settings?.verifierModel ?? DEFAULTS.verifierModel,
		researchEnabled: settings?.researchEnabled ?? DEFAULTS.researchEnabled,
		planCheck: settings?.planCheck ?? DEFAULTS.planCheck,
		autoAdvance: settings?.autoAdvance ?? DEFAULTS.autoAdvance,
		discussMode: settings?.discussMode ?? DEFAULTS.discussMode,
		skipDiscuss: settings?.skipDiscuss ?? DEFAULTS.skipDiscuss,
		textMode: settings?.textMode ?? DEFAULTS.textMode,
		useWorktrees: settings?.useWorktrees ?? DEFAULTS.useWorktrees,
		planChunked: settings?.planChunked ?? DEFAULTS.planChunked,
		tddMode: settings?.tddMode ?? DEFAULTS.tddMode,
		nyquistValidation: settings?.nyquistValidation ?? DEFAULTS.nyquistValidation,
		patternMapper: settings?.patternMapper ?? DEFAULTS.patternMapper,
		verifier: settings?.verifier ?? DEFAULTS.verifier,
		uiPhase: settings?.uiPhase ?? DEFAULTS.uiPhase,
		uiSafetyGate: settings?.uiSafetyGate ?? DEFAULTS.uiSafetyGate,
		uiReview: settings?.uiReview ?? DEFAULTS.uiReview,
		aiIntegrationPhase: settings?.aiIntegrationPhase ?? DEFAULTS.aiIntegrationPhase,
		codeReview: settings?.codeReview ?? DEFAULTS.codeReview,
		codeReviewDepth: settings?.codeReviewDepth ?? DEFAULTS.codeReviewDepth,
		autoPruneState: settings?.autoPruneState ?? DEFAULTS.autoPruneState,
		securityEnforcement: settings?.securityEnforcement ?? DEFAULTS.securityEnforcement,
		securityAsvsLevel: settings?.securityAsvsLevel ?? DEFAULTS.securityAsvsLevel,
		securityBlockOn: settings?.securityBlockOn ?? DEFAULTS.securityBlockOn,
		driftThreshold: settings?.driftThreshold ?? DEFAULTS.driftThreshold,
		driftAction: settings?.driftAction ?? DEFAULTS.driftAction,
		buildCommand: settings?.buildCommand ?? DEFAULTS.buildCommand,
		testCommand: settings?.testCommand ?? DEFAULTS.testCommand,
		researchBeforeQuestions: settings?.researchBeforeQuestions ?? DEFAULTS.researchBeforeQuestions,
		maxDiscussPasses: settings?.maxDiscussPasses ?? DEFAULTS.maxDiscussPasses,
		nodeRepair: settings?.nodeRepair ?? DEFAULTS.nodeRepair,
		nodeRepairBudget: settings?.nodeRepairBudget ?? DEFAULTS.nodeRepairBudget,
		postPlanningGaps: settings?.postPlanningGaps ?? DEFAULTS.postPlanningGaps,
		contextCoverageGate: settings?.contextCoverageGate ?? DEFAULTS.contextCoverageGate,
		subagentTimeout: settings?.subagentTimeout ?? DEFAULTS.subagentTimeout,
		inlinePlanThreshold: settings?.inlinePlanThreshold ?? DEFAULTS.inlinePlanThreshold,
		commitDocs: settings?.commitDocs ?? DEFAULTS.commitDocs,
		contextWindow: settings?.contextWindow ?? DEFAULTS.contextWindow,
		responseLanguage: settings?.responseLanguage ?? DEFAULTS.responseLanguage,
		branchingStrategy: settings?.branchingStrategy ?? DEFAULTS.branchingStrategy,
		gitProvider: settings?.gitProvider ?? DEFAULTS.gitProvider,
		gitProviderBaseUrl: settings?.gitProviderBaseUrl ?? DEFAULTS.gitProviderBaseUrl,
		gitProviderTransport: settings?.gitProviderTransport ?? DEFAULTS.gitProviderTransport,
		gitProviderMcpServer: settings?.gitProviderMcpServer ?? DEFAULTS.gitProviderMcpServer,
		gitProviderMcpPrStatusTool: settings?.gitProviderMcpPrStatusTool ?? DEFAULTS.gitProviderMcpPrStatusTool,
		gitProviderMcpOpenPrTool: settings?.gitProviderMcpOpenPrTool ?? DEFAULTS.gitProviderMcpOpenPrTool,
		gitProviderMcpCommitTool: settings?.gitProviderMcpCommitTool ?? DEFAULTS.gitProviderMcpCommitTool,
		gitProviderMcpSyncTool: settings?.gitProviderMcpSyncTool ?? DEFAULTS.gitProviderMcpSyncTool,
		thinkingPartner: settings?.thinkingPartner ?? DEFAULTS.thinkingPartner,
		globalLearnings: settings?.globalLearnings ?? DEFAULTS.globalLearnings,
		intelEnabled: settings?.intelEnabled ?? DEFAULTS.intelEnabled,
	}
}

const groupClassName = "rounded-sm border border-white/10 bg-black/10 p-3 space-y-3"

const FieldRow = ({ label, description, control }: { label: string; description: string; control: React.ReactNode }) => (
	<div className="space-y-2 py-2">
		<div className="space-y-1">
			<Label className="block text-sm font-medium">{label}</Label>
			<div className="text-xs leading-5 text-description">{description}</div>
		</div>
		<div className="w-full max-w-[320px]">{control}</div>
	</div>
)

const SHELL_META_RE = /[;&|`$<>\\]/

function validateForm(f: GsdFormState): string | null {
	if (f.buildCommand && SHELL_META_RE.test(f.buildCommand)) {
		return 'Build command contains shell metacharacters. Use a plain command like "npm run build" without shell operators.'
	}
	if (f.testCommand && SHELL_META_RE.test(f.testCommand)) {
		return 'Test command contains shell metacharacters. Use a plain command like "npm test" without shell operators.'
	}
	if (f.maxDiscussPasses < 1 || f.maxDiscussPasses > 20) return "Max discuss passes must be between 1 and 20."
	if (f.nodeRepairBudget < 0 || f.nodeRepairBudget > 10) return "Node repair budget must be between 0 and 10."
	if (f.driftThreshold < 1 || f.driftThreshold > 100) return "Drift threshold must be between 1 and 100."
	if (f.subagentTimeout < 30 || f.subagentTimeout > 3600) return "Subagent timeout must be between 30 and 3600 seconds."
	if (f.inlinePlanThreshold < 0 || f.inlinePlanThreshold > 50) return "Inline plan threshold must be between 0 and 50."
	if (f.contextWindow < 1000 || f.contextWindow > 2000000) return "Context window must be between 1,000 and 2,000,000."
	if (f.securityAsvsLevel < 1 || f.securityAsvsLevel > 3) return "Security ASVS level must be 1, 2, or 3."
	return null
}

const GsdSettingsSection = ({ renderSectionHeader }: GsdSettingsSectionProps) => {
	const [loading, setLoading] = useState(true)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [available, setAvailable] = useState(false)
	const [workspacePath, setWorkspacePath] = useState("")
	const [configPath, setConfigPath] = useState("")
	const [planningExists, setPlanningExists] = useState(false)
	const [configExists, setConfigExists] = useState(false)
	const [form, setForm] = useState<GsdFormState>(DEFAULTS)
	const [savedSnapshot, setSavedSnapshot] = useState<GsdFormState>(DEFAULTS)

	const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(savedSnapshot), [form, savedSnapshot])

	const hydrateFromResponse = useCallback((response: GsdSettingsResponse) => {
		const nextForm = responseToForm(response)
		setAvailable(response.available)
		setWorkspacePath(response.workspacePath || "")
		setConfigPath(response.configPath || "")
		setPlanningExists(response.planningExists)
		setConfigExists(response.configExists)
		setForm(nextForm)
		setSavedSnapshot(nextForm)
	}, [])

	const loadSettings = useCallback(async () => {
		setLoading(true)
		setError(null)
		try {
			const response = await StateServiceClient.getGsdSettings(EmptyRequest.create({}))
			hydrateFromResponse(response)
		} catch (err) {
			console.error("Failed to load GSD settings:", err)
			setError("Failed to load GSD settings.")
		} finally {
			setLoading(false)
		}
	}, [hydrateFromResponse])

	useEffect(() => {
		loadSettings()
	}, [loadSettings])

	const setField = useCallback(<K extends keyof GsdFormState>(key: K, value: GsdFormState[K]) => {
		setForm((current) => ({ ...current, [key]: value }))
	}, [])

	const saveSettings = useCallback(async () => {
		const validationError = validateForm(form)
		if (validationError) {
			setError(validationError)
			return
		}
		setSaving(true)
		setError(null)
		try {
			const response = await StateServiceClient.updateGsdSettings(
				UpdateGsdSettingsRequest.create({
					settings: GsdSettings.create({
						modelProfile: form.modelProfile,
						projectResearcherModel: form.projectResearcherModel,
						synthesizerModel: form.synthesizerModel,
						roadmapperModel: form.roadmapperModel,
						mapperModel: form.mapperModel,
						researcherModel: form.researcherModel,
						plannerModel: form.plannerModel,
						checkerModel: form.checkerModel,
						executorModel: form.executorModel,
						verifierModel: form.verifierModel,
						researchEnabled: form.researchEnabled,
						planCheck: form.planCheck,
						autoAdvance: form.autoAdvance,
						discussMode: form.discussMode,
						skipDiscuss: form.skipDiscuss,
						textMode: form.textMode,
						useWorktrees: form.useWorktrees,
						planChunked: form.planChunked,
						tddMode: form.tddMode,
						nyquistValidation: form.nyquistValidation,
						patternMapper: form.patternMapper,
						verifier: form.verifier,
						uiPhase: form.uiPhase,
						uiSafetyGate: form.uiSafetyGate,
						uiReview: form.uiReview,
						aiIntegrationPhase: form.aiIntegrationPhase,
						codeReview: form.codeReview,
						codeReviewDepth: form.codeReviewDepth,
						autoPruneState: form.autoPruneState,
						securityEnforcement: form.securityEnforcement,
						securityAsvsLevel: form.securityAsvsLevel,
						securityBlockOn: form.securityBlockOn,
						driftThreshold: form.driftThreshold,
						driftAction: form.driftAction,
						buildCommand: form.buildCommand,
						testCommand: form.testCommand,
						researchBeforeQuestions: form.researchBeforeQuestions,
						maxDiscussPasses: form.maxDiscussPasses,
						nodeRepair: form.nodeRepair,
						nodeRepairBudget: form.nodeRepairBudget,
						postPlanningGaps: form.postPlanningGaps,
						contextCoverageGate: form.contextCoverageGate,
						subagentTimeout: form.subagentTimeout,
						inlinePlanThreshold: form.inlinePlanThreshold,
						commitDocs: form.commitDocs,
						contextWindow: form.contextWindow,
						responseLanguage: form.responseLanguage,
						branchingStrategy: form.branchingStrategy,
						gitProvider: form.gitProvider,
						gitProviderBaseUrl: form.gitProviderBaseUrl,
						gitProviderTransport: form.gitProviderTransport,
						gitProviderMcpServer: form.gitProviderMcpServer,
						gitProviderMcpPrStatusTool: form.gitProviderMcpPrStatusTool,
						gitProviderMcpOpenPrTool: form.gitProviderMcpOpenPrTool,
						gitProviderMcpCommitTool: form.gitProviderMcpCommitTool,
						gitProviderMcpSyncTool: form.gitProviderMcpSyncTool,
						thinkingPartner: form.thinkingPartner,
						globalLearnings: form.globalLearnings,
						intelEnabled: form.intelEnabled,
					}),
				}),
			)
			hydrateFromResponse(response)
		} catch (err) {
			console.error("Failed to save GSD settings:", err)
			setError("Failed to save GSD settings.")
		} finally {
			setSaving(false)
		}
	}, [form, hydrateFromResponse])

	const parseNumberInput = (value: string, fallback: number, min?: number, max?: number) => {
		const parsed = Number(value)
		if (!Number.isFinite(parsed)) return fallback
		if (min !== undefined && parsed < min) return min
		if (max !== undefined && parsed > max) return max
		return parsed
	}

	return (
		<div>
			{renderSectionHeader("gsd")}
			<Section className="gap-4">
				<div className="rounded-sm border border-white/10 bg-black/10 p-3">
					<div className="space-y-1">
						<div className="text-sm font-medium">Workspace-local GSD settings</div>
						<div className="text-xs text-description">
							These values are written to the active workspace&apos;s <code>.planning/config.json</code> and control
							how the bundled <code>gsd-sdk</code> and GSD workflows behave.
						</div>
						{available && (
							<div className="space-y-1 text-xs text-description">
								<div>
									Workspace: <code className="break-all whitespace-pre-wrap">{workspacePath}</code>
								</div>
								<div>
									Config:{" "}
									<code className="break-all whitespace-pre-wrap">{configPath || ".planning/config.json"}</code>
								</div>
								<div>
									Status:{" "}
									{configExists
										? "existing config loaded"
										: planningExists
											? "config missing; save will create it"
											: "planning dir missing; save will create it"}
								</div>
							</div>
						)}
					</div>
					<div className="mt-3 flex flex-wrap items-center gap-2">
						<Button disabled={loading || saving} onClick={loadSettings} size="sm" variant="outline">
							<RefreshCcw />
							Reload
						</Button>
						<Button disabled={loading || saving || !available || !dirty} onClick={saveSettings} size="sm">
							<Save />
							Save GSD Settings
						</Button>
					</div>
				</div>

				{error && <div className="text-sm text-orange-400">{error}</div>}
				{loading && <div className="text-sm text-description">Loading GSD settings…</div>}
				{!loading && !available && (
					<div className="text-sm text-description">
						No active workspace is available, so GSD settings can’t be edited right now.
					</div>
				)}

				{!loading && available && (
					<>
						<div className={groupClassName}>
							<div className="text-sm font-medium">Model routing</div>
							<FieldRow
								control={
									<Select onValueChange={(value) => setField("modelProfile", value)} value={form.modelProfile}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="quality">Quality</SelectItem>
											<SelectItem value="balanced">Balanced</SelectItem>
											<SelectItem value="budget">Budget</SelectItem>
											<SelectItem value="adaptive">Adaptive</SelectItem>
											<SelectItem value="inherit">Inherit</SelectItem>
										</SelectContent>
									</Select>
								}
								description="Baseline GSD model profile stored in .planning/config.json."
								label="Model profile"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("plannerModel", event.target.value)}
										placeholder="e.g. gpt-5.4"
										value={form.plannerModel}
									/>
								}
								description="Override the planning agent used by /gsd-plan-phase and other plan-generation flows."
								label="Planner model override"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("researcherModel", event.target.value)}
										placeholder="e.g. gpt-5.4-mini"
										value={form.researcherModel}
									/>
								}
								description="Override the phase researcher used by discuss and plan workflows."
								label="Phase researcher model override"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("checkerModel", event.target.value)}
										placeholder="e.g. gpt-5.4"
										value={form.checkerModel}
									/>
								}
								description="Override the plan checker used to validate plans before execution."
								label="Plan checker model override"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("executorModel", event.target.value)}
										placeholder="e.g. gpt-5.4"
										value={form.executorModel}
									/>
								}
								description="Override the executor used for implementation work."
								label="Executor model override"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("verifierModel", event.target.value)}
										placeholder="e.g. gpt-5.4-mini"
										value={form.verifierModel}
									/>
								}
								description="Override the verifier used for post-execution checks."
								label="Verifier model override"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("mapperModel", event.target.value)}
										placeholder="e.g. gpt-5.4-mini"
										value={form.mapperModel}
									/>
								}
								description="Override the codebase mapper used by /gsd-map-codebase and drift-remap flows."
								label="Codebase mapper model override"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("projectResearcherModel", event.target.value)}
										placeholder="e.g. gpt-5.4"
										value={form.projectResearcherModel}
									/>
								}
								description="Override the researcher used during /gsd-new-project and /gsd-new-milestone."
								label="Project researcher model override"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("synthesizerModel", event.target.value)}
										placeholder="e.g. gpt-5.4"
										value={form.synthesizerModel}
									/>
								}
								description="Override the synthesizer that consolidates project research into planning artifacts."
								label="Synthesizer model override"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("roadmapperModel", event.target.value)}
										placeholder="e.g. gpt-5.4"
										value={form.roadmapperModel}
									/>
								}
								description="Override the roadmapper used to produce roadmap structure during project initialization."
								label="Roadmapper model override"
							/>
						</div>

						<div className={groupClassName}>
							<div className="text-sm font-medium">Project defaults</div>
							<FieldRow
								control={
									<Switch
										checked={form.commitDocs}
										onCheckedChange={(checked) => setField("commitDocs", checked)}
										size="lg"
									/>
								}
								description="Commit .planning artifacts to git by default so roadmap, plans, and state stay versioned."
								label="Commit planning docs"
							/>
							<FieldRow
								control={
									<Select
										onValueChange={(value) => setField("branchingStrategy", value)}
										value={form.branchingStrategy}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="none">None</SelectItem>
											<SelectItem value="phase">Phase branches</SelectItem>
											<SelectItem value="milestone">Milestone branches</SelectItem>
										</SelectContent>
									</Select>
								}
								description="Choose whether GSD stays on the current branch or creates isolated branches per phase or milestone."
								label="Branching strategy"
							/>
							<FieldRow
								control={
									<Select onValueChange={(value) => setField("gitProvider", value)} value={form.gitProvider}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="github">GitHub</SelectItem>
											<SelectItem value="gitea">Gitea</SelectItem>
											<SelectItem value="gitlab">GitLab</SelectItem>
											<SelectItem value="bitbucket">Bitbucket</SelectItem>
											<SelectItem value="custom">Custom</SelectItem>
										</SelectContent>
									</Select>
								}
								description="Select the git hosting provider Tasktronaut should assume when it prepares pull request links and delivery actions."
								label="Git provider"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("gitProviderBaseUrl", event.target.value)}
										placeholder="Optional override, e.g. https://gitea.internal.example.com"
										value={form.gitProviderBaseUrl}
									/>
								}
								description="Optional base URL override for self-hosted providers. Leave blank to infer the host from the git remote."
								label="Provider base URL"
							/>
							<FieldRow
								control={
									<Select onValueChange={(value) => setField("gitProviderTransport", value)} value={form.gitProviderTransport}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="web">Web / CLI</SelectItem>
											<SelectItem value="mcp">MCP bridge</SelectItem>
										</SelectContent>
									</Select>
								}
								description="Choose whether Tasktronaut uses its built-in web/CLI integrations now or treats the provider as an MCP-routed surface."
								label="Provider transport"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("gitProviderMcpServer", event.target.value)}
										placeholder="Optional server id, e.g. gitea"
										value={form.gitProviderMcpServer}
									/>
								}
								description="Optional MCP server identifier reserved for future provider integration. This is useful when your organization routes PR actions through a custom MCP server."
								label="Provider MCP server"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("gitProviderMcpPrStatusTool", event.target.value)}
										placeholder="Optional tool name, e.g. pr_status"
										value={form.gitProviderMcpPrStatusTool}
									/>
								}
								description="Optional MCP tool used for read-only PR status and mergeability checks when provider transport is set to MCP."
								label="MCP PR status tool"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("gitProviderMcpOpenPrTool", event.target.value)}
										placeholder="Optional tool name, e.g. open_pr"
										value={form.gitProviderMcpOpenPrTool}
									/>
								}
								description="Optional MCP tool used for human-confirmed PR actions when provider transport is set to MCP."
								label="MCP PR action tool"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("gitProviderMcpCommitTool", event.target.value)}
										placeholder="Optional tool name, e.g. commit_changes"
										value={form.gitProviderMcpCommitTool}
									/>
								}
								description="Optional MCP tool used for human-confirmed commit actions when provider transport is set to MCP."
								label="MCP commit tool"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("gitProviderMcpSyncTool", event.target.value)}
										placeholder="Optional tool name, e.g. sync_branch"
										value={form.gitProviderMcpSyncTool}
									/>
								}
								description="Optional MCP tool used for human-confirmed sync actions when provider transport is set to MCP."
								label="MCP sync tool"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) =>
											setField("contextWindow", parseNumberInput(event.target.value, form.contextWindow, 1000, 2000000))
										}
										type="number"
										value={String(form.contextWindow)}
									/>
								}
								description="Context window budget used when workflows branch on small versus large-context behavior."
								label="Context window"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("responseLanguage", event.target.value)}
										placeholder="e.g. English, Portuguese, Japanese"
										value={form.responseLanguage}
									/>
								}
								description="Optional language hint propagated into workflow outputs and agent responses."
								label="Response language"
							/>
						</div>

						<div className={groupClassName}>
							<div className="text-sm font-medium">Advanced workflow features</div>
							<FieldRow
								control={
									<Switch
										checked={form.thinkingPartner}
										onCheckedChange={(checked) => setField("thinkingPartner", checked)}
										size="lg"
									/>
								}
								description="Enable deeper tradeoff analysis at discuss and planning decision points when the workflow asks for it."
								label="Thinking partner"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.globalLearnings}
										onCheckedChange={(checked) => setField("globalLearnings", checked)}
										size="lg"
									/>
								}
								description="Inject reusable cross-project learnings into agent prompts when your local GSD learnings store has them."
								label="Global learnings"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.intelEnabled}
										onCheckedChange={(checked) => setField("intelEnabled", checked)}
										size="lg"
									/>
								}
								description="Enable the codebase intelligence index that powers `/gsd-intel` and related query flows."
								label="Intel enabled"
							/>
						</div>

						<div className={groupClassName}>
							<div className="text-sm font-medium">Planning</div>
							<FieldRow
								control={
									<Switch
										checked={form.researchEnabled}
										onCheckedChange={(checked) => setField("researchEnabled", checked)}
										size="lg"
									/>
								}
								description="Run the dedicated research pass before planning phases and project setup flows."
								label="Research enabled"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.planCheck}
										onCheckedChange={(checked) => setField("planCheck", checked)}
										size="lg"
									/>
								}
								description="Run the plan-checker loop to validate generated plans before execution."
								label="Plan checker enabled"
							/>
							<FieldRow
								control={
									<Select onValueChange={(value) => setField("discussMode", value)} value={form.discussMode}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="discuss">Discuss</SelectItem>
											<SelectItem value="assumptions">Assumptions</SelectItem>
										</SelectContent>
									</Select>
								}
								description="Choose whether discuss-phase asks questions directly or starts from evidence-backed assumptions."
								label="Discuss mode"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.skipDiscuss}
										onCheckedChange={(checked) => setField("skipDiscuss", checked)}
										size="lg"
									/>
								}
								description="Skip discuss-phase in autonomous flows and rely on roadmap plus existing project context."
								label="Skip discuss in auto mode"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.autoAdvance}
										onCheckedChange={(checked) => setField("autoAdvance", checked)}
										size="lg"
									/>
								}
								description="Automatically chain discuss, plan, and execute flows when a workflow supports it."
								label="Auto advance"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.textMode}
										onCheckedChange={(checked) => setField("textMode", checked)}
										size="lg"
									/>
								}
								description="Use plain-text numbered choices instead of richer interactive prompts for runtimes where menus don’t render well."
								label="Text mode"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.planChunked}
										onCheckedChange={(checked) => setField("planChunked", checked)}
										size="lg"
									/>
								}
								description="Break long plan-phase runs into smaller resumable planning tasks, which is especially useful on Windows."
								label="Chunked planning"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.tddMode}
										onCheckedChange={(checked) => setField("tddMode", checked)}
										size="lg"
									/>
								}
								description="Bias planning and execution toward RED/GREEN/REFACTOR style task flows."
								label="TDD mode"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.researchBeforeQuestions}
										onCheckedChange={(checked) => setField("researchBeforeQuestions", checked)}
										size="lg"
									/>
								}
								description="Do a codebase-first pass before presenting discuss-phase questions."
								label="Research before questions"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) =>
											setField(
												"maxDiscussPasses",
												parseNumberInput(event.target.value, form.maxDiscussPasses, 1, 20),
											)
										}
										type="number"
										value={String(form.maxDiscussPasses)}
									/>
								}
								description="Limit how many rounds discuss-phase will keep asking before stopping."
								label="Max discuss passes"
							/>
						</div>

						<div className={groupClassName}>
							<div className="text-sm font-medium">Execution</div>
							<FieldRow
								control={
									<Switch
										checked={form.useWorktrees}
										onCheckedChange={(checked) => setField("useWorktrees", checked)}
										size="lg"
									/>
								}
								description="Run parallel executor agents in isolated git worktrees instead of sharing one checkout."
								label="Use worktrees"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.verifier}
										onCheckedChange={(checked) => setField("verifier", checked)}
										size="lg"
									/>
								}
								description="Run the goal-backward verifier after execution to check that a phase actually met its intent."
								label="Verifier"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.nodeRepair}
										onCheckedChange={(checked) => setField("nodeRepair", checked)}
										size="lg"
									/>
								}
								description="Allow the automated repair loop to respond to failed execution or verification tasks."
								label="Node repair"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) =>
											setField(
												"nodeRepairBudget",
												parseNumberInput(event.target.value, form.nodeRepairBudget, 0, 10),
											)
										}
										type="number"
										value={String(form.nodeRepairBudget)}
									/>
								}
								description="Set how many automated repair attempts a failed task gets before the workflow stops."
								label="Node repair budget"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("buildCommand", event.target.value)}
										value={form.buildCommand}
									/>
								}
								description="Override the post-merge build gate with an explicit command. Leave blank to use GSD’s auto-detection."
								label="Build command"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) => setField("testCommand", event.target.value)}
										value={form.testCommand}
									/>
								}
								description="Override the post-merge test gate with an explicit command. Leave blank to use GSD’s auto-detection."
								label="Test command"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) =>
											setField(
												"subagentTimeout",
												parseNumberInput(event.target.value, form.subagentTimeout, 30, 3600),
											)
										}
										type="number"
										value={String(form.subagentTimeout)}
									/>
								}
								description="Maximum runtime per subagent before GSD considers it timed out."
								label="Subagent timeout (seconds)"
							/>
							<FieldRow
								control={
									<Input
										onChange={(event) =>
											setField(
												"inlinePlanThreshold",
												parseNumberInput(event.target.value, form.inlinePlanThreshold, 0, 50),
											)
										}
										type="number"
										value={String(form.inlinePlanThreshold)}
									/>
								}
								description="Plans at or below this task count can execute inline instead of paying the spawn overhead of a subagent."
								label="Inline plan threshold"
							/>
						</div>

						<div className={groupClassName}>
							<div className="text-sm font-medium">Quality and gates</div>
							<FieldRow
								control={
									<Switch
										checked={form.securityEnforcement}
										onCheckedChange={(checked) => setField("securityEnforcement", checked)}
										size="lg"
									/>
								}
								description="Enable threat-model-driven security verification and blocking behavior in security workflows."
								label="Security enforcement"
							/>
							<FieldRow
								control={
									<Select
										onValueChange={(value) =>
											setField("securityAsvsLevel", parseNumberInput(value, form.securityAsvsLevel, 1, 3))
										}
										value={String(form.securityAsvsLevel)}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="1">ASVS 1</SelectItem>
											<SelectItem value="2">ASVS 2</SelectItem>
											<SelectItem value="3">ASVS 3</SelectItem>
										</SelectContent>
									</Select>
								}
								description="Choose the OWASP ASVS validation depth used by security-oriented workflow checks."
								label="Security ASVS level"
							/>
							<FieldRow
								control={
									<Select
										onValueChange={(value) => setField("securityBlockOn", value)}
										value={form.securityBlockOn}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="high">High</SelectItem>
											<SelectItem value="medium">Medium</SelectItem>
											<SelectItem value="low">Low</SelectItem>
										</SelectContent>
									</Select>
								}
								description="Minimum security severity that should block phase advancement."
								label="Security block threshold"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.nyquistValidation}
										onCheckedChange={(checked) => setField("nyquistValidation", checked)}
										size="lg"
									/>
								}
								description="Keep validation architecture and coverage planning enabled during plan-phase research."
								label="Nyquist validation"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.patternMapper}
										onCheckedChange={(checked) => setField("patternMapper", checked)}
										size="lg"
									/>
								}
								description="Run the pattern-mapper between research and planning to match new work to existing code patterns."
								label="Pattern mapper"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.uiPhase}
										onCheckedChange={(checked) => setField("uiPhase", checked)}
										size="lg"
									/>
								}
								description="Enable UI design contracts for frontend-heavy phases."
								label="UI phase"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.uiSafetyGate}
										onCheckedChange={(checked) => setField("uiSafetyGate", checked)}
										size="lg"
									/>
								}
								description="Prompt for `/gsd-ui-phase` before planning frontend phases."
								label="UI safety gate"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.uiReview}
										onCheckedChange={(checked) => setField("uiReview", checked)}
										size="lg"
									/>
								}
								description="Run the dedicated UI review workflow when frontend phases need visual quality checks."
								label="UI review"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.aiIntegrationPhase}
										onCheckedChange={(checked) => setField("aiIntegrationPhase", checked)}
										size="lg"
									/>
								}
								description="Enable the AI framework selection and evaluation planning workflow for AI-heavy phases."
								label="AI integration phase"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.autoPruneState}
										onCheckedChange={(checked) => setField("autoPruneState", checked)}
										size="lg"
									/>
								}
								description="Automatically prune older STATE.md entries at phase boundaries."
								label="Auto-prune state"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.codeReview}
										onCheckedChange={(checked) => setField("codeReview", checked)}
										size="lg"
									/>
								}
								description="Enable the GSD code review workflows."
								label="Code review"
							/>
							<FieldRow
								control={
									<Select
										onValueChange={(value) => setField("codeReviewDepth", value)}
										value={form.codeReviewDepth}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="quick">Quick</SelectItem>
											<SelectItem value="standard">Standard</SelectItem>
											<SelectItem value="deep">Deep</SelectItem>
										</SelectContent>
									</Select>
								}
								description="Choose the default review depth for the review workflow."
								label="Code review depth"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.postPlanningGaps}
										onCheckedChange={(checked) => setField("postPlanningGaps", checked)}
										size="lg"
									/>
								}
								description="Generate the non-blocking gap report after plans are created."
								label="Post-planning gaps"
							/>
							<FieldRow
								control={
									<Switch
										checked={form.contextCoverageGate}
										onCheckedChange={(checked) => setField("contextCoverageGate", checked)}
										size="lg"
									/>
								}
								description="Require plans to demonstrate coverage of the decisions captured during discuss and research."
								label="Context coverage gate"
							/>
						</div>

						<div className={groupClassName}>
							<div className="text-sm font-medium">Codebase drift</div>
							<FieldRow
								control={
									<Input
										onChange={(event) =>
											setField("driftThreshold", parseNumberInput(event.target.value, form.driftThreshold, 1, 100))
										}
										type="number"
										value={String(form.driftThreshold)}
									/>
								}
								description="How many structural changes a phase can introduce before the drift gate reacts."
								label="Drift threshold"
							/>
							<FieldRow
								control={
									<Select onValueChange={(value) => setField("driftAction", value)} value={form.driftAction}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="warn">Warn</SelectItem>
											<SelectItem value="auto-remap">Auto-remap</SelectItem>
										</SelectContent>
									</Select>
								}
								description="Choose whether the drift gate only warns or automatically remaps the affected codebase area."
								label="Drift action"
							/>
						</div>
					</>
				)}
			</Section>
		</div>
	)
}

export default GsdSettingsSection
