import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { StreamResponseHandler } from "../StreamResponseHandler"

describe("StreamResponseHandler", () => {
	it("waits for a confirmed OpenAI Responses call_id before exposing tool blocks", () => {
		const handler = new StreamResponseHandler()
		const { toolUseHandler } = handler.getHandlers()

		toolUseHandler.processToolUseDelta(
			{
				id: "fc_test_call",
				type: "tool_use",
				name: "read_file",
				input: '{"path":"src/',
			},
			undefined,
		)

		assert.deepEqual(toolUseHandler.getPartialToolUsesAsContent(), [])

		toolUseHandler.processToolUseDelta(
			{
				id: "fc_test_call",
				type: "tool_use",
				input: 'index.ts"}',
			},
			"call_confirmed_123",
		)

		assert.deepEqual(toolUseHandler.getPartialToolUsesAsContent(), [
			{
				type: "tool_use",
				name: "read_file",
				params: {
					path: "src/index.ts",
				},
				partial: true,
				isNativeToolCall: true,
				call_id: "call_confirmed_123",
			},
		])
	})

	it("still exposes non-Responses tool blocks without a confirmed call_id", () => {
		const handler = new StreamResponseHandler()
		const { toolUseHandler } = handler.getHandlers()

		toolUseHandler.processToolUseDelta(
			{
				id: "toolu_legacy",
				type: "tool_use",
				name: "read_file",
				input: '{"path":"src/index.ts"}',
			},
			undefined,
		)

		assert.deepEqual(toolUseHandler.getPartialToolUsesAsContent(), [
			{
				type: "tool_use",
				name: "read_file",
				params: {
					path: "src/index.ts",
				},
				partial: true,
				isNativeToolCall: true,
				call_id: "toolu_legacy",
			},
		])
	})

	it("waits for complete JSON before exposing OpenAI Responses tool blocks", () => {
		const handler = new StreamResponseHandler()
		const { toolUseHandler } = handler.getHandlers()

		toolUseHandler.processToolUseDelta(
			{
				id: "fc_test_call_incomplete_json",
				type: "tool_use",
				name: "read_file",
				input: '{"path":"src/index',
			},
			"call_confirmed_456",
		)

		assert.deepEqual(toolUseHandler.getPartialToolUsesAsContent(), [])

		toolUseHandler.processToolUseDelta(
			{
				id: "fc_test_call_incomplete_json",
				type: "tool_use",
				input: '.ts"}',
			},
			undefined,
		)

		assert.deepEqual(toolUseHandler.getPartialToolUsesAsContent(), [
			{
				type: "tool_use",
				name: "read_file",
				params: {
					path: "src/index.ts",
				},
				partial: true,
				isNativeToolCall: true,
				call_id: "call_confirmed_456",
			},
		])
	})
})
