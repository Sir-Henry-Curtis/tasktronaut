import { GsdSettings, GsdSettingsResponse, UpdateGsdSettingsRequest } from "@shared/proto/cline/state"
import { existsSync, readFileSync } from "fs"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { getWorkspacePath } from "@/utils/path"

type JsonObject = Record<string, unknown>

type WorkflowConfig = {
	research?: boolean
	plan_check?: boolean
	auto_advance?: boolean
	discuss_mode?: string
	skip_discuss?: boolean
	text_mode?: boolean
	use_worktrees?: boolean
	plan_chunked?: boolean
	tdd_mode?: boolean
	nyquist_validation?: boolean
	pattern_mapper?: boolean
	verifier?: boolean
	ui_phase?: boolean
	ui_safety_gate?: boolean
	ui_review?: boolean
	ai_integration_phase?: boolean
	code_review?: boolean
	code_review_depth?: string
	auto_prune_state?: boolean
	security_enforcement?: boolean
	security_asvs_level?: number
	security_block_on?: string
	drift_threshold?: number
	drift_action?: string
	build_command?: string
	test_command?: string
	research_before_questions?: boolean
	max_discuss_passes?: number
	node_repair?: boolean
	node_repair_budget?: number
	post_planning_gaps?: boolean
	context_coverage_gate?: boolean
	subagent_timeout?: number
	inline_plan_threshold?: number
}

type ModelOverridesConfig = {
	"gsd-project-researcher"?: string
	"gsd-research-synthesizer"?: string
	"gsd-roadmapper"?: string
	"gsd-codebase-mapper"?: string
	"gsd-phase-researcher"?: string
	"gsd-planner"?: string
	"gsd-plan-checker"?: string
	"gsd-executor"?: string
	"gsd-verifier"?: string
}

type GitConfig = {
	branching_strategy?: string
	provider?: string
	provider_base_url?: string
	provider_transport?: string
	provider_mcp_server?: string
	provider_mcp_pr_status_tool?: string
	provider_mcp_open_pr_tool?: string
	provider_mcp_commit_tool?: string
	provider_mcp_sync_tool?: string
}

type FeaturesConfig = {
	thinking_partner?: boolean
	global_learnings?: boolean
}

type IntelConfig = {
	enabled?: boolean
}

