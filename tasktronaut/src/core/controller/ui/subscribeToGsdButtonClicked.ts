import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

const activeGsdButtonClickedSubscriptions = new Set<StreamingResponseHandler<Empty>>()

export async function subscribeToGsdButtonClicked(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	activeGsdButtonClickedSubscriptions.add(responseStream)

	const cleanup = () => {
		activeGsdButtonClickedSubscriptions.delete(responseStream)
	}

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "gsd_button_clicked_subscription" }, responseStream)
	}
}

export async function sendGsdButtonClickedEvent(): Promise<void> {
	const promises = Array.from(activeGsdButtonClickedSubscriptions).map(async (responseStream) => {
		try {
			await responseStream(Empty.create({}), false)
		} catch (error) {
			Logger.error("Error sending GSD button clicked event:", error)
			activeGsdButtonClickedSubscriptions.delete(responseStream)
		}
	})

	await Promise.all(promises)
}
