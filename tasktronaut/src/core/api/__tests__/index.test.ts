import { expect } from "chai"
import { describe, it } from "mocha"
import { openAiModelInfoSaneDefaults } from "../../../shared/api"
import { ApiFormat } from "../../../shared/proto/cline/models"
import { buildApiHandler } from "../index"
import { OpenAiHandler } from "../providers/openai"
import { OpenAiNativeHandler } from "../providers/openai-native"

describe("buildApiHandler", () => {
	it("routes OpenAI responses-format models to OpenAiNativeHandler", () => {
		const handler = buildApiHandler(
			{
				actModeApiProvider: "openai",
				openAiApiKey: "test-key",
				actModeOpenAiModelId: "gpt-5.4",
				actModeOpenAiModelInfo: {
					...openAiModelInfoSaneDefaults,
					apiFormat: ApiFormat.OPENAI_RESPONSES,
					supportsReasoning: true,
					supportsReasoningEffort: true,
				},
			},
			"act",
		)

		expect(handler).to.be.instanceOf(OpenAiNativeHandler)
		expect(handler.getModel().id).to.equal("gpt-5.4")
	})

	it("keeps chat-completions OpenAI models on OpenAiHandler", () => {
		const handler = buildApiHandler(
			{
				actModeApiProvider: "openai",
				openAiApiKey: "test-key",
				actModeOpenAiModelId: "gpt-4",
				actModeOpenAiModelInfo: {
					...openAiModelInfoSaneDefaults,
					apiFormat: ApiFormat.OPENAI_CHAT,
				},
			},
			"act",
		)

		expect(handler).to.be.instanceOf(OpenAiHandler)
	})

	it("routes OpenAI native model ids to OpenAiNativeHandler even when model info is missing", () => {
		const handler = buildApiHandler(
			{
				actModeApiProvider: "openai",
				openAiApiKey: "test-key",
				actModeOpenAiModelId: "gpt-5.4",
			},
			"act",
		)

		expect(handler).to.be.instanceOf(OpenAiNativeHandler)
		expect(handler.getModel().id).to.equal("gpt-5.4")
	})
})
