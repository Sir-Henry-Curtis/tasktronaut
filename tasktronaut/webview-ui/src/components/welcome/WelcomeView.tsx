import { BooleanRequest } from "@shared/proto/cline/common"
import { UpdateApiConfigurationRequest } from "@shared/proto/cline/models"
import { convertApiConfigurationToProto } from "@shared/proto-conversions/models/api-configuration-conversion"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { memo, useEffect, useRef, useState } from "react"
import ClineLogoWhite from "@/assets/ClineLogoWhite"
import ApiOptions from "@/components/settings/ApiOptions"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import { validateApiConfiguration } from "@/utils/validate"

const WelcomeView = memo(() => {
	const { apiConfiguration, mode } = useExtensionState()
	const [apiErrorMessage, setApiErrorMessage] = useState<string | undefined>(undefined)
	const providerInitialized = useRef(false)

	const disableLaunchButton = apiErrorMessage != null

	const handleSubmit = async () => {
		try {
			await StateServiceClient.setWelcomeViewCompleted(BooleanRequest.create({ value: true }))
		} catch (error) {
			console.error("Failed to update API configuration or complete welcome view:", error)
		}
	}

	// Ensure the provider stays pinned to the supported OpenAI-compatible path.
	useEffect(() => {
		if (providerInitialized.current) return
		if (apiConfiguration?.actModeApiProvider === "openai" && apiConfiguration?.planModeApiProvider === "openai") return
		providerInitialized.current = true
		const updated = {
			...apiConfiguration,
			actModeApiProvider: "openai" as const,
			planModeApiProvider: "openai" as const,
		}
		ModelsServiceClient.updateApiConfigurationProto(
			UpdateApiConfigurationRequest.create({ apiConfiguration: convertApiConfigurationToProto(updated) }),
		).catch(() => {})
	}, [apiConfiguration])

	useEffect(() => {
		setApiErrorMessage(validateApiConfiguration(mode, apiConfiguration))
	}, [apiConfiguration, mode])

	return (
		<div className="fixed inset-0 p-0 flex flex-col">
			<div className="h-full px-5 overflow-auto flex flex-col gap-2.5">
				<h2 className="text-lg font-semibold">Set up Tasktronaut</h2>
				<div className="flex justify-center my-5">
					<ClineLogoWhite className="size-16" />
				</div>
				<p>
					Tasktronaut is a mission-ready coding assistant for structured engineering workflows. Configure your
					OpenAI-compatible endpoint, then it can plan tasks, edit files, run terminal commands, and use browser tools
					with your approval.
				</p>

				<p className="text-(--vscode-descriptionForeground)">
					Setup is endpoint-first. Use the approved environment configuration or connect your own base URL, API key, and
					model.
				</p>

				<div className="mt-4.5">
					<ApiOptions currentMode={mode} showModelOptions={true} />
					{apiErrorMessage && (
						<p className="text-xs mt-1.5 mb-1" style={{ color: "var(--vscode-errorForeground)" }}>
							{apiErrorMessage}
						</p>
					)}
					<VSCodeButton className="mt-0.75" disabled={disableLaunchButton} onClick={handleSubmit}>
						Launch Tasktronaut
					</VSCodeButton>
				</div>
			</div>
		</div>
	)
})

export default WelcomeView
