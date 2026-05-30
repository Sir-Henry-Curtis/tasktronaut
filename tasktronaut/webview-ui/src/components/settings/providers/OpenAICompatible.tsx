import { TooltipContent, TooltipTrigger } from "@radix-ui/react-tooltip"
import { ModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import { OpenAiModelsRequest } from "@shared/proto/cline/models"
import { Mode } from "@shared/storage/types"
import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { InfoIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Tooltip } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { getAsVar, VSC_DESCRIPTION_FOREGROUND } from "@/utils/vscStyles"
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelAutocomplete } from "../common/ModelAutocomplete"
import { ModelInfoView } from "../common/ModelInfoView"
import ReasoningEffortSelector from "../ReasoningEffortSelector"
import { parsePrice } from "../utils/pricingUtils"
import { getModeSpecificFields, normalizeApiConfiguration } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * Props for the OpenAICompatibleProvider component
 */
interface OpenAICompatibleProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

const AdvancedSettingLabel = ({ label, tooltip }: { label: string; tooltip: string }) => (
	<span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 500 }}>
		<span>{label}</span>
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className="cursor-help"
					style={{ display: "inline-flex", alignItems: "center", opacity: 0.8 }}
					aria-label={`${label} help`}>
					<InfoIcon size={14} />
				</span>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs whitespace-pre-wrap" side="top">
				{tooltip}
			</TooltipContent>
		</Tooltip>
	</span>
)

/**
 * The OpenAI Compatible provider configuration component
 */
