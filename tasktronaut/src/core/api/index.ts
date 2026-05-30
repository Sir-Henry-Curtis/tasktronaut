import { ApiConfiguration, ModelInfo, openAiNativeModels, QwenApiRegions } from "@shared/api"
import { ApiFormat } from "@shared/proto/cline/models"
import { Mode } from "@shared/storage/types"
import { ClineStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { ClineTool } from "@/shared/tools"
import { AIhubmixHandler } from "./providers/aihubmix"
import { AnthropicHandler } from "./providers/anthropic"
import { AskSageHandler } from "./providers/asksage"
import { BasetenHandler } from "./providers/baseten"
import { AwsBedrockHandler } from "./providers/bedrock"
import { CerebrasHandler } from "./providers/cerebras"
import { ClaudeCodeHandler } from "./providers/claude-code"
import { ClineHandler } from "./providers/cline"
import { DeepSeekHandler } from "./providers/deepseek"
import { DifyHandler } from "./providers/dify"
import { DoubaoHandler } from "./providers/doubao"
import { FireworksHandler } from "./providers/fireworks"
import { GeminiHandler } from "./providers/gemini"
import { GroqHandler } from "./providers/groq"
import { HicapHandler } from "./providers/hicap"
import { HuaweiCloudMaaSHandler } from "./providers/huawei-cloud-maas"
import { HuggingFaceHandler } from "./providers/huggingface"
import { LiteLlmHandler } from "./providers/litellm"
import { LmStudioHandler } from "./providers/lmstudio"
import { MinimaxHandler } from "./providers/minimax"
import { MistralHandler } from "./providers/mistral"
import { MoonshotHandler } from "./providers/moonshot"
import { NebiusHandler } from "./providers/nebius"
import { NousResearchHandler } from "./providers/nousresearch"
import { OcaHandler } from "./providers/oca"
import { OllamaHandler } from "./providers/ollama"
import { OpenAiHandler } from "./providers/openai"
import { OpenAiCodexHandler } from "./providers/openai-codex"
import { OpenAiNativeHandler } from "./providers/openai-native"
import { OpenRouterHandler } from "./providers/openrouter"
import { QwenHandler } from "./providers/qwen"
import { QwenCodeHandler } from "./providers/qwen-code"
import { RequestyHandler } from "./providers/requesty"
import { SambanovaHandler } from "./providers/sambanova"
import { SapAiCoreHandler } from "./providers/sapaicore"
import { TogetherHandler } from "./providers/together"
import { VercelAIGatewayHandler } from "./providers/vercel-ai-gateway"
import { VertexHandler } from "./providers/vertex"
import { VsCodeLmHandler } from "./providers/vscode-lm"
import { WandbHandler } from "./providers/wandb"
import { XAIHandler } from "./providers/xai"
import { ZAiHandler } from "./providers/zai"
import { ApiStream, ApiStreamUsageChunk } from "./transform/stream"

export type CommonApiHandlerOptions = {
	onRetryAttempt?: ApiConfiguration["onRetryAttempt"]
}
export interface ApiHandler {
	createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: ClineTool[], useResponseApi?: boolean): ApiStream
	getModel(): ApiHandlerModel
	getApiStreamUsage?(): Promise<ApiStreamUsageChunk | undefined>
	abort?(): void
}

export interface ApiHandlerModel {
	id: string
	info: ModelInfo
}

export interface ApiProviderInfo {
	providerId: string
	model: ApiHandlerModel
	mode: Mode
	customPrompt?: string // "compact"
}

export interface SingleCompletionHandler {
	completePrompt(prompt: string): Promise<string>
}

function getOpenAiModeModelInfo(
	options: Omit<ApiConfiguration, "apiProvider">,
	mode: Mode,
): ModelInfo | undefined {
	return modeOpt(mode, options.planModeOpenAiModelInfo, options.actModeOpenAiModelInfo, options.kissModeOpenAiModelInfo)
}

function getOpenAiModeModelId(
	options: Omit<ApiConfiguration, "apiProvider">,
	mode: Mode,
): string | undefined {
	return modeOpt(mode, options.planModeOpenAiModelId, options.actModeOpenAiModelId, options.kissModeOpenAiModelId)
}

/** Pick the plan/act/kiss variant of a mode-specific option. */
function modeOpt<T>(mode: Mode, plan: T, act: T, kiss: T): T {
	if (mode === "plan") return plan
	if (mode === "kiss") return kiss
	return act
}

