import { rm } from "fs/promises"
import { mkdir, writeFile } from "fs/promises"
import path from "path"

const workspacePath = path.resolve("test-workspace")
const seedStaleManagedAssets = process.argv.includes("--seed-stale-managed-assets")
const staleManagedAsset = "// stale managed asset seeded before extension startup\n"
const staleResearchAgent = `---
name: "gsd-project-researcher"
description: "stale seeded agent"
tools:
  - read_file
  - web_search
  - web_fetch
---
### 3. WebSearch — Ecosystem Discovery
gsd-sdk query websearch "your query" --limit 10
If \`brave_search: false\` (or not set), use built-in WebSearch tool instead.
`

await rm(path.join(workspacePath, ".tasktronaut"), { recursive: true, force: true })
await rm(path.join(workspacePath, ".tasktronautrules"), { recursive: true, force: true })

if (seedStaleManagedAssets) {
	await mkdir(path.join(workspacePath, ".tasktronaut", "bin"), { recursive: true })
	await mkdir(path.join(workspacePath, ".tasktronaut", "agents"), { recursive: true })
	await mkdir(path.join(workspacePath, ".tasktronautrules", "hooks"), { recursive: true })
	await writeFile(path.join(workspacePath, ".tasktronaut", "bin", "gsd-sdk.js"), staleManagedAsset, "utf8")
	await writeFile(path.join(workspacePath, ".tasktronaut", "agents", "gsd-project-researcher.md"), staleResearchAgent, "utf8")
	await writeFile(
		path.join(workspacePath, ".tasktronaut", "managed-manifest.json"),
		JSON.stringify({ version: 0, seeded: "stale-managed-assets" }, null, 2) + "\n",
		"utf8",
	)
	await writeFile(path.join(workspacePath, ".tasktronautrules", "hooks", "gsd-sdk"), staleManagedAsset, "utf8")
}
