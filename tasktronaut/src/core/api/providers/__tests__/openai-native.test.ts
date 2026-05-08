import { expect } from "chai"
import { describe, it } from "mocha"
import sinon from "sinon"
import OpenAI from "openai"
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

async function collectStream(stream: AsyncIterable<unknown>) {
	const chunks: unknown[] = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}
	return chunks
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
		expect(params.previous_response_id).to.equal("resp_prev")
		expect(params.store).to.equal(true)
		expect(params.input).to.deep.equal([{ role: "user", content: [{ type: "input_text", text: "continue" }] }])
	})

	it("retries HTTP responses with full context when previous_response_id is not found", async () => {
		const handler = new OpenAiNativeHandler({
			openAiNativeApiKey: "test-key",
			apiModelId: "gpt-5.4",
			reasoningEffort: "medium",
		}) as any

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
})
