import { EmptyRequest } from "@shared/proto/cline/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/cline/models"
import { Controller } from ".."

export async function getAihubmixModels(_controller: Controller, _request: EmptyRequest): Promise<OpenRouterCompatibleModelInfo> {
	// FORK MOD: ITAR/network-isolated build — AIHubMix model discovery (aihubmix.com) disabled.
	return OpenRouterCompatibleModelInfo.create({ models: {} })
}
