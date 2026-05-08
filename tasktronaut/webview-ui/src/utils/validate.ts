import { ApiConfiguration, ModelInfo, coerceSupportedApiProvider } from "@shared/api"
import { Mode } from "@shared/storage/types"
import { getModeSpecificFields } from "@/components/settings/utils/providerUtils"

export function validateApiConfiguration(currentMode: Mode, apiConfiguration?: ApiConfiguration): string | undefined {
	if (apiConfiguration) {
		const {
			apiProvider,
		} = getModeSpecificFields(apiConfiguration, currentMode)

		if (coerceSupportedApiProvider(apiProvider) === "openai") {
			if (!apiConfiguration.openAiBaseUrl) {
				return "You must provide a base URL."
			}
			if (!apiConfiguration.openAiApiKey && !apiConfiguration.azureIdentity) {
				return "You must provide an API key."
			}
		}
	}
	return undefined
}

export function validateModelId(
	currentMode: Mode,
	apiConfiguration?: ApiConfiguration,
	_openRouterModels?: Record<string, ModelInfo>,
	_clineModels?: Record<string, ModelInfo>,
): string | undefined {
	if (apiConfiguration) {
		const { apiProvider, openAiModelId } = getModeSpecificFields(apiConfiguration, currentMode)
		if (coerceSupportedApiProvider(apiProvider) === "openai" && !openAiModelId) {
			return "You must provide a model ID."
		}
	}
	return undefined
}
