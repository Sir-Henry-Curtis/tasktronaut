import { expect } from "chai"
import { describe, it } from "mocha"
import sinon from "sinon"
import OpenAI from "openai"
import { ApiFormat } from "@/shared/proto/cline/models"
import { OpenAiNativeHandler } from "../openai-native"

const TEST_TOOLS = [
	{
		type: "function" as const,
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

const NON_GPT5_RESPONSES_MODEL = {
	id: "gpt-4.1",
	info: {
		maxTokens: 8192,
		contextWindow: 128000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 0,
		cacheReadsPrice: 0,
		apiFormat: ApiFormat.OPENAI_RESPONSES,
		temperature: 1,
		systemRole: "developer",
		supportsReasoning: true,
		supportsReasoningEffort: true,
	},
} as const

async function collectStream(stream: AsyncIterable<unknown>) {
	const chunks: unknown[] = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}
	return chunks
}

function forceNonGpt5ResponsesModel(handler: any) {
	sinon.stub(handler, "getModel").returns(NON_GPT5_RESPONSES_MODEL)
	return handler
}

function createCompletedResponseStream(responseId = "resp_test"): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
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
		} as OpenAI.Responses.ResponseCompletedEvent
	})()
}

describe("OpenAiNativeHandler", () => {
	it("uses previous_response_id for HTTP responses continuations and keeps store enabled", async () => {
		const handler = forceNonGpt5ResponsesModel(new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-4.1",
			reasoningEffort: "medium",
		}) as any)

		const createStub = sinon.stub().resolves(createCompletedResponseStream())
		handler.client = { responses: { create: createStub } }

		await collectStream(
			handler.createMessage("system", [
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					id: "resp_prev",
					ts: Date.now(),
					content: [{ type: "text", text: "hi there" }],
				},
				{ role: "user", content: "continue" },
			], TEST_TOOLS),
		)

		sinon.assert.calledOnce(createStub)
		const [params] = createStub.firstCall.args
		expect(params.previous_response_id).to.equal("resp_prev")
		expect(params.store).to.equal(true)
		expect(params.max_output_tokens).to.equal(8192)
		expect(params.input).to.deep.equal([{ role: "user", content: [{ type: "input_text", text: "continue" }] }])
	})

	it("does not use previous_response_id for GPT-5 family responses continuations", async () => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-5.4",
			reasoningEffort: "medium",
		}) as any

		const createStub = sinon.stub().resolves(createCompletedResponseStream())
		handler.client = { responses: { create: createStub } }

		await collectStream(
			handler.createMessage("system", [
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					id: "resp_prev",
					ts: Date.now(),
					content: [{ type: "text", text: "hi there" }],
				},
				{ role: "user", content: "continue" },
			], TEST_TOOLS),
		)

		sinon.assert.calledOnce(createStub)
		const [params] = createStub.firstCall.args
		expect(params.previous_response_id).to.equal(undefined)
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

	it("retries HTTP responses with full context when previous_response_id is not found", async () => {
		const handler = forceNonGpt5ResponsesModel(new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-4.1",
			reasoningEffort: "medium",
		}) as any)

		const missingPreviousResponse = Object.assign(new Error("previous_response_not_found"), {
			code: "previous_response_not_found",
		})
		const createStub = sinon
			.stub()
			.onFirstCall()
			.rejects(missingPreviousResponse)
			.onSecondCall()
			.resolves(createCompletedResponseStream("resp_fallback"))
		handler.client = { responses: { create: createStub } }

		await collectStream(
			handler.createMessage("system", [
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					id: "resp_prev",
					ts: Date.now(),
					content: [{ type: "text", text: "hi there" }],
				},
				{ role: "user", content: "continue" },
			], TEST_TOOLS),
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

	it("retries HTTP responses with full context when chained reuse hits a rate limit", async () => {
		const handler = forceNonGpt5ResponsesModel(new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-4.1",
			reasoningEffort: "medium",
		}) as any)

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
			handler.createMessage("system", [
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					id: "resp_prev",
					ts: Date.now(),
					content: [{ type: "text", text: "hi there" }],
				},
				{ role: "user", content: "continue" },
			], TEST_TOOLS),
		)

		sinon.assert.calledTwice(createStub)
		const [firstParams] = createStub.firstCall.args
		const [secondParams] = createStub.secondCall.args
		expect(firstParams.previous_response_id).to.equal("resp_prev")
		expect(secondParams.previous_response_id).to.equal(undefined)
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

	it("does not use previous_response_id when resumed history contains tool output not owned by the latest assistant response", async () => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-5.4",
			reasoningEffort: "medium",
		}) as any

		const createStub = sinon.stub().resolves(createCompletedResponseStream())
		handler.client = { responses: { create: createStub } }

		await collectStream(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "start" },
					{
						role: "assistant",
						id: "resp_prev",
						ts: Date.now(),
						content: [{ type: "text", text: "Please run the build." }],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "fc_build_123",
								call_id: "call_build_123",
								content: "Build succeeded",
							},
						],
					},
					{ role: "user", content: "pick up where you left off" },
				],
				TEST_TOOLS,
			),
		)

		sinon.assert.calledOnce(createStub)
		const [params] = createStub.firstCall.args
		expect(params.previous_response_id).to.equal(undefined)
		expect(params.input).to.deep.equal([
			{ role: "user", content: [{ type: "input_text", text: "start" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Please run the build." }],
			},
			{
				type: "function_call_output",
				call_id: "call_build_123",
				output: "Build succeeded",
			},
			{ role: "user", content: [{ type: "input_text", text: "pick up where you left off" }] },
		])
	})

	it("keeps previous_response_id when resumed history contains tool output owned by the latest assistant response", async () => {
		const handler = forceNonGpt5ResponsesModel(new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-4.1",
			reasoningEffort: "medium",
		}) as any)

		const createStub = sinon.stub().resolves(createCompletedResponseStream())
		handler.client = { responses: { create: createStub } }

		await collectStream(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "start" },
					{
						role: "assistant",
						id: "resp_prev",
						ts: Date.now(),
						content: [
							{
								type: "tool_use",
								id: "fc_build_123",
								call_id: "call_build_123",
								name: "execute_command",
								input: { command: "cargo build" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "fc_build_123",
								call_id: "call_build_123",
								content: "Build succeeded",
							},
						],
					},
					{ role: "user", content: "pick up where you left off" },
				],
				TEST_TOOLS,
			),
		)

		sinon.assert.calledOnce(createStub)
		const [params] = createStub.firstCall.args
		expect(params.previous_response_id).to.equal("resp_prev")
		expect(params.input).to.deep.equal([
			{
				type: "function_call_output",
				call_id: "call_build_123",
				output: "Build succeeded",
			},
			{ role: "user", content: [{ type: "input_text", text: "pick up where you left off" }] },
		])
	})

	it("trims oversized chained responses input for TPM safety while keeping previous_response_id", async () => {
		const handler = forceNonGpt5ResponsesModel(new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-4.1",
			reasoningEffort: "none",
		}) as any)

		const createStub = sinon.stub().resolves(createCompletedResponseStream())
		handler.client = { responses: { create: createStub } }

		const oversizedToolOutputs = Array.from({ length: 18 }, (_, index) => ({
			role: "user" as const,
			content: [
				{
					type: "tool_result" as const,
					tool_use_id: `fc_build_${index}`,
					call_id: `call_build_${index}`,
					content: `tool-result-${index}-` + "z".repeat(35_000),
				},
			],
		}))

		await collectStream(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "start" },
					{
						role: "assistant",
						id: "resp_prev",
						ts: Date.now(),
						content: oversizedToolOutputs.map((_, index) => ({
							type: "tool_use" as const,
							id: `fc_build_${index}`,
							call_id: `call_build_${index}`,
							name: "execute_command",
							input: { command: `cmd-${index}` },
						})),
					},
					...oversizedToolOutputs,
					{ role: "user", content: "continue from the latest results" },
				],
				TEST_TOOLS,
			),
		)

		sinon.assert.calledOnce(createStub)
		const [params] = createStub.firstCall.args
		expect(params.previous_response_id).to.equal("resp_prev")
		const serializedInput = JSON.stringify(params.input)
		expect(serializedInput.length).to.be.lessThan(180_000)
		expect(serializedInput).to.not.include("tool-result-0-")
		expect(serializedInput).to.include("continue from the latest results")
	})

	it("trims oversized full-context responses input for TPM safety when no previous_response_id is available", async () => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-5.4",
			reasoningEffort: "medium",
		}) as any

		const createStub = sinon.stub().resolves(createCompletedResponseStream())
		handler.client = { responses: { create: createStub } }

		const messages = Array.from({ length: 24 }, (_, index) => ({
			role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
			content:
				index % 2 === 0
					? `user-${index} ` + "x".repeat(25_000)
					: [{ type: "text" as const, text: `assistant-${index} ` + "y".repeat(25_000) }],
		}))

		await collectStream(handler.createMessage("system", messages, TEST_TOOLS))

		sinon.assert.calledOnce(createStub)
		const [params] = createStub.firstCall.args
		const serializedInput = JSON.stringify(params.input)
		expect(serializedInput.length).to.be.lessThan(180_000)
		expect(serializedInput).to.not.include("user-0")
		expect(serializedInput).to.include("user-22")
		expect(params.previous_response_id).to.equal(undefined)
	})

	it("truncates a single oversized responses input item when item-dropping alone cannot reach the TPM budget", async () => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-5.4",
			reasoningEffort: "none",
		}) as any

		const createStub = sinon.stub().resolves(createCompletedResponseStream())
		handler.client = { responses: { create: createStub } }

		await collectStream(
			handler.createMessage(
				"system",
				[
					{
						role: "user",
						content: "latest-request " + "x".repeat(400_000),
					},
				],
				TEST_TOOLS,
			),
		)

		sinon.assert.calledOnce(createStub)
		const [params] = createStub.firstCall.args
		const serializedInput = JSON.stringify(params.input)
		expect(serializedInput.length).to.be.lessThan(10_000)
		expect(serializedInput).to.include("[truncated for TPM safety]")
		expect(params.previous_response_id).to.equal(undefined)
	})

	it("drops orphaned function_call_output items from bounded full-context responses input", async () => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-5.4",
			reasoningEffort: "none",
		}) as any

		const createStub = sinon.stub().resolves(createCompletedResponseStream())
		handler.client = { responses: { create: createStub } }

		const messages = [
			{
				role: "assistant" as const,
				content: [
					{
						type: "tool_use" as const,
						id: "fc_old_call",
						call_id: "call_old",
						name: "execute_command",
						input: { command: "old" },
					},
				],
			},
			{
				role: "user" as const,
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: "fc_old_call",
						call_id: "call_old",
						content: "old-result-" + "x".repeat(220_000),
					},
				],
			},
			{
				role: "user" as const,
				content: "latest user request",
			},
		]

		await collectStream(handler.createMessage("system", messages, TEST_TOOLS))

		sinon.assert.calledOnce(createStub)
		const [params] = createStub.firstCall.args
		const serializedInput = JSON.stringify(params.input)
		expect(params.previous_response_id).to.equal(undefined)
		expect(serializedInput).to.not.include("call_old")
		expect(serializedInput).to.include("latest user request")
	})

	it("drops orphaned GPT-5 reasoning/function_call pairs when trimming would otherwise leave a bare function_call", async () => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-5.4",
			reasoningEffort: "medium",
		}) as any

		const createStub = sinon.stub().resolves(createCompletedResponseStream())
		handler.client = { responses: { create: createStub } }

		const fillerMessages = Array.from({ length: 8 }, (_, index) => ({
			role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
			content:
				index % 2 === 0
					? `filler-user-${index} ` + "x".repeat(18_000)
					: [{ type: "text" as const, text: `filler-assistant-${index} ` + "y".repeat(18_000) }],
		}))

		const messages = [
			{
				role: "assistant" as const,
				content: [
					{
						type: "thinking" as const,
						thinking: "Need to call a tool",
						call_id: "rs_old",
						summary: [{ type: "summary_text", text: "Need to call a tool" }],
					},
					{
						type: "tool_use" as const,
						id: "fc_old_call",
						call_id: "call_old",
						name: "execute_command",
						input: { command: "old" },
					},
				],
			},
			{
				role: "user" as const,
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: "fc_old_call",
						call_id: "call_old",
						content: "old-result-" + "x".repeat(220_000),
					},
				],
			},
			{
				role: "user" as const,
				content: "latest user request",
			},
			...fillerMessages,
		]

		await collectStream(handler.createMessage("system", messages, TEST_TOOLS))

		sinon.assert.calledOnce(createStub)
		const [params] = createStub.firstCall.args
		const serializedInput = JSON.stringify(params.input)
		expect(params.previous_response_id).to.equal(undefined)
		expect(serializedInput).to.not.include("rs_old")
		expect(serializedInput).to.not.include("fc_old_call")
		expect(serializedInput).to.not.include("call_old")
		expect(serializedInput).to.include("latest user request")
	})

	it("surfaces debug context on HTTP responses failures that are not eligible for fallback", async () => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-5.4",
			reasoningEffort: "medium",
		}) as any

		const failure = Object.assign(new Error("No tool call found for function call output"), {
			status: 400,
		})
		const createStub = sinon.stub().rejects(failure)
		handler.client = { responses: { create: createStub } }

		let thrown: Error | undefined
		try {
			await collectStream(handler.createMessage("system", [{ role: "user", content: "continue" }], TEST_TOOLS))
		} catch (error) {
			thrown = error as Error
		}

		expect(thrown).to.be.instanceOf(Error)
		expect(thrown?.message).to.include("No tool call found for function call output")
		expect(thrown?.message).to.include("[Tasktronaut Responses debug]")
		expect(thrown?.message).to.include("model=gpt-5.4")
		expect(thrown?.message).to.include("previous_response_id=false")
		expect(thrown?.message).to.include("reasoning_effort=medium")
	})

	it("does not duplicate responses debug context when an error is wrapped twice", () => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-5.4",
			reasoningEffort: "medium",
		}) as any

		const info = {
			modelId: "gpt-5.4",
			transport: "http" as const,
			hasPreviousResponseId: false,
			estimatedInputTokens: 123,
			serializedInputChars: 456,
			inputItemCount: 2,
			largestItemChars: 300,
			maxOutputTokens: 8192,
			reasoningEffort: "medium",
		}

		const first = handler.attachResponsesDebugContext(new Error("boom"), info)
		const second = handler.attachResponsesDebugContext(first, info)

		expect((second.message.match(/\[Tasktronaut Responses debug\]/g) || []).length).to.equal(1)
	})

	it("classifies textual TPM rate limit failures as rate_limit_exceeded", () => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-5.4",
			reasoningEffort: "medium",
		}) as any

		expect(handler.getResponseApiErrorCode(new Error("Rate limit reached for gpt-5.4 on tokens per min (TPM)"))).to.equal(
			"rate_limit_exceeded",
		)
		expect(handler.getResponseApiErrorCode({ message: "rate_limit_exceeded", status: 400 })).to.equal(
			"rate_limit_exceeded",
		)
		expect(handler.getResponseApiErrorCode({ status: 429 })).to.equal("rate_limit_exceeded")
	})
})
