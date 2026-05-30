import {
	ApiConfiguration,
	ApiProvider,
	anthropicDefaultModelId,
	anthropicModels,
	askSageDefaultModelId,
	askSageModels,
	basetenDefaultModelId,
	basetenModels,
	bedrockDefaultModelId,
	bedrockModels,
	cerebrasDefaultModelId,
	cerebrasModels,
	claudeCodeDefaultModelId,
	claudeCodeModels,
	deepSeekDefaultModelId,
	deepSeekModels,
	doubaoDefaultModelId,
	doubaoModels,
	fireworksDefaultModelId,
	fireworksModels,
	geminiDefaultModelId,
	geminiModels,
	groqDefaultModelId,
	groqModels,
	hicapModelInfoSaneDefaults,
	huaweiCloudMaasDefaultModelId,
	huaweiCloudMaasModels,
	huggingFaceDefaultModelId,
	huggingFaceModels,
	internationalQwenDefaultModelId,
	internationalQwenModels,
	internationalZAiDefaultModelId,
	internationalZAiModels,
	liteLlmModelInfoSaneDefaults,
	ModelInfo,
	mainlandQwenDefaultModelId,
	mainlandQwenModels,
	mainlandZAiDefaultModelId,
	mainlandZAiModels,
	minimaxDefaultModelId,
	minimaxModels,
	mistralDefaultModelId,
	mistralModels,
	moonshotDefaultModelId,
	moonshotModels,
	nebiusDefaultModelId,
	nebiusModels,
	nousResearchDefaultModelId,
	nousResearchModels,
	openAiCodexDefaultModelId,
	openAiCodexModels,
	openAiModelInfoSaneDefaults,
	openAiNativeDefaultModelId,
	openAiNativeModels,
	openRouterDefaultModelId,
	openRouterDefaultModelInfo,
	qwenCodeDefaultModelId,
	qwenCodeModels,
	requestyDefaultModelId,
	requestyDefaultModelInfo,
	sambanovaDefaultModelId,
	sambanovaModels,
	sapAiCoreDefaultModelId,
	sapAiCoreModels,
	vertexDefaultModelId,
	vertexModels,
	wandbDefaultModelId,
	wandbModels,
	xaiDefaultModelId,
	xaiModels,
	coerceSupportedApiProvider,
} from "@shared/api"
import { Mode } from "@shared/storage/types"
import * as reasoningSupport from "@shared/utils/reasoning-support"

export function supportsReasoningEffortForModelId(modelId?: string, _allowShortOpenAiIds = false): boolean {
	return reasoningSupport.supportsReasoningEffortForModel(modelId)
}

/**
 * Returns the static model list for a provider.
 * For providers with dynamic models (openrouter, cline, ollama, etc.), returns undefined.
 * Some providers depend on configuration (qwen, zai) for region-specific models.
 */
export function getModelsForProvider(
	provider: ApiProvider,
	apiConfiguration?: ApiConfiguration,
	dynamicModels: { liteLlmModels?: Record<string, ModelInfo>; basetenModels?: Record<string, ModelInfo> } = {},
): Record<string, ModelInfo> | undefined {
	switch (provider) {
		case "anthropic":
			return anthropicModels
		case "claude-code":
			return claudeCodeModels
		case "bedrock":
			return bedrockModels
		case "vertex":
			return vertexModels
		case "gemini":
			return geminiModels
		case "openai-native":
			return openAiNativeModels
		case "openai-codex":
			return openAiCodexModels
		case "deepseek":
			return deepSeekModels
		case "qwen":
			return apiConfiguration?.qwenApiLine === "china" ? mainlandQwenModels : internationalQwenModels
		case "qwen-code":
			return qwenCodeModels
		case "doubao":
			return doubaoModels
		case "mistral":
			return mistralModels
		case "asksage":
			return askSageModels
		case "xai":
			return xaiModels
		case "moonshot":
			return moonshotModels
		case "nebius":
			return nebiusModels
		case "wandb":
			return wandbModels
		case "sambanova":
			return sambanovaModels
		case "cerebras":
			return cerebrasModels
		case "groq":
			return groqModels
		case "baseten":
			return dynamicModels?.basetenModels || basetenModels
		case "sapaicore":
			return sapAiCoreModels
		case "huawei-cloud-maas":
			return huaweiCloudMaasModels
		case "zai":
			return apiConfiguration?.zaiApiLine === "china" ? mainlandZAiModels : internationalZAiModels
		case "fireworks":
			return fireworksModels
		case "minimax":
			return minimaxModels
		case "huggingface":
			return huggingFaceModels
		case "nousResearch":
			return nousResearchModels
		case "litellm":
			return dynamicModels?.liteLlmModels
		// Providers with dynamic models - return undefined
		case "openrouter":
		case "cline":
		case "openai":
		case "ollama":
		case "lmstudio":
		case "vscode-lm":
		case "requesty":
		case "hicap":
		case "dify":
		case "vercel-ai-gateway":
		case "oca":
		case "aihubmix":
		case "together":
		default:
			return undefined
	}
}

/**
 * Interface for normalized API configuration
 */
export interface NormalizedApiConfig {
	selectedProvider: ApiProvider
	selectedModelId: string
	selectedModelInfo: ModelInfo
}

/**
 * Normalizes API configuration to ensure consistent values
 */
