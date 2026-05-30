import { EmptyRequest } from "@shared/proto/cline/common"
import { GsdSettingsResponse } from "@shared/proto/cline/state"
import { Controller } from ".."
import { buildGsdSettingsResponse, resolveGsdSettingsContext } from "./gsd-settings"

export async function getGsdSettings(_controller: Controller, _request: EmptyRequest): Promise<GsdSettingsResponse> {
	const context = await resolveGsdSettingsContext()
	return buildGsdSettingsResponse(context)
}
