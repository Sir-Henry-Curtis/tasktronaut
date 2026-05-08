import { expect } from "chai"
import { getBridgeEventCommand, parseBridgeEventLine, shouldExecuteBridgeEvent } from "@/laika/bridge-contract"

describe("Laika bridge contract", () => {
	describe("parseBridgeEventLine", () => {
		it("parses valid jsonl event lines", () => {
			const parsed = parseBridgeEventLine(
				'{"event_id":"evt-1","event":"gsd_command_requested","target_actor_id":"actor-1","payload":{"command":"/gsd-execute-phase 2"}}',
			)

			expect(parsed?.event_id).to.equal("evt-1")
			expect(parsed?.event).to.equal("gsd_command_requested")
		})

		it("ignores blank or invalid lines", () => {
			expect(parseBridgeEventLine("")).to.equal(undefined)
			expect(parseBridgeEventLine("not-json")).to.equal(undefined)
		})
	})

	describe("shouldExecuteBridgeEvent", () => {
		it("accepts targeted executable events for the selected actor", () => {
			expect(
				shouldExecuteBridgeEvent(
					{
						event: "gsd_command_requested",
						target_actor_id: "actor-1",
					},
					"actor-1",
					{ active_actor_id: "actor-1" },
				),
			).to.equal(true)
		})

		it("rejects events targeted at a different actor", () => {
			expect(
				shouldExecuteBridgeEvent(
					{
						event: "verification_requested",
						target_actor_id: "actor-2",
					},
					"actor-1",
					{ active_actor_id: "actor-2" },
				),
			).to.equal(false)
		})

		it("rejects routed events when the lease belongs to someone else", () => {
			expect(
				shouldExecuteBridgeEvent(
					{
						event: "gsd_command_requested",
						target_actor_id: "actor-1",
					},
					"actor-1",
					{ active_actor_id: "actor-2" },
				),
			).to.equal(false)
		})

		it("rejects untargeted and non-executable events", () => {
			expect(
				shouldExecuteBridgeEvent(
					{
						event: "wave_complete",
						target_actor_id: null,
					},
					"actor-1",
					{ active_actor_id: "actor-1" },
				),
			).to.equal(false)
		})

		it("accepts a phase-targeted event for the assigned phase actor", () => {
			expect(
				shouldExecuteBridgeEvent(
					{
						event: "gsd_command_requested",
						target_actor_id: "actor-2",
						wave: 3,
					},
					"actor-2",
					{
						active_actor_id: "actor-1",
						phase_actor_assignments: { "3": "actor-2" },
					},
				),
			).to.equal(true)
		})

		it("accepts lifecycle events when they are targeted at the active actor", () => {
			expect(
				shouldExecuteBridgeEvent(
					{
						event: "task_pause_requested",
						target_actor_id: "actor-1",
					},
					"actor-1",
					{ active_actor_id: "actor-1" },
				),
			).to.equal(true)
		})

		it("accepts review lifecycle events when they are targeted at the active actor", () => {
			expect(
				shouldExecuteBridgeEvent(
					{
						event: "task_verified",
						target_actor_id: "actor-1",
					},
					"actor-1",
					{ active_actor_id: "actor-1" },
				),
			).to.equal(true)
		})

		it("accepts review-note events when they are targeted at the active actor", () => {
			expect(
				shouldExecuteBridgeEvent(
					{
						event: "task_add_review_note",
						target_actor_id: "actor-1",
					},
					"actor-1",
					{ active_actor_id: "actor-1" },
				),
			).to.equal(true)
		})
	})

	describe("getBridgeEventCommand", () => {
		it("returns the explicit command when present", () => {
			expect(
				getBridgeEventCommand({
					event: "gsd_command_requested",
					payload: { command: "/gsd-plan-phase 2" },
				}),
			).to.equal("/gsd-plan-phase 2")
		})

		it("derives verification command from wave when payload omits it", () => {
			expect(
				getBridgeEventCommand({
					event: "verification_requested",
					wave: 4,
					payload: {},
				}),
			).to.equal("/gsd-verify-work 4")
		})

		it("returns undefined when no executable command can be derived", () => {
			expect(
				getBridgeEventCommand({
					event: "verification_requested",
					payload: {},
				}),
			).to.equal(undefined)
		})
	})
})