export function normalizeApiConfiguration(
	apiConfiguration: ApiConfiguration | undefined,
	currentMode: Mode,
): NormalizedApiConfig {
	const provider =
		coerceSupportedApiProvider(
			(currentMode === "plan" ? apiConfiguration?.planModeApiProvider : currentMode === "kiss" ? apiConfiguration?.kissModeApiProvider : apiConfiguration?.actModeApiProvider) || "openai",
		)

	const modelId = currentMode === "plan" ? apiConfiguration?.planModeApiModelId : currentMode === "kiss" ? apiConfiguration?.kissModeApiModelId : apiConfiguration?.actModeApiModelId

	const getProviderData = (models: Record<string, ModelInfo>, defaultId: string) => {
		let selectedModelId: string
		let selectedModelInfo: ModelInfo
		if (modelId && modelId in models) {
			selectedModelId = modelId
			selectedModelInfo = models[modelId]
		} else {
			selectedModelId = defaultId
			selectedModelInfo = models[defaultId]
		}
		return {
			selectedProvider: provider,
			selectedModelId,
			selectedModelInfo,
		}
	}

	switch (provider) {
		case "anthropic":
			return getProviderData(anthropicModels, anthropicDefaultModelId)
		case "claude-code":
			return getProviderData(claudeCodeModels, claudeCodeDefaultModelId)
		case "bedrock":
			const awsBedrockCustomSelected =
				currentMode === "plan"
					? apiConfiguration?.planModeAwsBedrockCustomSelected
					: currentMode === "kiss"
						? apiConfiguration?.kissModeAwsBedrockCustomSelected
						: apiConfiguration?.actModeAwsBedrockCustomSelected
			if (awsBedrockCustomSelected) {
				const baseModelId =
					currentMode === "plan"
						? apiConfiguration?.planModeAwsBedrockCustomModelBaseId
						: currentMode === "kiss"
							? apiConfiguration?.kissModeAwsBedrockCustomModelBaseId
							: apiConfiguration?.actModeAwsBedrockCustomModelBaseId

				return {
					selectedProvider: provider,
					selectedModelId: modelId || bedrockDefaultModelId,
					selectedModelInfo:
						(baseModelId && bedrockModels[baseModelId as keyof typeof bedrockModels]) ||
						bedrockModels[bedrockDefaultModelId],
				}
			}
			return getProviderData(bedrockModels, bedrockDefaultModelId)
		case "vertex":
			return getProviderData(vertexModels, vertexDefaultModelId)
		case "gemini":
			return getProviderData(geminiModels, geminiDefaultModelId)
		case "openai-native":
			return getProviderData(openAiNativeModels, openAiNativeDefaultModelId)
		case "openai-codex":
			return getProviderData(openAiCodexModels, openAiCodexDefaultModelId)
		case "deepseek":
			return getProviderData(deepSeekModels, deepSeekDefaultModelId)
		case "qwen":
			const qwenModels = apiConfiguration?.qwenApiLine === "china" ? mainlandQwenModels : internationalQwenModels
			const qwenDefaultId =
				apiConfiguration?.qwenApiLine === "china" ? mainlandQwenDefaultModelId : internationalQwenDefaultModelId
			return getProviderData(qwenModels, qwenDefaultId)
		case "qwen-code":
			return getProviderData(qwenCodeModels, qwenCodeDefaultModelId)
		case "doubao":
			return getProviderData(doubaoModels, doubaoDefaultModelId)
		case "mistral":
			return getProviderData(mistralModels, mistralDefaultModelId)
		case "asksage":
			return getProviderData(askSageModels, askSageDefaultModelId)
		case "openrouter":
			const openRouterModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenRouterModelId : currentMode === "kiss" ? apiConfiguration?.kissModeOpenRouterModelId : apiConfiguration?.actModeOpenRouterModelId
			const openRouterModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeOpenRouterModelInfo
					: currentMode === "kiss"
						? apiConfiguration?.kissModeOpenRouterModelInfo
						: apiConfiguration?.actModeOpenRouterModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: openRouterModelId || openRouterDefaultModelId,
				selectedModelInfo: openRouterModelInfo || openRouterDefaultModelInfo,
			}
		case "requesty":
			const requestyModelId =
				currentMode === "plan" ? apiConfiguration?.planModeRequestyModelId : currentMode === "kiss" ? apiConfiguration?.kissModeRequestyModelId : apiConfiguration?.actModeRequestyModelId
			const requestyModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeRequestyModelInfo : currentMode === "kiss" ? apiConfiguration?.kissModeRequestyModelInfo : apiConfiguration?.actModeRequestyModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: requestyModelId || requestyDefaultModelId,
				selectedModelInfo: requestyModelInfo || requestyDefaultModelInfo,
			}
		case "cline":
			const fallbackOpenRouterModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenRouterModelId : currentMode === "kiss" ? apiConfiguration?.kissModeOpenRouterModelId : apiConfiguration?.actModeOpenRouterModelId
			const fallbackOpenRouterModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeOpenRouterModelInfo
					: currentMode === "kiss"
						? apiConfiguration?.kissModeOpenRouterModelInfo
						: apiConfiguration?.actModeOpenRouterModelInfo
			const clineModelId =
				(currentMode === "plan" ? apiConfiguration?.planModeClineModelId : currentMode === "kiss" ? apiConfiguration?.kissModeClineModelId : apiConfiguration?.actModeClineModelId) ||
				fallbackOpenRouterModelId ||
				openRouterDefaultModelId
			const clineModelInfo =
				(currentMode === "plan" ? apiConfiguration?.planModeClineModelInfo : currentMode === "kiss" ? apiConfiguration?.kissModeClineModelInfo : apiConfiguration?.actModeClineModelInfo) ||
				fallbackOpenRouterModelInfo ||
				openRouterDefaultModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: clineModelId,
				selectedModelInfo: clineModelInfo,
			}
		case "openai":
			const openAiModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenAiModelId : currentMode === "kiss" ? apiConfiguration?.kissModeOpenAiModelId : apiConfiguration?.actModeOpenAiModelId
			const openAiModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeOpenAiModelInfo : currentMode === "kiss" ? apiConfiguration?.kissModeOpenAiModelInfo : apiConfiguration?.actModeOpenAiModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: openAiModelId || "",
				selectedModelInfo: openAiModelInfo || openAiModelInfoSaneDefaults,
			}
		case "hicap":
			const hicapModelId =
				currentMode === "plan" ? apiConfiguration?.planModeHicapModelId : currentMode === "kiss" ? apiConfiguration?.kissModeHicapModelId : apiConfiguration?.actModeHicapModelId
			return {
				selectedProvider: provider,
				selectedModelId: hicapModelId || "",
				selectedModelInfo: hicapModelInfoSaneDefaults,
			}
		case "ollama":
			const ollamaModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOllamaModelId : currentMode === "kiss" ? apiConfiguration?.kissModeOllamaModelId : apiConfiguration?.actModeOllamaModelId
			return {
				selectedProvider: provider,
				selectedModelId: ollamaModelId || "",
				selectedModelInfo: {
					...openAiModelInfoSaneDefaults,
					contextWindow: Number(apiConfiguration?.ollamaApiOptionsCtxNum ?? 32768),
				},
			}
		case "lmstudio":
			const lmStudioModelId =
				currentMode === "plan" ? apiConfiguration?.planModeLmStudioModelId : currentMode === "kiss" ? apiConfiguration?.kissModeLmStudioModelId : apiConfiguration?.actModeLmStudioModelId
			return {
				selectedProvider: provider,
				selectedModelId: lmStudioModelId || "",
				selectedModelInfo: {
					...openAiModelInfoSaneDefaults,
					contextWindow: Number(apiConfiguration?.lmStudioMaxTokens ?? 32768),
				},
			}
		case "vscode-lm":
			const vsCodeLmModelSelector =
				currentMode === "plan"
					? apiConfiguration?.planModeVsCodeLmModelSelector
					: currentMode === "kiss"
						? apiConfiguration?.kissModeVsCodeLmModelSelector
						: apiConfiguration?.actModeVsCodeLmModelSelector
			return {
				selectedProvider: provider,
				selectedModelId: vsCodeLmModelSelector ? `${vsCodeLmModelSelector.vendor}/${vsCodeLmModelSelector.family}` : "",
				selectedModelInfo: {
					...openAiModelInfoSaneDefaults,
					supportsImages: false, // VSCode LM API currently doesn't support images
				},
			}
		case "litellm": {
			const liteLlmModelId =
				currentMode === "plan" ? apiConfiguration?.planModeLiteLlmModelId : currentMode === "kiss" ? apiConfiguration?.kissModeLiteLlmModelId : apiConfiguration?.actModeLiteLlmModelId
			const liteLlmModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeLiteLlmModelInfo : currentMode === "kiss" ? apiConfiguration?.kissModeLiteLlmModelInfo : apiConfiguration?.actModeLiteLlmModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: liteLlmModelId || "",
				selectedModelInfo: liteLlmModelInfo || liteLlmModelInfoSaneDefaults,
			}
		}
		case "xai":
			return getProviderData(xaiModels, xaiDefaultModelId)
		case "moonshot":
			return getProviderData(moonshotModels, moonshotDefaultModelId)
		case "huggingface":
			const huggingFaceModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeHuggingFaceModelId
					: currentMode === "kiss"
						? apiConfiguration?.kissModeHuggingFaceModelId
						: apiConfiguration?.actModeHuggingFaceModelId
			const huggingFaceModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeHuggingFaceModelInfo
					: currentMode === "kiss"
						? apiConfiguration?.kissModeHuggingFaceModelInfo
						: apiConfiguration?.actModeHuggingFaceModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: huggingFaceModelId || huggingFaceDefaultModelId,
				selectedModelInfo: huggingFaceModelInfo || huggingFaceModels[huggingFaceDefaultModelId],
			}
		case "nebius":
			return getProviderData(nebiusModels, nebiusDefaultModelId)
		case "wandb":
			return getProviderData(wandbModels, wandbDefaultModelId)
		case "sambanova":
			return getProviderData(sambanovaModels, sambanovaDefaultModelId)
		case "cerebras":
			return getProviderData(cerebrasModels, cerebrasDefaultModelId)
		case "groq":
			const groqModelId =
				currentMode === "plan" ? apiConfiguration?.planModeGroqModelId : currentMode === "kiss" ? apiConfiguration?.kissModeGroqModelId : apiConfiguration?.actModeGroqModelId
			const groqModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeGroqModelInfo : currentMode === "kiss" ? apiConfiguration?.kissModeGroqModelInfo : apiConfiguration?.actModeGroqModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: groqModelId || groqDefaultModelId,
				selectedModelInfo: groqModelInfo || groqModels[groqDefaultModelId],
			}
		case "baseten": {
			const basetenModelId =
				currentMode === "plan" ? apiConfiguration?.planModeBasetenModelId : currentMode === "kiss" ? apiConfiguration?.kissModeBasetenModelId : apiConfiguration?.actModeBasetenModelId
			const basetenModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeBasetenModelInfo : currentMode === "kiss" ? apiConfiguration?.kissModeBasetenModelInfo : apiConfiguration?.actModeBasetenModelInfo
			const finalBasetenModelId = basetenModelId || basetenDefaultModelId
			return {
				selectedProvider: provider,
				selectedModelId: finalBasetenModelId,
				selectedModelInfo: basetenModelInfo ||
					basetenModels[finalBasetenModelId as keyof typeof basetenModels] ||
					basetenModels[basetenDefaultModelId] || {
						description: "Baseten model",
					},
			}
		}
		case "sapaicore":
			return getProviderData(sapAiCoreModels, sapAiCoreDefaultModelId)
		case "huawei-cloud-maas":
			const huaweiCloudMaasModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeHuaweiCloudMaasModelId
					: currentMode === "kiss"
						? apiConfiguration?.kissModeHuaweiCloudMaasModelId
						: apiConfiguration?.actModeHuaweiCloudMaasModelId
			const huaweiCloudMaasModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeHuaweiCloudMaasModelInfo
					: currentMode === "kiss"
						? apiConfiguration?.kissModeHuaweiCloudMaasModelInfo
						: apiConfiguration?.actModeHuaweiCloudMaasModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: huaweiCloudMaasModelId || huaweiCloudMaasDefaultModelId,
				selectedModelInfo: huaweiCloudMaasModelInfo || huaweiCloudMaasModels[huaweiCloudMaasDefaultModelId],
			}
		case "dify":
			return {
				selectedProvider: provider,
				selectedModelId: "dify-workflow",
				selectedModelInfo: {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsImages: true,
					supportsPromptCache: false,
					inputPrice: 0,
					outputPrice: 0,
					description: "Dify workflow - model selection is configured in your Dify application",
				},
			}
		case "vercel-ai-gateway":
			// Vercel AI Gateway uses its own model fields
			const vercelModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeVercelAiGatewayModelId
					: currentMode === "kiss"
						? apiConfiguration?.kissModeVercelAiGatewayModelId
						: apiConfiguration?.actModeVercelAiGatewayModelId
			const vercelModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeVercelAiGatewayModelInfo
					: currentMode === "kiss"
						? apiConfiguration?.kissModeVercelAiGatewayModelInfo
						: apiConfiguration?.actModeVercelAiGatewayModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: vercelModelId || "",
				selectedModelInfo: vercelModelInfo || openRouterDefaultModelInfo,
			}
		case "zai":
			const zaiModels = apiConfiguration?.zaiApiLine === "china" ? mainlandZAiModels : internationalZAiModels
			const zaiDefaultId =
				apiConfiguration?.zaiApiLine === "china" ? mainlandZAiDefaultModelId : internationalZAiDefaultModelId
			return getProviderData(zaiModels, zaiDefaultId)
		case "fireworks":
			const fireworksModelId =
				currentMode === "plan" ? apiConfiguration?.planModeFireworksModelId : currentMode === "kiss" ? apiConfiguration?.kissModeFireworksModelId : apiConfiguration?.actModeFireworksModelId
			return {
				selectedProvider: provider,
				selectedModelId: fireworksModelId || fireworksDefaultModelId,
				selectedModelInfo:
					fireworksModelId && fireworksModelId in fireworksModels
						? fireworksModels[fireworksModelId as keyof typeof fireworksModels]
						: fireworksModels[fireworksDefaultModelId],
			}
		case "oca":
			const ocaModelId = currentMode === "plan" ? apiConfiguration?.planModeOcaModelId : currentMode === "kiss" ? apiConfiguration?.kissModeOcaModelId : apiConfiguration?.actModeOcaModelId
			const ocaModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeOcaModelInfo : currentMode === "kiss" ? apiConfiguration?.kissModeOcaModelInfo : apiConfiguration?.actModeOcaModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: ocaModelId || "",
				selectedModelInfo: ocaModelInfo || liteLlmModelInfoSaneDefaults,
			}
		case "aihubmix":
			const aihubmixModelId =
				currentMode === "plan" ? apiConfiguration?.planModeAihubmixModelId : currentMode === "kiss" ? apiConfiguration?.kissModeAihubmixModelId : apiConfiguration?.actModeAihubmixModelId
			const aihubmixModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeAihubmixModelInfo : currentMode === "kiss" ? apiConfiguration?.kissModeAihubmixModelInfo : apiConfiguration?.actModeAihubmixModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: aihubmixModelId || "",
				selectedModelInfo: aihubmixModelInfo || openAiModelInfoSaneDefaults,
			}
		case "minimax":
			return getProviderData(minimaxModels, minimaxDefaultModelId)
		case "nousResearch":
			const nousResearchModelId =
				currentMode === "plan"
					? apiConfiguration?.planModeNousResearchModelId
					: currentMode === "kiss"
						? apiConfiguration?.kissModeNousResearchModelId
						: apiConfiguration?.actModeNousResearchModelId
			return {
				selectedProvider: provider,
				selectedModelId: nousResearchModelId || nousResearchDefaultModelId,
				selectedModelInfo:
					nousResearchModelId && nousResearchModelId in nousResearchModels
						? nousResearchModels[nousResearchModelId as keyof typeof nousResearchModels]
						: nousResearchModels[nousResearchDefaultModelId],
			}
		default:
			return getProviderData(anthropicModels, anthropicDefaultModelId)
	}
}

