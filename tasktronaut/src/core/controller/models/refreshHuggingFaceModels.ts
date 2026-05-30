import { EmptyRequest } from "@shared/proto/cline/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/cline/models"
import { Controller } from ".."

export async function refreshHuggingFaceModels(
	_controller: Controller,
	_request: EmptyRequest,
): Promise<OpenRouterCompatibleModelInfo> {
	// FORK MOD: ITAR/network-isolated build — HuggingFace model discovery (router.huggingface.co) disabled.
	return OpenRouterCompatibleModelInfo.create({ models: {} })
}
