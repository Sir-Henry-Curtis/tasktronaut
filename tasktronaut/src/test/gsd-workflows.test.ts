import { strict as assert } from "node:assert"
import { GSD_WORKFLOWS } from "../gsd-workflows-generated"
import { VSCODE_ONLY_COMMANDS } from "../shared/slashCommands"

describe("GSD workflows", () => {
	it("registers /gsd-map-project as a first-class GSD slash command", () => {
		const command = VSCODE_ONLY_COMMANDS.find((entry) => entry.name === "gsd-map-project")
		const workflow = GSD_WORKFLOWS.find((entry) => entry.name === "gsd-map-project")

		assert.ok(command, "gsd-map-project slash command should be registered")
		assert.ok(workflow, "gsd-map-project workflow should be bundled")
		assert.match(workflow.contents, /gsd-sdk query init\.map-project/)
		assert.ok(workflow.contents.includes('SlashCommand("/gsd-map-codebase")'))
		assert.match(workflow.contents, /\.planning\/project-map\/PROJECT-MAP\.md/)
	})

	it("uses Tasktronaut /newtask handoff wording instead of unsupported /clear", () => {
		const mapCodebase = GSD_WORKFLOWS.find((workflow) => workflow.name === "gsd-map-codebase")

		assert.ok(mapCodebase, "gsd-map-codebase workflow should be bundled")
		assert.doesNotMatch(mapCodebase.contents, /\/clear`?\s+then:\s+`?\/gsd-new-project/i)
		assert.match(mapCodebase.contents, /Run `\/newtask` if you want a clean context handoff/)
		assert.match(mapCodebase.contents, /In the new task, run:\s+`\/gsd-new-project`/i)
	})

	it("does not bundle upstream /clear transition guidance in GSD workflows", () => {
		const bundledText = GSD_WORKFLOWS.map((workflow) => workflow.contents).join("\n")

		assert.doesNotMatch(bundledText, /\/clear/)
	})

	it("does not leak placeholder text when existing codebase maps are present", () => {
		const mapCodebase = GSD_WORKFLOWS.find((workflow) => workflow.name === "gsd-map-codebase")

		assert.ok(mapCodebase, "gsd-map-codebase workflow should be bundled")
		assert.doesNotMatch(mapCodebase.contents, /\[List files found\]/)
		assert.match(mapCodebase.contents, /existing_map_details/)
		assert.match(mapCodebase.contents, /Never print bracketed\s+placeholder text/)
	})
})