/**
 * Gets mode-specific field values from API configuration
 * @param apiConfiguration The API configuration object
 * @param mode The current mode ("plan" or "act")
 * @returns Object containing mode-specific field values for clean destructuring
 */
export function getModeSpecificFields(apiConfiguration: ApiConfiguration | undefined, mode: Mode) {
	if (!apiConfiguration) {
		return {
			// Core fields
			apiProvider: undefined,
			apiModelId: undefined,

			// Provider-specific model IDs
			togetherModelId: undefined,
			fireworksModelId: undefined,
			lmStudioModelId: undefined,
			ollamaModelId: undefined,
			liteLlmModelId: undefined,
			requestyModelId: undefined,
			openAiModelId: undefined,
			openRouterModelId: undefined,
			clineModelId: undefined,
			groqModelId: undefined,
			basetenModelId: undefined,
			huggingFaceModelId: undefined,
			huaweiCloudMaasModelId: undefined,
			hicapModelId: undefined,
			aihubmixModelId: undefined,
			nousResearchModelId: undefined,
			vercelAiGatewayModelId: undefined,

			// Model info objects
			openAiModelInfo: undefined,
			liteLlmModelInfo: undefined,
			openRouterModelInfo: undefined,
			clineModelInfo: undefined,
			requestyModelInfo: undefined,
			groqModelInfo: undefined,
			basetenModelInfo: undefined,
			huggingFaceModelInfo: undefined,
			vsCodeLmModelSelector: undefined,
			aihubmixModelInfo: undefined,

			// AWS Bedrock fields
			awsBedrockCustomSelected: undefined,
			awsBedrockCustomModelBaseId: undefined,

			// Huawei Cloud Maas Model Info
			huaweiCloudMaasModelInfo: undefined,

			// Other mode-specific fields
			thinkingBudgetTokens: undefined,
			reasoningEffort: undefined,
		}
	}

	const openRouterModelId =
		mode === "plan" ? apiConfiguration.planModeOpenRouterModelId : mode === "kiss" ? apiConfiguration.kissModeOpenRouterModelId : apiConfiguration.actModeOpenRouterModelId
	const openRouterModelInfo =
		mode === "plan" ? apiConfiguration.planModeOpenRouterModelInfo : mode === "kiss" ? apiConfiguration.kissModeOpenRouterModelInfo : apiConfiguration.actModeOpenRouterModelInfo

	// Backward compatibility: Cline previously stored model selection in OpenRouter keys.
	const clineModelId =
		(mode === "plan" ? apiConfiguration.planModeClineModelId : mode === "kiss" ? apiConfiguration.kissModeClineModelId : apiConfiguration.actModeClineModelId) || openRouterModelId
	const clineModelInfo =
		(mode === "plan" ? apiConfiguration.planModeClineModelInfo : mode === "kiss" ? apiConfiguration.kissModeClineModelInfo : apiConfiguration.actModeClineModelInfo) ||
		openRouterModelInfo

	return {
		// Core fields
		apiProvider: coerceSupportedApiProvider(
			mode === "plan" ? apiConfiguration.planModeApiProvider : mode === "kiss" ? apiConfiguration.kissModeApiProvider : apiConfiguration.actModeApiProvider,
		),
		apiModelId: mode === "plan" ? apiConfiguration.planModeApiModelId : mode === "kiss" ? apiConfiguration.kissModeApiModelId : apiConfiguration.actModeApiModelId,

		// Provider-specific model IDs
		togetherModelId: mode === "plan" ? apiConfiguration.planModeTogetherModelId : mode === "kiss" ? apiConfiguration.kissModeTogetherModelId : apiConfiguration.actModeTogetherModelId,
		fireworksModelId: mode === "plan" ? apiConfiguration.planModeFireworksModelId : mode === "kiss" ? apiConfiguration.kissModeFireworksModelId : apiConfiguration.actModeFireworksModelId,
		lmStudioModelId: mode === "plan" ? apiConfiguration.planModeLmStudioModelId : mode === "kiss" ? apiConfiguration.kissModeLmStudioModelId : apiConfiguration.actModeLmStudioModelId,
		ollamaModelId: mode === "plan" ? apiConfiguration.planModeOllamaModelId : mode === "kiss" ? apiConfiguration.kissModeOllamaModelId : apiConfiguration.actModeOllamaModelId,
		liteLlmModelId: mode === "plan" ? apiConfiguration.planModeLiteLlmModelId : mode === "kiss" ? apiConfiguration.kissModeLiteLlmModelId : apiConfiguration.actModeLiteLlmModelId,
		requestyModelId: mode === "plan" ? apiConfiguration.planModeRequestyModelId : mode === "kiss" ? apiConfiguration.kissModeRequestyModelId : apiConfiguration.actModeRequestyModelId,
		openAiModelId: mode === "plan" ? apiConfiguration.planModeOpenAiModelId : mode === "kiss" ? apiConfiguration.kissModeOpenAiModelId : apiConfiguration.actModeOpenAiModelId,
		openRouterModelId,
		clineModelId,
		groqModelId: mode === "plan" ? apiConfiguration.planModeGroqModelId : mode === "kiss" ? apiConfiguration.kissModeGroqModelId : apiConfiguration.actModeGroqModelId,
		basetenModelId: mode === "plan" ? apiConfiguration.planModeBasetenModelId : mode === "kiss" ? apiConfiguration.kissModeBasetenModelId : apiConfiguration.actModeBasetenModelId,
		huggingFaceModelId:
			mode === "plan" ? apiConfiguration.planModeHuggingFaceModelId : mode === "kiss" ? apiConfiguration.kissModeHuggingFaceModelId : apiConfiguration.actModeHuggingFaceModelId,
		huaweiCloudMaasModelId:
			mode === "plan" ? apiConfiguration.planModeHuaweiCloudMaasModelId : mode === "kiss" ? apiConfiguration.kissModeHuaweiCloudMaasModelId : apiConfiguration.actModeHuaweiCloudMaasModelId,
		ocaModelId: mode === "plan" ? apiConfiguration.planModeOcaModelId : mode === "kiss" ? apiConfiguration.kissModeOcaModelId : apiConfiguration.actModeOcaModelId,
		hicapModelId: mode === "plan" ? apiConfiguration.planModeHicapModelId : mode === "kiss" ? apiConfiguration.kissModeHicapModelId : apiConfiguration.actModeHicapModelId,
		aihubmixModelId: mode === "plan" ? apiConfiguration.planModeAihubmixModelId : mode === "kiss" ? apiConfiguration.kissModeAihubmixModelId : apiConfiguration.actModeAihubmixModelId,
		nousResearchModelId:
			mode === "plan" ? apiConfiguration.planModeNousResearchModelId : mode === "kiss" ? apiConfiguration.kissModeNousResearchModelId : apiConfiguration.actModeNousResearchModelId,
		vercelAiGatewayModelId:
			mode === "plan" ? apiConfiguration.planModeVercelAiGatewayModelId : mode === "kiss" ? apiConfiguration.kissModeVercelAiGatewayModelId : apiConfiguration.actModeVercelAiGatewayModelId,

		// Model info objects
		openAiModelInfo: mode === "plan" ? apiConfiguration.planModeOpenAiModelInfo : mode === "kiss" ? apiConfiguration.kissModeOpenAiModelInfo : apiConfiguration.actModeOpenAiModelInfo,
		liteLlmModelInfo: mode === "plan" ? apiConfiguration.planModeLiteLlmModelInfo : mode === "kiss" ? apiConfiguration.kissModeLiteLlmModelInfo : apiConfiguration.actModeLiteLlmModelInfo,
		openRouterModelInfo,
		clineModelInfo,
		requestyModelInfo:
			mode === "plan" ? apiConfiguration.planModeRequestyModelInfo : mode === "kiss" ? apiConfiguration.kissModeRequestyModelInfo : apiConfiguration.actModeRequestyModelInfo,
		groqModelInfo: mode === "plan" ? apiConfiguration.planModeGroqModelInfo : mode === "kiss" ? apiConfiguration.kissModeGroqModelInfo : apiConfiguration.actModeGroqModelInfo,
		basetenModelInfo: mode === "plan" ? apiConfiguration.planModeBasetenModelInfo : mode === "kiss" ? apiConfiguration.kissModeBasetenModelInfo : apiConfiguration.actModeBasetenModelInfo,
		huggingFaceModelInfo:
			mode === "plan" ? apiConfiguration.planModeHuggingFaceModelInfo : mode === "kiss" ? apiConfiguration.kissModeHuggingFaceModelInfo : apiConfiguration.actModeHuggingFaceModelInfo,
		vsCodeLmModelSelector:
			mode === "plan" ? apiConfiguration.planModeVsCodeLmModelSelector : mode === "kiss" ? apiConfiguration.kissModeVsCodeLmModelSelector : apiConfiguration.actModeVsCodeLmModelSelector,
		hicapModelInfo: mode === "plan" ? apiConfiguration.planModeHicapModelInfo : mode === "kiss" ? apiConfiguration.kissModeHicapModelInfo : apiConfiguration.actModeHicapModelInfo,
		aihubmixModelInfo:
			mode === "plan" ? apiConfiguration.planModeAihubmixModelInfo : mode === "kiss" ? apiConfiguration.kissModeAihubmixModelInfo : apiConfiguration.actModeAihubmixModelInfo,
		vercelAiGatewayModelInfo:
			mode === "plan"
				? apiConfiguration.planModeVercelAiGatewayModelInfo
				: mode === "kiss"
					? apiConfiguration.kissModeVercelAiGatewayModelInfo
					: apiConfiguration.actModeVercelAiGatewayModelInfo,

		// AWS Bedrock fields
		awsBedrockCustomSelected:
			mode === "plan"
				? apiConfiguration.planModeAwsBedrockCustomSelected
				: mode === "kiss"
					? apiConfiguration.kissModeAwsBedrockCustomSelected
					: apiConfiguration.actModeAwsBedrockCustomSelected,
		awsBedrockCustomModelBaseId:
			mode === "plan"
				? apiConfiguration.planModeAwsBedrockCustomModelBaseId
				: mode === "kiss"
					? apiConfiguration.kissModeAwsBedrockCustomModelBaseId
					: apiConfiguration.actModeAwsBedrockCustomModelBaseId,

		// Huawei Cloud Maas Model Info
		huaweiCloudMaasModelInfo:
			mode === "plan"
				? apiConfiguration.planModeHuaweiCloudMaasModelInfo
				: mode === "kiss"
					? apiConfiguration.kissModeHuaweiCloudMaasModelInfo
					: apiConfiguration.actModeHuaweiCloudMaasModelInfo,

		// Other mode-specific fields
		thinkingBudgetTokens:
			mode === "plan" ? apiConfiguration.planModeThinkingBudgetTokens : mode === "kiss" ? apiConfiguration.kissModeThinkingBudgetTokens : apiConfiguration.actModeThinkingBudgetTokens,
		reasoningEffort: mode === "plan" ? apiConfiguration.planModeReasoningEffort : mode === "kiss" ? apiConfiguration.kissModeReasoningEffort : apiConfiguration.actModeReasoningEffort,
		// Oracle Code Assist
		ocaModelInfo: mode === "plan" ? apiConfiguration.planModeOcaModelInfo : mode === "kiss" ? apiConfiguration.kissModeOcaModelInfo : apiConfiguration.actModeOcaModelInfo,
	}
}

