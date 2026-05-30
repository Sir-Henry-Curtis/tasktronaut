# Tasktronaut Architecture

Tasktronaut combines a hardened VS Code extension runtime with the Get Shit Done workflow system. It is designed for controlled engineering environments where the machine, network path, and model endpoint are already approved.

> Tasktronaut is a project codename for an internal tool. It is not an official NASA product or endorsement.

## System Model

![GSD v1.5 architecture](../assets/gsd-v1-5-architecture.svg)

Tasktronaut follows a lightweight hybrid model:

```text
VS Code UI -> hardened extension runtime -> bundled GSD workflow layer -> approved model endpoint
```

The extension remains the user-facing runtime. GSD provides the workflow discipline. A small bridge layer makes the workflow durable inside long-running agent sessions.

## Runtime Layers

### Hardened Extension Runtime

The extension runtime owns chat state, model calls, file editing, terminal execution, URL retrieval, approval gates, local storage, and the VS Code integration surface.

Tasktronaut intentionally narrows the upstream surface:

- no hosted account flow is required for the baseline internal deployment
- telemetry and hosted product reporting are disabled or bypassed
- third-party model discovery is disabled in favor of configured endpoints
- browser automation and web search are not part of the baseline profile
- external context enters through controlled URL fetch or explicitly approved MCP tools

### Bundled GSD Workflow Layer

The GSD layer supplies project planning, phase transitions, verification discipline, and reusable agent/workflow instructions. Tasktronaut bundles the managed GSD assets with the extension so a deployed build does not need to fetch workflow scaffolding at runtime.

Installed workspace rules use Tasktronaut-specific naming and tool mappings. GSD workflow instructions that assume other agent runtimes are adapted before they reach the model.

### Bridge Layer

The bridge layer is intentionally thin. It focuses on:

1. Preserving planning state across context compaction and long tasks
2. Injecting active planning artifacts when a workflow phase is triggered
3. Detecting repeated low-value loops
4. Supporting reliable phase progression
5. Keeping managed GSD assets local by default

This bridge avoids replacing the extension runtime. It adds workflow durability where prompt-only orchestration is too brittle.

## Operating Modes

Tasktronaut currently exposes three task modes:

- **Plan** - discuss strategy and inspect context before making changes
- **Act** - execute the agreed task with tools and approval gates
- **KISS** - use a minimal conversational prompt for lightweight local models

KISS mode is not a smaller Act mode. It is a separate conversation mode for models that degrade when given the full agent prompt. See [KISS Mode Design](./kiss-mode-design.md).

## Deployment Boundary

The steady-state deployment model is narrow:

```text
developer machine -> Tasktronaut -> approved API key -> approved endpoint
```

The default assumption is that approvals, endpoint access, and model availability are managed by the deployment environment rather than by public hosted services.

## Repository Boundaries

- **Root** - integration docs, shared assets, and project-level maintenance notes
- **Tasktronaut package** - extension runtime, CLI, webview, provider handling, GSD bridge, docs site, and package metadata
- **Get Shit Done package** - upstream workflow assets and generator inputs adapted into Tasktronaut
- **Tools** - support utilities that are not part of the shipped extension surface

Prototype work is kept outside the shareable repository history. Architecture decisions that survive prototyping should be captured in root docs before they become product assumptions.

## Documentation Ownership

Root docs are canonical for fork-level architecture and decisions. Package docs are user-facing and may still contain upstream language if a page has not been adapted yet. When product behavior changes, update both the user-facing page and the corresponding root architecture note if the change affects the deployment model.