export const OpenAICompatibleProvider = ({ showModelOptions, isPopup, currentMode }: OpenAICompatibleProviderProps) => {
	const { apiConfiguration, remoteConfigSettings } = useExtensionState()
	const { handleFieldChange, handleModeFieldChange, handleModeFieldsChange } = useApiConfigurationHandlers()

	const [modelConfigurationSelected, setModelConfigurationSelected] = useState(false)
	const [availableModelIds, setAvailableModelIds] = useState<string[]>([])
	const [isLoadingModels, setIsLoadingModels] = useState(false)
	const [hasFetchedModels, setHasFetchedModels] = useState(false)
	const [modelLoadError, setModelLoadError] = useState<string | undefined>(undefined)

	// Get the normalized configuration
	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)

	// Get mode-specific fields
	const { openAiModelInfo } = getModeSpecificFields(apiConfiguration, currentMode)

	// Debounced function to refresh OpenAI models (prevents excessive API calls while typing)
	const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

	useEffect(() => {
		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current)
			}
		}
	}, [])

	const refreshOpenAiModels = useCallback(async (baseUrl?: string, apiKey?: string) => {
		if (!baseUrl || !apiKey) {
			setAvailableModelIds([])
			setHasFetchedModels(false)
			setModelLoadError(undefined)
			return
		}

		setIsLoadingModels(true)
		setModelLoadError(undefined)

		try {
			const response = await ModelsServiceClient.refreshOpenAiModels(
				OpenAiModelsRequest.create({
					baseUrl,
					apiKey,
				}),
			)
			const models = [...new Set((response.values || []).filter(Boolean))].sort((a, b) => a.localeCompare(b))
			setAvailableModelIds(models)
			setHasFetchedModels(true)
			if (models.length === 0) {
				setModelLoadError("No models were returned by this endpoint. You can still enter a model ID manually.")
			}
		} catch (error) {
			console.error("Failed to refresh OpenAI models:", error)
			setAvailableModelIds([])
			setHasFetchedModels(true)
			setModelLoadError("Unable to load models from this endpoint. You can still enter a model ID manually.")
		} finally {
			setIsLoadingModels(false)
		}
	}, [])

	const debouncedRefreshOpenAiModels = useCallback((baseUrl?: string, apiKey?: string) => {
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current)
		}

		if (!baseUrl || !apiKey) {
			setAvailableModelIds([])
			setHasFetchedModels(false)
			setModelLoadError(undefined)
			return
		}

		debounceTimerRef.current = setTimeout(() => {
			void refreshOpenAiModels(baseUrl, apiKey)
		}, 500)
	}, [refreshOpenAiModels])

	useEffect(() => {
		if (apiConfiguration?.openAiBaseUrl && apiConfiguration?.openAiApiKey) {
			void refreshOpenAiModels(apiConfiguration.openAiBaseUrl, apiConfiguration.openAiApiKey)
		}
	}, [apiConfiguration?.openAiApiKey, apiConfiguration?.openAiBaseUrl, refreshOpenAiModels])

	const availableModels = useMemo<Record<string, ModelInfo>>(() => {
		const modelMap = Object.fromEntries(
			availableModelIds.map((modelId) => [
				modelId,
				modelId === selectedModelId && openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults },
			]),
		)
		return modelMap
	}, [availableModelIds, openAiModelInfo, selectedModelId])

	const showFetchedModelSelector = showModelOptions && availableModelIds.length > 0

	const handleOpenAiModelChange = async (newModelId: string, modelInfo: ModelInfo | undefined) => {
		await handleModeFieldsChange(
			{
				apiProvider: { plan: "planModeApiProvider", act: "actModeApiProvider" },
				openAiModelId: { plan: "planModeOpenAiModelId", act: "actModeOpenAiModelId" },
				openAiModelInfo: { plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
			},
			{
				apiProvider: "openai" as const,
				openAiModelId: newModelId,
				openAiModelInfo: modelInfo ?? { ...openAiModelInfoSaneDefaults },
			},
			currentMode,
		)
	}

	return (
		<div>
			<Tooltip>
				<TooltipTrigger>
					<div className="mb-2.5">
						<div className="flex items-center gap-2 mb-1">
							<span style={{ fontWeight: 500 }}>Base URL</span>
							{remoteConfigSettings?.openAiBaseUrl !== undefined && (
								<i className="codicon codicon-lock text-description text-sm" />
							)}
						</div>
						<DebouncedTextField
							disabled={remoteConfigSettings?.openAiBaseUrl !== undefined}
							initialValue={apiConfiguration?.openAiBaseUrl || ""}
							onChange={(value) => {
								handleFieldChange("openAiBaseUrl", value)
								debouncedRefreshOpenAiModels(value, apiConfiguration?.openAiApiKey)
							}}
							placeholder={"Enter base URL..."}
							style={{ width: "100%", marginBottom: 10 }}
							type="text"
						/>
					</div>
				</TooltipTrigger>
				<TooltipContent hidden={remoteConfigSettings?.openAiBaseUrl === undefined}>
					This setting is managed by your organization's remote configuration
				</TooltipContent>
			</Tooltip>

			<ApiKeyField
				initialValue={apiConfiguration?.openAiApiKey || ""}
				onChange={(value) => {
					handleFieldChange("openAiApiKey", value)
					debouncedRefreshOpenAiModels(apiConfiguration?.openAiBaseUrl, value)
				}}
				providerName="OpenAI Compatible"
			/>

			{showFetchedModelSelector ? (
				<ModelAutocomplete
					label="Model"
					models={availableModels}
					onChange={handleOpenAiModelChange}
					placeholder="Search and select a model..."
					selectedModelId={selectedModelId}
				/>
			) : (
				<DebouncedTextField
					initialValue={selectedModelId || ""}
					onChange={(value) =>
						void handleModeFieldsChange(
							{
								apiProvider: { plan: "planModeApiProvider", act: "actModeApiProvider" },
								openAiModelId: { plan: "planModeOpenAiModelId", act: "actModeOpenAiModelId" },
							},
							{ apiProvider: "openai" as const, openAiModelId: value },
							currentMode,
						)
					}
					placeholder={apiConfiguration?.openAiBaseUrl && apiConfiguration?.openAiApiKey ? "Loading models..." : "Enter Model ID..."}
					style={{ width: "100%", marginBottom: 10 }}>
					<span style={{ fontWeight: 500 }}>Model ID</span>
				</DebouncedTextField>
			)}

			{showModelOptions && apiConfiguration?.openAiBaseUrl && apiConfiguration?.openAiApiKey && (
				<div
					style={{
						fontSize: "12px",
						marginTop: "-4px",
						marginBottom: "10px",
						color: modelLoadError ? "var(--vscode-descriptionForeground)" : "var(--vscode-descriptionForeground)",
					}}>
					{isLoadingModels
						? "Loading models from the configured endpoint..."
						: modelLoadError
							? modelLoadError
							: hasFetchedModels && availableModelIds.length > 0
								? `Loaded ${availableModelIds.length} model${availableModelIds.length === 1 ? "" : "s"} from the configured endpoint.`
								: null}
				</div>
			)}

			{/* OpenAI Compatible Custom Headers */}
			{(() => {
				const headerEntries = Object.entries(apiConfiguration?.openAiHeaders ?? {})

				return (
					<div style={{ marginBottom: 10 }}>
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
							<Tooltip>
								<TooltipTrigger>
									<div className="flex items-center gap-2">
										<span style={{ fontWeight: 500 }}>Custom Headers</span>
										{remoteConfigSettings?.openAiHeaders !== undefined && (
											<i className="codicon codicon-lock text-description text-sm" />
										)}
									</div>
								</TooltipTrigger>
								<TooltipContent hidden={remoteConfigSettings?.openAiHeaders === undefined}>
									This setting is managed by your organization's remote configuration
								</TooltipContent>
							</Tooltip>
							<VSCodeButton
								disabled={remoteConfigSettings?.openAiHeaders !== undefined}
								onClick={() => {
									const currentHeaders = { ...(apiConfiguration?.openAiHeaders || {}) }
									const headerCount = Object.keys(currentHeaders).length
									const newKey = `header${headerCount + 1}`
									currentHeaders[newKey] = ""
									handleFieldChange("openAiHeaders", currentHeaders)
								}}>
								Add Header
							</VSCodeButton>
						</div>

						<div>
							{headerEntries.map(([key, value], index) => (
								<div key={index} style={{ display: "flex", gap: 5, marginTop: 5 }}>
									<DebouncedTextField
										disabled={remoteConfigSettings?.openAiHeaders !== undefined}
										initialValue={key}
										onChange={(newValue) => {
											const currentHeaders = apiConfiguration?.openAiHeaders ?? {}
											if (newValue && newValue !== key) {
												const { [key]: _, ...rest } = currentHeaders
												handleFieldChange("openAiHeaders", {
													...rest,
													[newValue]: value,
												})
											}
										}}
										placeholder="Header name"
										style={{ width: "40%" }}
									/>
									<DebouncedTextField
										disabled={remoteConfigSettings?.openAiHeaders !== undefined}
										initialValue={value}
										onChange={(newValue) => {
											handleFieldChange("openAiHeaders", {
												...(apiConfiguration?.openAiHeaders ?? {}),
												[key]: newValue,
											})
										}}
										placeholder="Header value"
										style={{ width: "40%" }}
									/>
									<VSCodeButton
										appearance="secondary"
										disabled={remoteConfigSettings?.openAiHeaders !== undefined}
										onClick={() => {
											const { [key]: _, ...rest } = apiConfiguration?.openAiHeaders ?? {}
											handleFieldChange("openAiHeaders", rest)
										}}>
										Remove
									</VSCodeButton>
								</div>
							))}
						</div>
					</div>
				)
			})()}

			<div
				onClick={() => setModelConfigurationSelected((val) => !val)}
				style={{
					color: getAsVar(VSC_DESCRIPTION_FOREGROUND),
					display: "flex",
					margin: "10px 0",
					cursor: "pointer",
					alignItems: "center",
				}}>
				<span
					className={`codicon ${modelConfigurationSelected ? "codicon-chevron-down" : "codicon-chevron-right"}`}
					style={{
						marginRight: "4px",
					}}
				/>
				<span
					style={{
						fontWeight: 700,
						textTransform: "uppercase",
					}}>
					Model Configuration
				</span>
			</div>

			{modelConfigurationSelected && (
				<>
					<VSCodeCheckbox
						checked={!!openAiModelInfo?.supportsImages}
						onChange={(e: any) => {
							const isChecked = e.target.checked === true
							const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
							modelInfo.supportsImages = isChecked
							handleModeFieldChange(
								{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
								modelInfo,
								currentMode,
							)
						}}>
						<AdvancedSettingLabel
							label="Supports Images"
							tooltip="Enable this only if the selected endpoint/model accepts image inputs. Leave it on for modern multimodal OpenAI models. Turn it off for text-only backends."
						/>
					</VSCodeCheckbox>

					<VSCodeCheckbox
						checked={!!openAiModelInfo?.isR1FormatRequired}
						onChange={(e: any) => {
							const isChecked = e.target.checked === true
							let modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
							modelInfo = { ...modelInfo, isR1FormatRequired: isChecked }

							handleModeFieldChange(
								{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
								modelInfo,
								currentMode,
							)
						}}>
						<AdvancedSettingLabel
							label="Enable R1 messages format"
							tooltip="Compatibility toggle for DeepSeek R1-style OpenAI-compatible backends that expect a different message/tool schema. Leave this off for normal OpenAI GPT-5.x endpoints."
						/>
					</VSCodeCheckbox>

					<div style={{ display: "flex", gap: 10, marginTop: "5px" }}>
						<DebouncedTextField
							initialValue={
								openAiModelInfo?.contextWindow
									? openAiModelInfo.contextWindow.toString()
									: (openAiModelInfoSaneDefaults.contextWindow?.toString() ?? "")
							}
							onChange={(value) => {
								const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
								modelInfo.contextWindow = Number(value)
								handleModeFieldChange(
									{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
									modelInfo,
									currentMode,
								)
							}}
							style={{ flex: 1 }}>
							<AdvancedSettingLabel
								label="Context Window Size"
								tooltip="Informational model limit for total prompt history plus output. For OpenAI GPT-5.4 this should usually stay around 128K to 1.05M depending on the real model metadata. Changing this does not by itself fix TPM rate limits."
							/>
						</DebouncedTextField>

						<DebouncedTextField
							initialValue={
								openAiModelInfo?.maxTokens
									? openAiModelInfo.maxTokens.toString()
									: (openAiModelInfoSaneDefaults.maxTokens?.toString() ?? "")
							}
							onChange={(value) => {
								const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
								modelInfo.maxTokens = Number(value)
								handleModeFieldChange(
									{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
									modelInfo,
									currentMode,
								)
							}}
							style={{ flex: 1 }}>
							<AdvancedSettingLabel
								label="Max Output Tokens"
								tooltip="Caps how many tokens the model may generate in one response. Sane GPT-5.4 value: 8192. Use -1 only when the app should fall back to the built-in model default. Very large values like 500000 are not appropriate here."
							/>
						</DebouncedTextField>
					</div>

					<div style={{ display: "flex", gap: 10, marginTop: "5px" }}>
						<DebouncedTextField
							initialValue={
								openAiModelInfo?.inputPrice
									? openAiModelInfo.inputPrice.toString()
									: (openAiModelInfoSaneDefaults.inputPrice?.toString() ?? "")
							}
							onChange={(value) => {
								const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
								modelInfo.inputPrice = parsePrice(value, openAiModelInfoSaneDefaults.inputPrice ?? 0)
								handleModeFieldChange(
									{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
									modelInfo,
									currentMode,
								)
							}}
							style={{ flex: 1 }}>
							<AdvancedSettingLabel
								label="Input Price / 1M tokens"
								tooltip="Optional pricing metadata used for cost display only. It does not change model behavior. Set this if your OpenAI-compatible endpoint has custom pricing."
							/>
						</DebouncedTextField>

						<DebouncedTextField
							initialValue={
								openAiModelInfo?.outputPrice
									? openAiModelInfo.outputPrice.toString()
									: (openAiModelInfoSaneDefaults.outputPrice?.toString() ?? "")
							}
							onChange={(value) => {
								const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
								modelInfo.outputPrice = parsePrice(value, openAiModelInfoSaneDefaults.outputPrice ?? 0)
								handleModeFieldChange(
									{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
									modelInfo,
									currentMode,
								)
							}}
							style={{ flex: 1 }}>
							<AdvancedSettingLabel
								label="Output Price / 1M tokens"
								tooltip="Optional pricing metadata used for cost display only. It does not affect token limits, quality, or request size."
							/>
						</DebouncedTextField>
					</div>

					<div style={{ display: "flex", gap: 10, marginTop: "5px" }}>
						<DebouncedTextField
							initialValue={
								openAiModelInfo?.temperature
									? openAiModelInfo.temperature.toString()
									: (openAiModelInfoSaneDefaults.temperature?.toString() ?? "")
							}
							onChange={(value) => {
								const modelInfo = openAiModelInfo ? openAiModelInfo : { ...openAiModelInfoSaneDefaults }
								modelInfo.temperature = parsePrice(value, openAiModelInfoSaneDefaults.temperature ?? 0)
								handleModeFieldChange(
									{ plan: "planModeOpenAiModelInfo", act: "actModeOpenAiModelInfo" },
									modelInfo,
									currentMode,
								)
							}}>
							<AdvancedSettingLabel
								label="Temperature"
								tooltip="Controls randomness. For coding assistants, sane values are usually 0 to 0.3. Use 0 for the most deterministic behavior. Higher values may be better for brainstorming but can hurt tool reliability."
							/>
						</DebouncedTextField>
					</div>
				</>
			)}

			<p
				style={{
					fontSize: "12px",
					marginTop: 3,
					color: "var(--vscode-descriptionForeground)",
				}}>
				<span style={{ color: "var(--vscode-charts-orange)" }}>
					(<span style={{ fontWeight: 500 }}>Note:</span> This warning exists so failures can be diagnosed, not just to say a
					model is “weaker.” Tasktronaut uses long prompts, multi-step tool calls, iterative code editing, and large
					conversation history. On models that handle those poorly, the common symptoms are repeated tool-call failures,
					bad patch/edit formatting, lost task state, or OpenAI Responses context/tool-continuity errors. If you hit those,
					try a fresh task, sane output-token limits such as 8192 for GPT-5.4, lower reasoning effort when context is
					blowing up, or a model with stronger tool-use reliability.)
				</span>
			</p>

			{showModelOptions && (
				<>
					<ReasoningEffortSelector currentMode={currentMode} defaultEffort="none" />
					<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />
				</>
			)}
		</div>
	)
}