/**
 * Synchronizes mode configurations by copying the source mode's settings to both modes
 * This is used when the "Use different models for Plan and Act modes" toggle is unchecked
 */
export async function syncModeConfigurations(
	apiConfiguration: ApiConfiguration | undefined,
	sourceMode: Mode,
	handleFieldsChange: (updates: Partial<ApiConfiguration>) => Promise<void>,
): Promise<void> {
	if (!apiConfiguration) {
		return
	}

	const sourceFields = getModeSpecificFields(apiConfiguration, sourceMode)
	const { apiProvider } = sourceFields

	if (!apiProvider) {
		return
	}

	// Build the complete update object with both plan and act mode fields
	const updates: Partial<ApiConfiguration> = {
		// Always sync common fields
		planModeApiProvider: sourceFields.apiProvider,
		actModeApiProvider: sourceFields.apiProvider,
		kissModeApiProvider: sourceFields.apiProvider,
		planModeThinkingBudgetTokens: sourceFields.thinkingBudgetTokens,
		actModeThinkingBudgetTokens: sourceFields.thinkingBudgetTokens,
		kissModeThinkingBudgetTokens: sourceFields.thinkingBudgetTokens,
		planModeReasoningEffort: sourceFields.reasoningEffort,
		actModeReasoningEffort: sourceFields.reasoningEffort,
		kissModeReasoningEffort: sourceFields.reasoningEffort,
	}

	// Handle provider-specific fields
	switch (apiProvider) {
		case "openrouter":
			updates.planModeOpenRouterModelId = sourceFields.openRouterModelId
			updates.actModeOpenRouterModelId = sourceFields.openRouterModelId
			updates.kissModeOpenRouterModelId = sourceFields.openRouterModelId
			updates.planModeOpenRouterModelInfo = sourceFields.openRouterModelInfo
			updates.actModeOpenRouterModelInfo = sourceFields.openRouterModelInfo
			updates.kissModeOpenRouterModelInfo = sourceFields.openRouterModelInfo
			break

		case "cline":
			updates.planModeClineModelId = sourceFields.clineModelId
			updates.actModeClineModelId = sourceFields.clineModelId
			updates.kissModeClineModelId = sourceFields.clineModelId
			updates.planModeClineModelInfo = sourceFields.clineModelInfo
			updates.actModeClineModelInfo = sourceFields.clineModelInfo
			updates.kissModeClineModelInfo = sourceFields.clineModelInfo
			break

		case "requesty":
			updates.planModeRequestyModelId = sourceFields.requestyModelId
			updates.actModeRequestyModelId = sourceFields.requestyModelId
			updates.kissModeRequestyModelId = sourceFields.requestyModelId
			updates.planModeRequestyModelInfo = sourceFields.requestyModelInfo
			updates.actModeRequestyModelInfo = sourceFields.requestyModelInfo
			updates.kissModeRequestyModelInfo = sourceFields.requestyModelInfo
			break

		case "openai":
			updates.planModeOpenAiModelId = sourceFields.openAiModelId
			updates.actModeOpenAiModelId = sourceFields.openAiModelId
			updates.kissModeOpenAiModelId = sourceFields.openAiModelId
			updates.planModeOpenAiModelInfo = sourceFields.openAiModelInfo
			updates.actModeOpenAiModelInfo = sourceFields.openAiModelInfo
			updates.kissModeOpenAiModelInfo = sourceFields.openAiModelInfo
			break

		case "ollama":
			updates.planModeOllamaModelId = sourceFields.ollamaModelId
			updates.actModeOllamaModelId = sourceFields.ollamaModelId
			updates.kissModeOllamaModelId = sourceFields.ollamaModelId
			break

		case "lmstudio":
			updates.planModeLmStudioModelId = sourceFields.lmStudioModelId
			updates.actModeLmStudioModelId = sourceFields.lmStudioModelId
			updates.kissModeLmStudioModelId = sourceFields.lmStudioModelId
			break

		case "vscode-lm":
			updates.planModeVsCodeLmModelSelector = sourceFields.vsCodeLmModelSelector
			updates.actModeVsCodeLmModelSelector = sourceFields.vsCodeLmModelSelector
			updates.kissModeVsCodeLmModelSelector = sourceFields.vsCodeLmModelSelector
			break

		case "litellm":
			updates.planModeLiteLlmModelId = sourceFields.liteLlmModelId
			updates.actModeLiteLlmModelId = sourceFields.liteLlmModelId
			updates.kissModeLiteLlmModelId = sourceFields.liteLlmModelId
			updates.planModeLiteLlmModelInfo = sourceFields.liteLlmModelInfo
			updates.actModeLiteLlmModelInfo = sourceFields.liteLlmModelInfo
			updates.kissModeLiteLlmModelInfo = sourceFields.liteLlmModelInfo
			break

		case "groq":
			updates.planModeGroqModelId = sourceFields.groqModelId
			updates.actModeGroqModelId = sourceFields.groqModelId
			updates.kissModeGroqModelId = sourceFields.groqModelId
			updates.planModeGroqModelInfo = sourceFields.groqModelInfo
			updates.actModeGroqModelInfo = sourceFields.groqModelInfo
			updates.kissModeGroqModelInfo = sourceFields.groqModelInfo
			break

		case "huggingface":
			updates.planModeHuggingFaceModelId = sourceFields.huggingFaceModelId
			updates.actModeHuggingFaceModelId = sourceFields.huggingFaceModelId
			updates.kissModeHuggingFaceModelId = sourceFields.huggingFaceModelId
			updates.planModeHuggingFaceModelInfo = sourceFields.huggingFaceModelInfo
			updates.actModeHuggingFaceModelInfo = sourceFields.huggingFaceModelInfo
			updates.kissModeHuggingFaceModelInfo = sourceFields.huggingFaceModelInfo
			break

		case "baseten":
			updates.planModeBasetenModelId = sourceFields.basetenModelId
			updates.actModeBasetenModelId = sourceFields.basetenModelId
			updates.kissModeBasetenModelId = sourceFields.basetenModelId
			updates.planModeBasetenModelInfo = sourceFields.basetenModelInfo
			updates.actModeBasetenModelInfo = sourceFields.basetenModelInfo
			updates.kissModeBasetenModelInfo = sourceFields.basetenModelInfo
			break

		case "together":
			updates.planModeTogetherModelId = sourceFields.togetherModelId
			updates.actModeTogetherModelId = sourceFields.togetherModelId
			updates.kissModeTogetherModelId = sourceFields.togetherModelId
			break

		case "fireworks":
			updates.planModeFireworksModelId = sourceFields.fireworksModelId
			updates.actModeFireworksModelId = sourceFields.fireworksModelId
			updates.kissModeFireworksModelId = sourceFields.fireworksModelId
			break

		case "bedrock":
			updates.planModeApiModelId = sourceFields.apiModelId
			updates.actModeApiModelId = sourceFields.apiModelId
			updates.kissModeApiModelId = sourceFields.apiModelId
			updates.planModeAwsBedrockCustomSelected = sourceFields.awsBedrockCustomSelected
			updates.actModeAwsBedrockCustomSelected = sourceFields.awsBedrockCustomSelected
			updates.kissModeAwsBedrockCustomSelected = sourceFields.awsBedrockCustomSelected
			updates.planModeAwsBedrockCustomModelBaseId = sourceFields.awsBedrockCustomModelBaseId
			updates.actModeAwsBedrockCustomModelBaseId = sourceFields.awsBedrockCustomModelBaseId
			updates.kissModeAwsBedrockCustomModelBaseId = sourceFields.awsBedrockCustomModelBaseId
			break
		case "huawei-cloud-maas":
			updates.planModeHuaweiCloudMaasModelId = sourceFields.huaweiCloudMaasModelId
			updates.actModeHuaweiCloudMaasModelId = sourceFields.huaweiCloudMaasModelId
			updates.kissModeHuaweiCloudMaasModelId = sourceFields.huaweiCloudMaasModelId
			updates.planModeHuaweiCloudMaasModelInfo = sourceFields.huaweiCloudMaasModelInfo
			updates.actModeHuaweiCloudMaasModelInfo = sourceFields.huaweiCloudMaasModelInfo
			updates.kissModeHuaweiCloudMaasModelInfo = sourceFields.huaweiCloudMaasModelInfo
			break

		case "dify":
			// Dify doesn't have mode-specific model configurations
			// The model is configured in the Dify application itself
			break

		case "hicap":
			updates.planModeHicapModelId = sourceFields.hicapModelId
			updates.actModeHicapModelId = sourceFields.hicapModelId
			updates.kissModeHicapModelId = sourceFields.hicapModelId
			updates.planModeHicapModelInfo = sourceFields.hicapModelInfo
			updates.actModeHicapModelInfo = sourceFields.hicapModelInfo
			updates.kissModeHicapModelInfo = sourceFields.hicapModelInfo
			break

		case "vercel-ai-gateway":
			// Vercel AI Gateway uses its own model fields
			updates.planModeVercelAiGatewayModelId = sourceFields.vercelAiGatewayModelId
			updates.actModeVercelAiGatewayModelId = sourceFields.vercelAiGatewayModelId
			updates.kissModeVercelAiGatewayModelId = sourceFields.vercelAiGatewayModelId
			updates.planModeVercelAiGatewayModelInfo = sourceFields.vercelAiGatewayModelInfo
			updates.actModeVercelAiGatewayModelInfo = sourceFields.vercelAiGatewayModelInfo
			updates.kissModeVercelAiGatewayModelInfo = sourceFields.vercelAiGatewayModelInfo
			break
		case "oca":
			updates.planModeOcaModelId = sourceFields.ocaModelId
			updates.actModeOcaModelId = sourceFields.ocaModelId
			updates.kissModeOcaModelId = sourceFields.ocaModelId
			updates.planModeOcaModelInfo = sourceFields.ocaModelInfo
			updates.actModeOcaModelInfo = sourceFields.ocaModelInfo
			updates.kissModeOcaModelInfo = sourceFields.ocaModelInfo
			break
		case "nousResearch":
			updates.planModeNousResearchModelId = sourceFields.nousResearchModelId
			updates.actModeNousResearchModelId = sourceFields.nousResearchModelId
			updates.kissModeNousResearchModelId = sourceFields.nousResearchModelId
			break

		case "aihubmix":
			updates.planModeAihubmixModelId = sourceFields.aihubmixModelId
			updates.planModeAihubmixModelInfo = sourceFields.aihubmixModelInfo
			updates.actModeAihubmixModelId = sourceFields.aihubmixModelId
			updates.kissModeAihubmixModelId = sourceFields.aihubmixModelId
			updates.actModeAihubmixModelInfo = sourceFields.aihubmixModelInfo
			updates.kissModeAihubmixModelInfo = sourceFields.aihubmixModelInfo
			break

		// Providers that use apiProvider + apiModelId fields
		case "anthropic":
		case "claude-code":
		case "vertex":
		case "gemini":
		case "openai-native":
		case "openai-codex":
		case "deepseek":
		case "qwen":
		case "doubao":
		case "mistral":
		case "asksage":
		case "xai":
		case "nebius":
		case "wandb":
		case "sambanova":
		case "cerebras":
		case "sapaicore":
		case "zai":
		case "minimax":
		default:
			updates.planModeApiModelId = sourceFields.apiModelId
			updates.actModeApiModelId = sourceFields.apiModelId
			updates.kissModeApiModelId = sourceFields.apiModelId
			break
	}

	// Make the atomic update
	await handleFieldsChange(updates)
}

