import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ExtensionStateContextProvider, useExtensionState } from "@/context/ExtensionStateContext"
import ApiOptions from "../ApiOptions"

vi.mock("../../../context/ExtensionStateContext", async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...(actual || {}),
		useExtensionState: vi.fn(),
	}
})

const mockExtensionState = (overrides: Record<string, unknown> = {}) => {
	vi.mocked(useExtensionState).mockReturnValue({
		apiConfiguration: {
			planModeApiProvider: "openai",
			actModeApiProvider: "openai",
			openAiBaseUrl: "https://example.com/v1",
			openAiApiKey: "test-api-key",
			planModeOpenAiModelId: "gpt-5.4",
			actModeOpenAiModelId: "gpt-5.4",
		},
		setApiConfiguration: vi.fn(),
		planActSeparateModelsSetting: false,
		remoteConfigSettings: {},
		...overrides,
	} as any)
}

describe("ApiOptions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		//@ts-expect-error test global
		global.vscode = { postMessage: vi.fn() }
		mockExtensionState()
	})

	it("renders the OpenAI-compatible endpoint fields", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiOptions currentMode="plan" showModelOptions={true} />
			</ExtensionStateContextProvider>,
		)

		expect(screen.getByPlaceholderText("Enter base URL...")).toBeInTheDocument()
		expect(screen.getByPlaceholderText("Enter API Key...")).toBeInTheDocument()
	})

	it("renders the supported provider guidance and controls", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiOptions currentMode="plan" showModelOptions={true} />
			</ExtensionStateContextProvider>,
		)

		expect(screen.getByText("Model Configuration")).toBeInTheDocument()
		expect(screen.getByText("Reasoning Effort")).toBeInTheDocument()
		expect(screen.getByText(/Tasktronaut relies on long prompts/i)).toBeInTheDocument()
	})
})
