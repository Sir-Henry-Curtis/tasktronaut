import { GsdSettingsResponse, UpdateGsdSettingsRequest } from "@shared/proto/cline/state"
import { Controller } from ".."
import { writeGsdSettings } from "./gsd-settings"

export async function updateGsdSettings(
	_controller: Controller,
	request: UpdateGsdSettingsRequest,
): Promise<GsdSettingsResponse> {
	return writeGsdSettings(request)
}