export { filterOpenRouterModelIds } from "@shared/utils/model-filters"

// Helper to get provider-specific configuration info and empty state guidance
export const getProviderInfo = (
	provider: ApiProvider,
	apiConfiguration: any,
	effectiveMode: "plan" | "act" | "kiss",
): { modelId?: string; baseUrl?: string; helpText: string } => {
	switch (provider) {
		case "baseten":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeBasetenModelId : effectiveMode === "kiss" ? apiConfiguration.kissModeBasetenModelId : apiConfiguration.actModeBasetenModelId,
				baseUrl: apiConfiguration.basetenBaseUrl,
				helpText: "Start Baseten and load a model to begin",
			}
		case "lmstudio":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeLmStudioModelId : effectiveMode === "kiss" ? apiConfiguration.kissModeLmStudioModelId : apiConfiguration.actModeLmStudioModelId,
				baseUrl: apiConfiguration.lmStudioBaseUrl,
				helpText: "Start LM Studio and load a model to begin",
			}
		case "ollama":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeOllamaModelId : effectiveMode === "kiss" ? apiConfiguration.kissModeOllamaModelId : apiConfiguration.actModeOllamaModelId,
				baseUrl: apiConfiguration.ollamaBaseUrl,
				helpText: "Run `ollama serve` and pull a model",
			}
		case "litellm":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeLiteLlmModelId : effectiveMode === "kiss" ? apiConfiguration.kissModeLiteLlmModelId : apiConfiguration.actModeLiteLlmModelId,
				baseUrl: apiConfiguration.liteLlmBaseUrl,
				helpText: "Add your LiteLLM proxy URL in settings",
			}
		case "openai":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeOpenAiModelId : effectiveMode === "kiss" ? apiConfiguration.kissModeOpenAiModelId : apiConfiguration.actModeOpenAiModelId,
				baseUrl: apiConfiguration.openAiBaseUrl,
				helpText: "Add your OpenAI API key and endpoint",
			}
		case "vscode-lm":
			return {
				modelId: undefined,
				baseUrl: undefined,
				helpText: "Select a VS Code language model from settings",
			}
		case "requesty":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeRequestyModelId : effectiveMode === "kiss" ? apiConfiguration.kissModeRequestyModelId : apiConfiguration.actModeRequestyModelId,
				baseUrl: apiConfiguration.requestyBaseUrl,
				helpText: "Add your Requesty API key in settings",
			}
		case "together":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeTogetherModelId : effectiveMode === "kiss" ? apiConfiguration.kissModeTogetherModelId : apiConfiguration.actModeTogetherModelId,
				baseUrl: undefined,
				helpText: "Add your Together AI API key in settings",
			}
		case "dify":
			return {
				modelId: undefined,
				baseUrl: apiConfiguration.difyBaseUrl,
				helpText: "Configure your Dify workflow URL and API key",
			}
		case "hicap":
			return {
				modelId: effectiveMode === "plan" ? apiConfiguration.planModeHicapModelId : effectiveMode === "kiss" ? apiConfiguration.kissModeHicapModelId : apiConfiguration.actModeHicapModelId,
				baseUrl: undefined,
				helpText: "Add your HiCap API key in settings",
			}
		case "oca":
			return {
				modelId: effectiveMode === "plan" ? apiConfiguration.planModeOcaModelId : effectiveMode === "kiss" ? apiConfiguration.kissModeOcaModelId : apiConfiguration.actModeOcaModelId,
				baseUrl: apiConfiguration.ocaBaseUrl,
				helpText: "Configure your OCA endpoint in settings",
			}
		case "aihubmix":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeAihubmixModelId : effectiveMode === "kiss" ? apiConfiguration.kissModeAihubmixModelId : apiConfiguration.actModeAihubmixModelId,
				baseUrl: apiConfiguration.aihubmixBaseUrl,
				helpText: "Add your AIHubMix API key in settings",
			}
		default:
			return {
				modelId: undefined,
				baseUrl: undefined,
				helpText: "Configure this provider in model settings",
			}
	}
}