function shouldRouteOpenAiToResponsesApi(
	options: Omit<ApiConfiguration, "apiProvider">,
	mode: Mode,
): boolean {
	const modelInfo = getOpenAiModeModelInfo(options, mode)
	if (!modelInfo?.apiFormat) {
		const modelId = getOpenAiModeModelId(options, mode)
		return !!(modelId && modelId in openAiNativeModels)
	}

	return (
		modelInfo.apiFormat === ApiFormat.OPENAI_RESPONSES ||
		modelInfo.apiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE
	)
}

function createHandlerForProvider(
	apiProvider: string | undefined,
	options: Omit<ApiConfiguration, "apiProvider">,
	mode: Mode,
): ApiHandler {
	// Shorthand helpers bound to this call's mode
	const mid = <T>(plan: T, act: T, kiss: T): T => modeOpt(mode, plan, act, kiss)
	const midModel = () => mid(options.planModeApiModelId, options.actModeApiModelId, options.kissModeApiModelId)
	const midThink = () => mid(options.planModeThinkingBudgetTokens, options.actModeThinkingBudgetTokens, options.kissModeThinkingBudgetTokens)
	const midReason = () => mid(options.planModeReasoningEffort, options.actModeReasoningEffort, options.kissModeReasoningEffort)

	switch (apiProvider) {
		case "anthropic":
			return new AnthropicHandler({
				onRetryAttempt: options.onRetryAttempt,
				apiKey: options.apiKey,
				anthropicBaseUrl: options.anthropicBaseUrl,
				apiModelId: midModel(),
				reasoningEffort: midReason(),
				thinkingBudgetTokens: midThink(),
			})
		case "openrouter":
			return new OpenRouterHandler({
				onRetryAttempt: options.onRetryAttempt,
				openRouterApiKey: options.openRouterApiKey,
				openRouterModelId: mid(options.planModeOpenRouterModelId, options.actModeOpenRouterModelId, options.kissModeOpenRouterModelId),
				openRouterModelInfo: mid(options.planModeOpenRouterModelInfo, options.actModeOpenRouterModelInfo, options.kissModeOpenRouterModelInfo),
				openRouterProviderSorting: options.openRouterProviderSorting,
				reasoningEffort: midReason(),
				thinkingBudgetTokens: midThink(),
				enableParallelToolCalling: options.enableParallelToolCalling,
			})
		case "bedrock":
			return new AwsBedrockHandler({
				onRetryAttempt: options.onRetryAttempt,
				apiModelId: midModel(),
				awsAccessKey: options.awsAccessKey,
				awsSecretKey: options.awsSecretKey,
				awsSessionToken: options.awsSessionToken,
				awsRegion: options.awsRegion,
				awsAuthentication: options.awsAuthentication,
				awsBedrockApiKey: options.awsBedrockApiKey,
				awsUseCrossRegionInference: options.awsUseCrossRegionInference,
				awsUseGlobalInference: options.awsUseGlobalInference,
				awsBedrockUsePromptCache: options.awsBedrockUsePromptCache,
				awsUseProfile: options.awsUseProfile,
				awsProfile: options.awsProfile,
				awsBedrockEndpoint: options.awsBedrockEndpoint,
				awsBedrockCustomSelected: mid(options.planModeAwsBedrockCustomSelected, options.actModeAwsBedrockCustomSelected, options.kissModeAwsBedrockCustomSelected),
				awsBedrockCustomModelBaseId: mid(options.planModeAwsBedrockCustomModelBaseId, options.actModeAwsBedrockCustomModelBaseId, options.kissModeAwsBedrockCustomModelBaseId),
				reasoningEffort: midReason(),
				thinkingBudgetTokens: midThink(),
			})
		case "vertex":
			return new VertexHandler({
				onRetryAttempt: options.onRetryAttempt,
				vertexProjectId: options.vertexProjectId,
				vertexRegion: options.vertexRegion,
				apiModelId: midModel(),
				thinkingBudgetTokens: midThink(),
				geminiApiKey: options.geminiApiKey,
				geminiBaseUrl: options.geminiBaseUrl,
				reasoningEffort: midReason(),
				ulid: options.ulid,
			})
		case "openai":
			if (shouldRouteOpenAiToResponsesApi(options, mode)) {
				return new OpenAiNativeHandler({
					onRetryAttempt: options.onRetryAttempt,
					openAiNativeApiKey: options.openAiApiKey,
					reasoningEffort: midReason(),
					apiModelId: mid(options.planModeOpenAiModelId, options.actModeOpenAiModelId, options.kissModeOpenAiModelId),
					thinkingBudgetTokens: midThink(),
				})
			}
			return new OpenAiHandler({
				onRetryAttempt: options.onRetryAttempt,
				openAiApiKey: options.openAiApiKey,
				openAiBaseUrl: options.openAiBaseUrl,
				azureApiVersion: options.azureApiVersion,
				azureIdentity: options.azureIdentity,
				openAiHeaders: options.openAiHeaders,
				openAiModelId: mid(options.planModeOpenAiModelId, options.actModeOpenAiModelId, options.kissModeOpenAiModelId),
				openAiModelInfo: mid(options.planModeOpenAiModelInfo, options.actModeOpenAiModelInfo, options.kissModeOpenAiModelInfo),
				reasoningEffort: midReason(),
			})
		case "ollama":
			return new OllamaHandler({
				onRetryAttempt: options.onRetryAttempt,
				ollamaBaseUrl: options.ollamaBaseUrl,
				ollamaApiKey: options.ollamaApiKey,
				ollamaModelId: mid(options.planModeOllamaModelId, options.actModeOllamaModelId, options.kissModeOllamaModelId),
				ollamaApiOptionsCtxNum: options.ollamaApiOptionsCtxNum,
				requestTimeoutMs: options.requestTimeoutMs,
			})
		case "lmstudio":
			return new LmStudioHandler({
				onRetryAttempt: options.onRetryAttempt,
				lmStudioBaseUrl: options.lmStudioBaseUrl,
				lmStudioModelId: mid(options.planModeLmStudioModelId, options.actModeLmStudioModelId, options.kissModeLmStudioModelId),
				lmStudioMaxTokens: options.lmStudioMaxTokens,
			})
		case "gemini":
			return new GeminiHandler({
				onRetryAttempt: options.onRetryAttempt,
				vertexProjectId: options.vertexProjectId,
				vertexRegion: options.vertexRegion,
				geminiApiKey: options.geminiApiKey,
				geminiBaseUrl: options.geminiBaseUrl,
				thinkingBudgetTokens: midThink(),
				reasoningEffort: midReason(),
				apiModelId: midModel(),
				ulid: options.ulid,
			})
		case "openai-native":
			return new OpenAiNativeHandler({
				onRetryAttempt: options.onRetryAttempt,
				openAiNativeApiKey: options.openAiNativeApiKey,
				reasoningEffort: midReason(),
				apiModelId: midModel(),
				thinkingBudgetTokens: midThink(),
			})
		case "openai-codex":
			return new OpenAiCodexHandler({
				onRetryAttempt: options.onRetryAttempt,
				reasoningEffort: midReason(),
				apiModelId: midModel(),
			})
		case "deepseek":
			return new DeepSeekHandler({
				onRetryAttempt: options.onRetryAttempt,
				deepSeekApiKey: options.deepSeekApiKey,
				apiModelId: midModel(),
			})
		case "requesty":
			return new RequestyHandler({
				onRetryAttempt: options.onRetryAttempt,
				requestyBaseUrl: options.requestyBaseUrl,
				requestyApiKey: options.requestyApiKey,
				reasoningEffort: midReason(),
				thinkingBudgetTokens: midThink(),
				requestyModelId: mid(options.planModeRequestyModelId, options.actModeRequestyModelId, options.kissModeRequestyModelId),
				requestyModelInfo: mid(options.planModeRequestyModelInfo, options.actModeRequestyModelInfo, options.kissModeRequestyModelInfo),
			})
		case "fireworks":
			return new FireworksHandler({
				onRetryAttempt: options.onRetryAttempt,
				fireworksApiKey: options.fireworksApiKey,
				fireworksModelId: mid(options.planModeFireworksModelId, options.actModeFireworksModelId, options.kissModeFireworksModelId),
			})
		case "together":
			return new TogetherHandler({
				onRetryAttempt: options.onRetryAttempt,
				togetherApiKey: options.togetherApiKey,
				togetherModelId: mid(options.planModeTogetherModelId, options.actModeTogetherModelId, options.kissModeTogetherModelId),
			})
		case "qwen":
			return new QwenHandler({
				onRetryAttempt: options.onRetryAttempt,
				qwenApiKey: options.qwenApiKey,
				qwenApiLine:
					options.qwenApiLine === QwenApiRegions.INTERNATIONAL ? QwenApiRegions.INTERNATIONAL : QwenApiRegions.CHINA,
				apiModelId: midModel(),
				thinkingBudgetTokens: midThink(),
			})
		case "qwen-code":
			return new QwenCodeHandler({
				onRetryAttempt: options.onRetryAttempt,
				qwenCodeOauthPath: options.qwenCodeOauthPath,
				apiModelId: midModel(),
			})
		case "doubao":
			return new DoubaoHandler({
				onRetryAttempt: options.onRetryAttempt,
				doubaoApiKey: options.doubaoApiKey,
				apiModelId: midModel(),
			})
		case "mistral":
			return new MistralHandler({
				onRetryAttempt: options.onRetryAttempt,
				mistralApiKey: options.mistralApiKey,
				apiModelId: midModel(),
			})
		case "vscode-lm":
			return new VsCodeLmHandler({
				onRetryAttempt: options.onRetryAttempt,
				vsCodeLmModelSelector: mid(options.planModeVsCodeLmModelSelector, options.actModeVsCodeLmModelSelector, options.kissModeVsCodeLmModelSelector),
			})
		case "cline": {
			const clineModelId =
				mid(options.planModeClineModelId, options.actModeClineModelId, options.kissModeClineModelId) ||
				mid(options.planModeOpenRouterModelId, options.actModeOpenRouterModelId, options.kissModeOpenRouterModelId)
			const clineModelInfo =
				mid(options.planModeClineModelInfo, options.actModeClineModelInfo, options.kissModeClineModelInfo) ||
				mid(options.planModeOpenRouterModelInfo, options.actModeOpenRouterModelInfo, options.kissModeOpenRouterModelInfo)
			return new ClineHandler({
				onRetryAttempt: options.onRetryAttempt,
				clineAccountId: options.clineAccountId,
				clineApiKey: options.clineApiKey,
				ulid: options.ulid,
				reasoningEffort: midReason(),
				thinkingBudgetTokens: midThink(),
				openRouterProviderSorting: options.openRouterProviderSorting,
				openRouterModelId: clineModelId,
				openRouterModelInfo: clineModelInfo,
				enableParallelToolCalling: options.enableParallelToolCalling,
			})
		}
		case "litellm":
			return new LiteLlmHandler({
				onRetryAttempt: options.onRetryAttempt,
				liteLlmApiKey: options.liteLlmApiKey,
				liteLlmBaseUrl: options.liteLlmBaseUrl,
				liteLlmModelId: mid(options.planModeLiteLlmModelId, options.actModeLiteLlmModelId, options.kissModeLiteLlmModelId),
				liteLlmModelInfo: mid(options.planModeLiteLlmModelInfo, options.actModeLiteLlmModelInfo, options.kissModeLiteLlmModelInfo),
				reasoningEffort: midReason(),
				thinkingBudgetTokens: midThink(),
				liteLlmUsePromptCache: options.liteLlmUsePromptCache,
				ulid: options.ulid,
			})
		case "moonshot":
			return new MoonshotHandler({
				onRetryAttempt: options.onRetryAttempt,
				moonshotApiKey: options.moonshotApiKey,
				moonshotApiLine: options.moonshotApiLine,
				apiModelId: midModel(),
			})
		case "huggingface":
			return new HuggingFaceHandler({
				onRetryAttempt: options.onRetryAttempt,
				huggingFaceApiKey: options.huggingFaceApiKey,
				huggingFaceModelId: mid(options.planModeHuggingFaceModelId, options.actModeHuggingFaceModelId, options.kissModeHuggingFaceModelId),
				huggingFaceModelInfo: mid(options.planModeHuggingFaceModelInfo, options.actModeHuggingFaceModelInfo, options.kissModeHuggingFaceModelInfo),
			})
		case "nebius":
			return new NebiusHandler({
				onRetryAttempt: options.onRetryAttempt,
				nebiusApiKey: options.nebiusApiKey,
				apiModelId: midModel(),
			})
		case "asksage":
			return new AskSageHandler({
				onRetryAttempt: options.onRetryAttempt,
				asksageApiKey: options.asksageApiKey,
				asksageApiUrl: options.asksageApiUrl,
				apiModelId: midModel(),
			})
		case "xai":
			return new XAIHandler({
				onRetryAttempt: options.onRetryAttempt,
				xaiApiKey: options.xaiApiKey,
				reasoningEffort: midReason(),
				apiModelId: midModel(),
			})
		case "sambanova":
			return new SambanovaHandler({
				onRetryAttempt: options.onRetryAttempt,
				sambanovaApiKey: options.sambanovaApiKey,
				apiModelId: midModel(),
			})
		case "cerebras":
			return new CerebrasHandler({
				onRetryAttempt: options.onRetryAttempt,
				cerebrasApiKey: options.cerebrasApiKey,
				apiModelId: midModel(),
			})
		case "groq":
			return new GroqHandler({
				onRetryAttempt: options.onRetryAttempt,
				groqApiKey: options.groqApiKey,
				groqModelId: mid(options.planModeGroqModelId, options.actModeGroqModelId, options.kissModeGroqModelId),
				groqModelInfo: mid(options.planModeGroqModelInfo, options.actModeGroqModelInfo, options.kissModeGroqModelInfo),
				apiModelId: midModel(),
			})
		case "baseten":
			return new BasetenHandler({
				onRetryAttempt: options.onRetryAttempt,
				basetenApiKey: options.basetenApiKey,
				basetenModelId: mid(options.planModeBasetenModelId, options.actModeBasetenModelId, options.kissModeBasetenModelId),
				basetenModelInfo: mid(options.planModeBasetenModelInfo, options.actModeBasetenModelInfo, options.kissModeBasetenModelInfo),
				apiModelId: midModel(),
			})
		case "sapaicore":
			return new SapAiCoreHandler({
				onRetryAttempt: options.onRetryAttempt,
				sapAiCoreClientId: options.sapAiCoreClientId,
				sapAiCoreClientSecret: options.sapAiCoreClientSecret,
				sapAiCoreTokenUrl: options.sapAiCoreTokenUrl,
				sapAiResourceGroup: options.sapAiResourceGroup,
				sapAiCoreBaseUrl: options.sapAiCoreBaseUrl,
				apiModelId: midModel(),
				thinkingBudgetTokens: midThink(),
				reasoningEffort: midReason(),
				deploymentId: mid(options.planModeSapAiCoreDeploymentId, options.actModeSapAiCoreDeploymentId, options.kissModeSapAiCoreDeploymentId),
				sapAiCoreUseOrchestrationMode: options.sapAiCoreUseOrchestrationMode,
			})
		case "claude-code":
			return new ClaudeCodeHandler({
				onRetryAttempt: options.onRetryAttempt,
				claudeCodePath: options.claudeCodePath,
				apiModelId: midModel(),
				thinkingBudgetTokens: midThink(),
			})
		case "huawei-cloud-maas":
			return new HuaweiCloudMaaSHandler({
				onRetryAttempt: options.onRetryAttempt,
				huaweiCloudMaasApiKey: options.huaweiCloudMaasApiKey,
				huaweiCloudMaasModelId: mid(options.planModeHuaweiCloudMaasModelId, options.actModeHuaweiCloudMaasModelId, options.kissModeHuaweiCloudMaasModelId),
				huaweiCloudMaasModelInfo: mid(options.planModeHuaweiCloudMaasModelInfo, options.actModeHuaweiCloudMaasModelInfo, options.kissModeHuaweiCloudMaasModelInfo),
			})
		case "dify":
			return new DifyHandler({
				difyApiKey: options.difyApiKey,
				difyBaseUrl: options.difyBaseUrl,
			})
		case "vercel-ai-gateway":
			return new VercelAIGatewayHandler({
				onRetryAttempt: options.onRetryAttempt,
				vercelAiGatewayApiKey: options.vercelAiGatewayApiKey,
				openRouterModelId: mid(options.planModeVercelAiGatewayModelId, options.actModeVercelAiGatewayModelId, options.kissModeVercelAiGatewayModelId),
				openRouterModelInfo: mid(options.planModeVercelAiGatewayModelInfo, options.actModeVercelAiGatewayModelInfo, options.kissModeVercelAiGatewayModelInfo),
				reasoningEffort: midReason(),
				thinkingBudgetTokens: midThink(),
			})
		case "zai":
			return new ZAiHandler({
				onRetryAttempt: options.onRetryAttempt,
				zaiApiLine: options.zaiApiLine,
				zaiApiKey: options.zaiApiKey,
				apiModelId: midModel(),
			})
		case "oca":
			return new OcaHandler({
				ocaMode: options.ocaMode || "internal",
				ocaBaseUrl: options.ocaBaseUrl,
				ocaModelId: mid(options.planModeOcaModelId, options.actModeOcaModelId, options.kissModeOcaModelId),
				ocaModelInfo: mid(options.planModeOcaModelInfo, options.actModeOcaModelInfo, options.kissModeOcaModelInfo),
				ocaReasoningEffort: mid(options.planModeOcaReasoningEffort, options.actModeOcaReasoningEffort, options.kissModeOcaReasoningEffort),
				thinkingBudgetTokens: midThink(),
				ocaUsePromptCache: mid(options.planModeOcaModelInfo?.supportsPromptCache, options.actModeOcaModelInfo?.supportsPromptCache, options.kissModeOcaModelInfo?.supportsPromptCache),
				taskId: options.ulid,
			})
		case "aihubmix":
			return new AIhubmixHandler({
				onRetryAttempt: options.onRetryAttempt,
				apiKey: options.aihubmixApiKey,
				baseURL: options.aihubmixBaseUrl,
				appCode: options.aihubmixAppCode,
				modelId: mid(options.planModeAihubmixModelId, options.actModeAihubmixModelId, options.kissModeAihubmixModelId),
				modelInfo: mid(options.planModeAihubmixModelInfo, options.actModeAihubmixModelInfo, options.kissModeAihubmixModelInfo),
			})
		case "minimax":
			return new MinimaxHandler({
				onRetryAttempt: options.onRetryAttempt,
				minimaxApiKey: options.minimaxApiKey,
				minimaxApiLine: options.minimaxApiLine,
				apiModelId: midModel(),
				thinkingBudgetTokens: midThink(),
			})
		case "hicap":
			return new HicapHandler({
				onRetryAttempt: options.onRetryAttempt,
				hicapApiKey: options.hicapApiKey,
				hicapModelId: mid(options.planModeHicapModelId, options.actModeHicapModelId, options.kissModeHicapModelId),
			})
		case "nousResearch":
			return new NousResearchHandler({
				onRetryAttempt: options.onRetryAttempt,
				nousResearchApiKey: options.nousResearchApiKey,
				apiModelId: mid(options.planModeNousResearchModelId, options.actModeNousResearchModelId, options.kissModeNousResearchModelId),
			})
		case "wandb":
			return new WandbHandler({
				onRetryAttempt: options.onRetryAttempt,
				wandbApiKey: options.wandbApiKey,
				apiModelId: midModel(),
			})
		default:
			return new AnthropicHandler({
				onRetryAttempt: options.onRetryAttempt,
				apiKey: options.apiKey,
				anthropicBaseUrl: options.anthropicBaseUrl,
				apiModelId: midModel(),
				reasoningEffort: midReason(),
				thinkingBudgetTokens: midThink(),
			})
	}
}