type GsdSettingsData = {
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

const GSD_SETTINGS_DEFAULTS: GsdSettingsData = {
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

function readJsonSafe(filePath: string): JsonObject {
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as JsonObject
	} catch {
		return {}
	}
}

function toProtoSettings(data: GsdSettingsData): GsdSettings {
	return GsdSettings.create({
		modelProfile: data.modelProfile,
		projectResearcherModel: data.projectResearcherModel,
		synthesizerModel: data.synthesizerModel,
		roadmapperModel: data.roadmapperModel,
		mapperModel: data.mapperModel,
		researcherModel: data.researcherModel,
		plannerModel: data.plannerModel,
		checkerModel: data.checkerModel,
		executorModel: data.executorModel,
		verifierModel: data.verifierModel,
		researchEnabled: data.researchEnabled,
		planCheck: data.planCheck,
		autoAdvance: data.autoAdvance,
		discussMode: data.discussMode,
		skipDiscuss: data.skipDiscuss,
		textMode: data.textMode,
		useWorktrees: data.useWorktrees,
		planChunked: data.planChunked,
		tddMode: data.tddMode,
		nyquistValidation: data.nyquistValidation,
		patternMapper: data.patternMapper,
		verifier: data.verifier,
		uiPhase: data.uiPhase,
		uiSafetyGate: data.uiSafetyGate,
		uiReview: data.uiReview,
		aiIntegrationPhase: data.aiIntegrationPhase,
		codeReview: data.codeReview,
		codeReviewDepth: data.codeReviewDepth,
		autoPruneState: data.autoPruneState,
		securityEnforcement: data.securityEnforcement,
		securityAsvsLevel: data.securityAsvsLevel,
		securityBlockOn: data.securityBlockOn,
		driftThreshold: data.driftThreshold,
		driftAction: data.driftAction,
		buildCommand: data.buildCommand,
		testCommand: data.testCommand,
		researchBeforeQuestions: data.researchBeforeQuestions,
		maxDiscussPasses: data.maxDiscussPasses,
		nodeRepair: data.nodeRepair,
		nodeRepairBudget: data.nodeRepairBudget,
		postPlanningGaps: data.postPlanningGaps,
		contextCoverageGate: data.contextCoverageGate,
		subagentTimeout: data.subagentTimeout,
		inlinePlanThreshold: data.inlinePlanThreshold,
		commitDocs: data.commitDocs,
		contextWindow: data.contextWindow,
		responseLanguage: data.responseLanguage,
		branchingStrategy: data.branchingStrategy,
		gitProvider: data.gitProvider,
		gitProviderBaseUrl: data.gitProviderBaseUrl,
		gitProviderTransport: data.gitProviderTransport,
		gitProviderMcpServer: data.gitProviderMcpServer,
		gitProviderMcpPrStatusTool: data.gitProviderMcpPrStatusTool,
		gitProviderMcpOpenPrTool: data.gitProviderMcpOpenPrTool,
		gitProviderMcpCommitTool: data.gitProviderMcpCommitTool,
		gitProviderMcpSyncTool: data.gitProviderMcpSyncTool,
		thinkingPartner: data.thinkingPartner,
		globalLearnings: data.globalLearnings,
		intelEnabled: data.intelEnabled,
	})
}

function fromConfig(config: JsonObject): GsdSettingsData {
	const workflow: WorkflowConfig =
		config.workflow && typeof config.workflow === "object" ? (config.workflow as WorkflowConfig) : {}
	const git: GitConfig = config.git && typeof config.git === "object" ? (config.git as GitConfig) : {}
	const features: FeaturesConfig =
		config.features && typeof config.features === "object" ? (config.features as FeaturesConfig) : {}
	const intel: IntelConfig = config.intel && typeof config.intel === "object" ? (config.intel as IntelConfig) : {}
	const modelOverrides: ModelOverridesConfig =
		config.model_overrides && typeof config.model_overrides === "object"
			? (config.model_overrides as ModelOverridesConfig)
			: {}

	return {
		modelProfile: typeof config.model_profile === "string" ? config.model_profile : GSD_SETTINGS_DEFAULTS.modelProfile,
		projectResearcherModel:
			typeof modelOverrides["gsd-project-researcher"] === "string"
				? modelOverrides["gsd-project-researcher"]
				: GSD_SETTINGS_DEFAULTS.projectResearcherModel,
		synthesizerModel:
			typeof modelOverrides["gsd-research-synthesizer"] === "string"
				? modelOverrides["gsd-research-synthesizer"]
				: GSD_SETTINGS_DEFAULTS.synthesizerModel,
		roadmapperModel:
			typeof modelOverrides["gsd-roadmapper"] === "string"
				? modelOverrides["gsd-roadmapper"]
				: GSD_SETTINGS_DEFAULTS.roadmapperModel,
		mapperModel:
			typeof modelOverrides["gsd-codebase-mapper"] === "string"
				? modelOverrides["gsd-codebase-mapper"]
				: GSD_SETTINGS_DEFAULTS.mapperModel,
		researcherModel:
			typeof modelOverrides["gsd-phase-researcher"] === "string"
				? modelOverrides["gsd-phase-researcher"]
				: GSD_SETTINGS_DEFAULTS.researcherModel,
		plannerModel:
			typeof modelOverrides["gsd-planner"] === "string"
				? modelOverrides["gsd-planner"]
				: GSD_SETTINGS_DEFAULTS.plannerModel,
		checkerModel:
			typeof modelOverrides["gsd-plan-checker"] === "string"
				? modelOverrides["gsd-plan-checker"]
				: GSD_SETTINGS_DEFAULTS.checkerModel,
		executorModel:
			typeof modelOverrides["gsd-executor"] === "string"
				? modelOverrides["gsd-executor"]
				: GSD_SETTINGS_DEFAULTS.executorModel,
		verifierModel:
			typeof modelOverrides["gsd-verifier"] === "string"
				? modelOverrides["gsd-verifier"]
				: GSD_SETTINGS_DEFAULTS.verifierModel,
		researchEnabled: workflow.research !== false,
		planCheck: workflow.plan_check !== false,
		autoAdvance: workflow.auto_advance === true,
		discussMode: typeof workflow.discuss_mode === "string" ? workflow.discuss_mode : GSD_SETTINGS_DEFAULTS.discussMode,
		skipDiscuss: workflow.skip_discuss === true,
		textMode: workflow.text_mode === true,
		useWorktrees: workflow.use_worktrees !== false,
		planChunked: workflow.plan_chunked === true,
		tddMode: workflow.tdd_mode === true,
		nyquistValidation: workflow.nyquist_validation !== false,
		patternMapper: workflow.pattern_mapper !== false,
		verifier: workflow.verifier !== false,
		uiPhase: workflow.ui_phase !== false,
		uiSafetyGate: workflow.ui_safety_gate !== false,
		uiReview: workflow.ui_review !== false,
		aiIntegrationPhase: workflow.ai_integration_phase !== false,
		codeReview: workflow.code_review !== false,
		codeReviewDepth:
			typeof workflow.code_review_depth === "string" ? workflow.code_review_depth : GSD_SETTINGS_DEFAULTS.codeReviewDepth,
		autoPruneState: workflow.auto_prune_state === true,
		securityEnforcement: workflow.security_enforcement !== false,
		securityAsvsLevel:
			typeof workflow.security_asvs_level === "number"
				? workflow.security_asvs_level
				: GSD_SETTINGS_DEFAULTS.securityAsvsLevel,
		securityBlockOn:
			typeof workflow.security_block_on === "string" ? workflow.security_block_on : GSD_SETTINGS_DEFAULTS.securityBlockOn,
		driftThreshold:
			typeof workflow.drift_threshold === "number" ? workflow.drift_threshold : GSD_SETTINGS_DEFAULTS.driftThreshold,
		driftAction: typeof workflow.drift_action === "string" ? workflow.drift_action : GSD_SETTINGS_DEFAULTS.driftAction,
		buildCommand: typeof workflow.build_command === "string" ? workflow.build_command : GSD_SETTINGS_DEFAULTS.buildCommand,
		testCommand: typeof workflow.test_command === "string" ? workflow.test_command : GSD_SETTINGS_DEFAULTS.testCommand,
		researchBeforeQuestions: workflow.research_before_questions === true,
		maxDiscussPasses:
			typeof workflow.max_discuss_passes === "number"
				? workflow.max_discuss_passes
				: GSD_SETTINGS_DEFAULTS.maxDiscussPasses,
		nodeRepair: workflow.node_repair !== false,
		nodeRepairBudget:
			typeof workflow.node_repair_budget === "number"
				? workflow.node_repair_budget
				: GSD_SETTINGS_DEFAULTS.nodeRepairBudget,
		postPlanningGaps: workflow.post_planning_gaps !== false,
		contextCoverageGate: workflow.context_coverage_gate !== false,
		subagentTimeout:
			typeof workflow.subagent_timeout === "number" ? workflow.subagent_timeout : GSD_SETTINGS_DEFAULTS.subagentTimeout,
		inlinePlanThreshold:
			typeof workflow.inline_plan_threshold === "number"
				? workflow.inline_plan_threshold
				: GSD_SETTINGS_DEFAULTS.inlinePlanThreshold,
		commitDocs: config.commit_docs !== false,
		contextWindow: typeof config.context_window === "number" ? config.context_window : GSD_SETTINGS_DEFAULTS.contextWindow,
		responseLanguage:
			typeof config.response_language === "string" ? config.response_language : GSD_SETTINGS_DEFAULTS.responseLanguage,
		branchingStrategy:
			typeof git.branching_strategy === "string" ? git.branching_strategy : GSD_SETTINGS_DEFAULTS.branchingStrategy,
		gitProvider: typeof git.provider === "string" ? git.provider : GSD_SETTINGS_DEFAULTS.gitProvider,
		gitProviderBaseUrl:
			typeof git.provider_base_url === "string" ? git.provider_base_url : GSD_SETTINGS_DEFAULTS.gitProviderBaseUrl,
		gitProviderTransport:
			typeof git.provider_transport === "string" ? git.provider_transport : GSD_SETTINGS_DEFAULTS.gitProviderTransport,
		gitProviderMcpServer:
			typeof git.provider_mcp_server === "string" ? git.provider_mcp_server : GSD_SETTINGS_DEFAULTS.gitProviderMcpServer,
		gitProviderMcpPrStatusTool:
			typeof git.provider_mcp_pr_status_tool === "string"
				? git.provider_mcp_pr_status_tool
				: GSD_SETTINGS_DEFAULTS.gitProviderMcpPrStatusTool,
		gitProviderMcpOpenPrTool:
			typeof git.provider_mcp_open_pr_tool === "string"
				? git.provider_mcp_open_pr_tool
				: GSD_SETTINGS_DEFAULTS.gitProviderMcpOpenPrTool,
		gitProviderMcpCommitTool:
			typeof git.provider_mcp_commit_tool === "string"
				? git.provider_mcp_commit_tool
				: GSD_SETTINGS_DEFAULTS.gitProviderMcpCommitTool,
		gitProviderMcpSyncTool:
			typeof git.provider_mcp_sync_tool === "string"
				? git.provider_mcp_sync_tool
				: GSD_SETTINGS_DEFAULTS.gitProviderMcpSyncTool,
		thinkingPartner: features.thinking_partner === true,
		globalLearnings: features.global_learnings === true,
		intelEnabled: intel.enabled === true,
	}
}

function applySettingsPatch(config: JsonObject, patch?: GsdSettings): JsonObject {
	const next = { ...config }
	const workflow: WorkflowConfig =
		next.workflow && typeof next.workflow === "object" ? { ...(next.workflow as WorkflowConfig) } : {}
	const modelOverrides: ModelOverridesConfig =
		next.model_overrides && typeof next.model_overrides === "object"
			? { ...(next.model_overrides as ModelOverridesConfig) }
			: {}
	const git: GitConfig = next.git && typeof next.git === "object" ? { ...(next.git as GitConfig) } : {}
	const features: FeaturesConfig =
		next.features && typeof next.features === "object" ? { ...(next.features as FeaturesConfig) } : {}
	const intel: IntelConfig = next.intel && typeof next.intel === "object" ? { ...(next.intel as IntelConfig) } : {}

	const assignIfDefined = <T>(value: T | undefined, assign: (resolved: T) => void) => {
		if (value !== undefined && value !== null) {
			assign(value)
		}
	}

	const assignOverride = (agentName: keyof ModelOverridesConfig, value: string | undefined) => {
		if (value === undefined || value === null) {
			return
		}

		const normalized = value.trim()
		if (normalized) {
			modelOverrides[agentName] = normalized
		} else {
			delete modelOverrides[agentName]
		}
	}

	assignIfDefined(patch?.modelProfile, (v) => {
		next.model_profile = v
	})
	assignOverride("gsd-project-researcher", patch?.projectResearcherModel)
	assignOverride("gsd-research-synthesizer", patch?.synthesizerModel)
	assignOverride("gsd-roadmapper", patch?.roadmapperModel)
	assignOverride("gsd-codebase-mapper", patch?.mapperModel)
	assignOverride("gsd-phase-researcher", patch?.researcherModel)
	assignOverride("gsd-planner", patch?.plannerModel)
	assignOverride("gsd-plan-checker", patch?.checkerModel)
	assignOverride("gsd-executor", patch?.executorModel)
	assignOverride("gsd-verifier", patch?.verifierModel)
	assignIfDefined(patch?.researchEnabled, (v) => {
		workflow.research = v
	})
	assignIfDefined(patch?.planCheck, (v) => {
		workflow.plan_check = v
	})

	assignIfDefined(patch?.autoAdvance, (v) => {
		workflow.auto_advance = v
	})
	assignIfDefined(patch?.discussMode, (v) => {
		workflow.discuss_mode = v
	})
	assignIfDefined(patch?.skipDiscuss, (v) => {
		workflow.skip_discuss = v
	})
	assignIfDefined(patch?.textMode, (v) => {
		workflow.text_mode = v
	})
	assignIfDefined(patch?.useWorktrees, (v) => {
		workflow.use_worktrees = v
	})
	assignIfDefined(patch?.planChunked, (v) => {
		workflow.plan_chunked = v
	})
	assignIfDefined(patch?.tddMode, (v) => {
		workflow.tdd_mode = v
	})
	assignIfDefined(patch?.nyquistValidation, (v) => {
		workflow.nyquist_validation = v
	})
	assignIfDefined(patch?.patternMapper, (v) => {
		workflow.pattern_mapper = v
	})
	assignIfDefined(patch?.verifier, (v) => {
		workflow.verifier = v
	})
	assignIfDefined(patch?.uiPhase, (v) => {
		workflow.ui_phase = v
	})
	assignIfDefined(patch?.uiSafetyGate, (v) => {
		workflow.ui_safety_gate = v
	})
	assignIfDefined(patch?.uiReview, (v) => {
		workflow.ui_review = v
	})
	assignIfDefined(patch?.aiIntegrationPhase, (v) => {
		workflow.ai_integration_phase = v
	})
	assignIfDefined(patch?.codeReview, (v) => {
		workflow.code_review = v
	})
	assignIfDefined(patch?.codeReviewDepth, (v) => {
		workflow.code_review_depth = v
	})
	assignIfDefined(patch?.autoPruneState, (v) => {
		workflow.auto_prune_state = v
	})
	assignIfDefined(patch?.securityEnforcement, (v) => {
		workflow.security_enforcement = v
	})
	assignIfDefined(patch?.securityAsvsLevel, (v) => {
		workflow.security_asvs_level = v
	})
	assignIfDefined(patch?.securityBlockOn, (v) => {
		workflow.security_block_on = v
	})
	assignIfDefined(patch?.driftThreshold, (v) => {
		workflow.drift_threshold = v
	})
	assignIfDefined(patch?.driftAction, (v) => {
		workflow.drift_action = v
	})
	assignIfDefined(patch?.buildCommand, (v) => {
		workflow.build_command = v
	})
	assignIfDefined(patch?.testCommand, (v) => {
		workflow.test_command = v
	})
	assignIfDefined(patch?.researchBeforeQuestions, (v) => {
		workflow.research_before_questions = v
	})
	assignIfDefined(patch?.maxDiscussPasses, (v) => {
		workflow.max_discuss_passes = v
	})
	assignIfDefined(patch?.nodeRepair, (v) => {
		workflow.node_repair = v
	})
	assignIfDefined(patch?.nodeRepairBudget, (v) => {
		workflow.node_repair_budget = v
	})
	assignIfDefined(patch?.postPlanningGaps, (v) => {
		workflow.post_planning_gaps = v
	})
	assignIfDefined(patch?.contextCoverageGate, (v) => {
		workflow.context_coverage_gate = v
	})
	assignIfDefined(patch?.subagentTimeout, (v) => {
		workflow.subagent_timeout = v
	})
	assignIfDefined(patch?.inlinePlanThreshold, (v) => {
		workflow.inline_plan_threshold = v
	})
	assignIfDefined(patch?.commitDocs, (v) => {
		next.commit_docs = v
	})
	assignIfDefined(patch?.contextWindow, (v) => {
		next.context_window = v
	})
	assignIfDefined(patch?.responseLanguage, (v) => {
		next.response_language = v.trim() ? v : null
	})
	assignIfDefined(patch?.branchingStrategy, (v) => {
		git.branching_strategy = v
	})
	assignIfDefined(patch?.gitProvider, (v) => {
		git.provider = v
	})
	assignIfDefined(patch?.gitProviderBaseUrl, (v) => {
		git.provider_base_url = v.trim()
	})
	assignIfDefined(patch?.gitProviderTransport, (v) => {
		git.provider_transport = v
	})
	assignIfDefined(patch?.gitProviderMcpServer, (v) => {
		git.provider_mcp_server = v.trim()
	})
	assignIfDefined(patch?.gitProviderMcpPrStatusTool, (v) => {
		git.provider_mcp_pr_status_tool = v.trim()
	})
	assignIfDefined(patch?.gitProviderMcpOpenPrTool, (v) => {
		git.provider_mcp_open_pr_tool = v.trim()
	})
	assignIfDefined(patch?.gitProviderMcpCommitTool, (v) => {
		git.provider_mcp_commit_tool = v.trim()
	})
	assignIfDefined(patch?.gitProviderMcpSyncTool, (v) => {
		git.provider_mcp_sync_tool = v.trim()
	})
	assignIfDefined(patch?.thinkingPartner, (v) => {
		features.thinking_partner = v
	})
	assignIfDefined(patch?.globalLearnings, (v) => {
		features.global_learnings = v
	})
	assignIfDefined(patch?.intelEnabled, (v) => {
		intel.enabled = v
	})

	next.workflow = workflow
	next.model_overrides = modelOverrides
	next.git = git
	next.features = features
	next.intel = intel
	return next
}

export async function resolveGsdSettingsContext() {
	const workspacePath = await getWorkspacePath()
	if (!workspacePath) {
		return { available: false as const }
	}

	const planningDir = path.join(workspacePath, ".planning")
	const configPath = path.join(planningDir, "config.json")
	const planningExists = existsSync(planningDir)
	const configExists = existsSync(configPath)
	const config = configExists ? readJsonSafe(configPath) : {}

	return {
		available: true as const,
		workspacePath,
		planningDir,
		configPath,
		planningExists,
		configExists,
		config,
	}
}

export function buildGsdSettingsResponse(
	context: Awaited<ReturnType<typeof resolveGsdSettingsContext>>,
	overrideConfig?: JsonObject,
): GsdSettingsResponse {
	if (!context.available) {
		return GsdSettingsResponse.create({ available: false, planningExists: false, configExists: false })
	}

	const config = overrideConfig ?? context.config
	return GsdSettingsResponse.create({
		available: true,
		workspacePath: context.workspacePath,
		configPath: context.configPath,
		planningExists: context.planningExists,
		configExists: context.configExists,
		settings: toProtoSettings(fromConfig(config)),
	})
}

export async function writeGsdSettings(request: UpdateGsdSettingsRequest): Promise<GsdSettingsResponse> {
	const context = await resolveGsdSettingsContext()
	if (!context.available) {
		return buildGsdSettingsResponse(context)
	}

	await mkdir(context.planningDir, { recursive: true })
	const nextConfig = applySettingsPatch(context.config, request.settings)
	await writeFile(context.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8")

	return buildGsdSettingsResponse(
		{
			...context,
			planningExists: true,
			configExists: true,
		},
		nextConfig,
	)
}
