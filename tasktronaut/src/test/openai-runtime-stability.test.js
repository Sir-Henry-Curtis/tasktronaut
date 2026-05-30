const { expect } = require("chai")
const { describe, it } = require("mocha")
const sinon = require("sinon")
const OpenAI = require("openai")

const { buildApiHandler } = require("@/core/api")
const { OpenAiNativeHandler } = require("@/core/api/providers/openai-native")
const { openAiModelInfoSaneDefaults } = require("@/shared/api")
const { ApiFormat } = require("@/shared/proto/cline/models")

const TEST_TOOLS = [
	{
		type: "function",
		function: {
			name: "test_tool",
			description: "Test tool",
			parameters: {
				type: "object",
				properties: {},
			},
		},
	},
]

function createCompletedResponseStream(responseId = "resp_test") {
	return (async function* () {
		yield {
			type: "response.completed",
			response: {
				id: responseId,
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			},
		}
	})()
}

async function collectStream(stream) {
	const chunks = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}
	return chunks
}

describe("OpenAI runtime stability", () => {
	it("routes GPT-5 OpenAI settings through the native Responses handler and avoids previous_response_id in the VS Code runtime", async () => {
		const handler = buildApiHandler(
			{
				actModeApiProvider: "openai",
				openAiApiKey: "test-key",
				actModeOpenAiModelId: "gpt-5.4",
			},
			"act",
		)

		expect(handler).to.be.instanceOf(OpenAiNativeHandler)

		const createStub = sinon.stub().resolves(createCompletedResponseStream())
		handler.client = { responses: { create: createStub } }

		await collectStream(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "hello" },
					{
						role: "assistant",
						id: "resp_prev",
						ts: Date.now(),
						content: [{ type: "text", text: "hi there" }],
					},
					{ role: "user", content: "continue" },
				],
				TEST_TOOLS,
			),
		)

		sinon.assert.calledOnce(createStub)
		const [params] = createStub.firstCall.args
		expect(params.previous_response_id).to.equal(undefined)
		expect(params.max_output_tokens).to.equal(8192)
		expect(params.input).to.deep.equal([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "hi there" }],
			},
			{ role: "user", content: [{ type: "input_text", text: "continue" }] },
		])
	})

	it("retries runtime Responses requests with bounded full context after chained reuse hits a rate limit", async () => {
		const handler = buildApiHandler(
			{
				actModeApiProvider: "openai",
				openAiApiKey: "test-key",
				actModeOpenAiModelId: "gpt-4.1",
				actModeOpenAiModelInfo: {
					...openAiModelInfoSaneDefaults,
					apiFormat: ApiFormat.OPENAI_RESPONSES,
					supportsReasoning: true,
					supportsReasoningEffort: true,
				},
				actModeReasoningEffort: "medium",
			},
			"act",
		)

		expect(handler).to.be.instanceOf(OpenAiNativeHandler)

		const rateLimitError = Object.assign(
			new Error("Rate limit reached for gpt-4.1 on tokens per min (TPM)"),
			{ status: 429 },
		)
		const createStub = sinon
			.stub()
			.onFirstCall()
			.rejects(rateLimitError)
			.onSecondCall()
			.resolves(createCompletedResponseStream("resp_fallback"))
		handler.client = { responses: { create: createStub } }

		await collectStream(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "hello" },
					{
						role: "assistant",
						id: "resp_prev",
						ts: Date.now(),
						content: [{ type: "text", text: "hi there" }],
					},
					{ role: "user", content: "continue" },
				],
				TEST_TOOLS,
			),
		)

		sinon.assert.calledTwice(createStub)
		const [firstParams] = createStub.firstCall.args
		const [secondParams] = createStub.secondCall.args
		expect(firstParams.previous_response_id).to.equal("resp_prev")
		expect(secondParams.previous_response_id).to.equal(undefined)
		expect(secondParams.store).to.equal(true)
		expect(secondParams.input).to.deep.equal([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "hi there" }],
			},
			{ role: "user", content: [{ type: "input_text", text: "continue" }] },
		])
	})

	it("keeps runtime GPT-5 fallback payloads valid by dropping orphaned tool-output fragments during trimming", async () => {
		const handler = buildApiHandler(
			{
				actModeApiProvider: "openai",
				openAiApiKey: "test-key",
				actModeOpenAiModelId: "gpt-5.4",
				actModeReasoningEffort: "none",
			},
			"act",
		)

		expect(handler).to.be.instanceOf(OpenAiNativeHandler)

		const createStub = sinon.stub().resolves(createCompletedResponseStream())
		handler.client = { responses: { create: createStub } }

		await collectStream(
			handler.createMessage(
				"system",
				[
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "fc_old_call",
								call_id: "call_old",
								name: "execute_command",
								input: { command: "old" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "fc_old_call",
								call_id: "call_old",
								content: "old-result-" + "x".repeat(220_000),
							},
						],
					},
					{
						role: "user",
						content: "latest user request",
					},
				],
				TEST_TOOLS,
			),
		)

		sinon.assert.calledOnce(createStub)
		const [params] = createStub.firstCall.args
		const serializedInput = JSON.stringify(params.input)
		expect(params.previous_response_id).to.equal(undefined)
		expect(serializedInput).to.not.include("call_old")
		expect(serializedInput).to.include("latest user request")
	})

	it("surfaces Responses debug context in the VS Code runtime when OpenAI returns an invalid request error", async () => {
		const handler = buildApiHandler(
			{
				actModeApiProvider: "openai",
				openAiApiKey: "test-key",
				actModeOpenAiModelId: "gpt-5.4",
				actModeReasoningEffort: "medium",
			},
			"act",
		)

		expect(handler).to.be.instanceOf(OpenAiNativeHandler)

		const failure = Object.assign(new Error("No tool call found for function call output"), {
			status: 400,
		})
		const createStub = sinon.stub().rejects(failure)
		handler.client = { responses: { create: createStub } }

		let thrown
		try {
			await collectStream(handler.createMessage("system", [{ role: "user", content: "continue" }], TEST_TOOLS))
		} catch (error) {
			thrown = error
		}

		expect(thrown).to.be.instanceOf(Error)
		expect(thrown.message).to.include("No tool call found for function call output")
		expect(thrown.message).to.include("[Tasktronaut Responses debug]")
		expect(thrown.message).to.include("model=gpt-5.4")
		expect(thrown.message).to.include("previous_response_id=false")
		expect(thrown.message).to.include("reasoning_effort=medium")
	})

	it("stays stable across a longer GPT-5 runtime session with repeated bounded requests", async () => {
		const handler = buildApiHandler(
			{
				actModeApiProvider: "openai",
				openAiApiKey: "test-key",
				actModeOpenAiModelId: "gpt-5.4",
				actModeReasoningEffort: "medium",
			},
			"act",
		)

		expect(handler).to.be.instanceOf(OpenAiNativeHandler)

		const createStub = sinon.stub()
		createStub.onCall(0).resolves(createCompletedResponseStream("resp_1"))
		createStub.onCall(1).resolves(createCompletedResponseStream("resp_2"))
		createStub.onCall(2).resolves(createCompletedResponseStream("resp_3"))
		handler.client = { responses: { create: createStub } }

		const turn1Messages = [
			{ role: "user", content: "phase-1 " + "x".repeat(120_000) },
			{
				role: "assistant",
				id: "resp_1",
				ts: Date.now(),
				content: [{ type: "text", text: "phase-1-complete " + "y".repeat(40_000) }],
			},
			{ role: "user", content: "phase-2 continue " + "z".repeat(60_000) },
		]

		const turn2Messages = [
			...turn1Messages,
			{
				role: "assistant",
				id: "resp_2",
				ts: Date.now(),
				content: [
					{
						type: "tool_use",
						id: "fc_old_call",
						call_id: "call_old",
						name: "execute_command",
						input: { command: "cargo test" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "fc_old_call",
						call_id: "call_old",
						content: "tool-output-" + "q".repeat(140_000),
					},
				],
			},
			{ role: "user", content: "phase-3 continue " + "w".repeat(45_000) },
		]

		const turn3Messages = [
			...turn2Messages,
			{
				role: "assistant",
				id: "resp_3",
				ts: Date.now(),
				content: [{ type: "text", text: "phase-3-complete " + "v".repeat(30_000) }],
			},
			{ role: "user", content: "final continue " + "n".repeat(35_000) },
		]

		await collectStream(handler.createMessage("system", turn1Messages, TEST_TOOLS))
		await collectStream(handler.createMessage("system", turn2Messages, TEST_TOOLS))
		await collectStream(handler.createMessage("system", turn3Messages, TEST_TOOLS))

		sinon.assert.calledThrice(createStub)

		for (const call of createStub.getCalls()) {
			const [params] = call.args
			const serializedInput = JSON.stringify(params.input)
			expect(params.previous_response_id).to.equal(undefined)
			expect(serializedInput.length).to.be.lessThan(180_000)
		}

		const [finalParams] = createStub.thirdCall.args
		const finalInput = JSON.stringify(finalParams.input)
		expect(finalInput).to.include("final continue")
		expect(finalInput).to.not.include("tool-output-qqqq")
	})

	it("recovers in runtime from repeated continuation failures without losing the latest user request", async () => {
		const handler = buildApiHandler(
			{
				actModeApiProvider: "openai",
				openAiApiKey: "test-key",
				actModeOpenAiModelId: "gpt-4.1",
				actModeOpenAiModelInfo: {
					...openAiModelInfoSaneDefaults,
					apiFormat: ApiFormat.OPENAI_RESPONSES,
					supportsReasoning: true,
					supportsReasoningEffort: true,
				},
				actModeReasoningEffort: "medium",
			},
			"act",
		)

		expect(handler).to.be.instanceOf(OpenAiNativeHandler)

		const previousMissingError = Object.assign(new Error("previous_response_not_found"), {
			code: "previous_response_not_found",
		})
		const rateLimitError = Object.assign(new Error("Rate limit reached for gpt-4.1 on tokens per min (TPM)"), {
			status: 429,
		})
		const createStub = sinon.stub()
		createStub.onCall(0).rejects(previousMissingError)
		createStub.onCall(1).resolves(createCompletedResponseStream("resp_fallback_1"))
		createStub.onCall(2).rejects(rateLimitError)
		createStub.onCall(3).resolves(createCompletedResponseStream("resp_fallback_2"))
		handler.client = { responses: { create: createStub } }

		const resumedMessages = [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				id: "resp_prev",
				ts: Date.now(),
				content: [{ type: "text", text: "hi there" }],
			},
			{ role: "user", content: "continue after resume" },
		]

		await collectStream(handler.createMessage("system", resumedMessages, TEST_TOOLS))
		await collectStream(handler.createMessage("system", resumedMessages, TEST_TOOLS))

		sinon.assert.callCount(createStub, 4)

		const [firstPrimary] = createStub.getCall(0).args
		const [firstFallback] = createStub.getCall(1).args
		const [secondPrimary] = createStub.getCall(2).args
		const [secondFallback] = createStub.getCall(3).args

		expect(firstPrimary.previous_response_id).to.equal("resp_prev")
		expect(secondPrimary.previous_response_id).to.equal("resp_prev")
		expect(firstFallback.previous_response_id).to.equal(undefined)
		expect(secondFallback.previous_response_id).to.equal(undefined)
		expect(JSON.stringify(firstFallback.input)).to.include("continue after resume")
		expect(JSON.stringify(secondFallback.input)).to.include("continue after resume")
	})
})