export function buildApiHandler(configuration: ApiConfiguration, mode: Mode): ApiHandler {
	const { planModeApiProvider, actModeApiProvider, kissModeApiProvider, ...options } = configuration

	let apiProvider: string | undefined
	if (mode === "plan") apiProvider = planModeApiProvider
	else if (mode === "kiss") apiProvider = kissModeApiProvider
	else apiProvider = actModeApiProvider

	// Validate thinking budget tokens against model's maxTokens to prevent API errors
	// wrapped in a try-catch for safety, but this should never throw
	try {
		let thinkingBudgetTokens: number | undefined
		if (mode === "plan") thinkingBudgetTokens = options.planModeThinkingBudgetTokens
		else if (mode === "kiss") thinkingBudgetTokens = options.kissModeThinkingBudgetTokens
		else thinkingBudgetTokens = options.actModeThinkingBudgetTokens

		if (thinkingBudgetTokens && thinkingBudgetTokens > 0) {
			const handler = createHandlerForProvider(apiProvider, options, mode)

			const modelInfo = handler.getModel().info
			if (modelInfo?.maxTokens && modelInfo.maxTokens > 0 && thinkingBudgetTokens > modelInfo.maxTokens) {
				const clippedValue = modelInfo.maxTokens - 1
				if (mode === "plan") options.planModeThinkingBudgetTokens = clippedValue
				else if (mode === "kiss") options.kissModeThinkingBudgetTokens = clippedValue
				else options.actModeThinkingBudgetTokens = clippedValue
			} else {
				return handler // don't rebuild unless its necessary
			}
		}
	} catch (error) {
		Logger.error("buildApiHandler error:", error)
	}

	return createHandlerForProvider(apiProvider, options, mode)
}
