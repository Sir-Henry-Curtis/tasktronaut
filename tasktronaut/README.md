# Tasktronaut

Tasktronaut is a VS Code extension project that combines a hardened agentic coding runtime with structured execution workflows for controlled engineering environments.

It is intended for internal NASA-oriented use cases where the machine, network, and model endpoint are already approved, and the extension must operate inside that boundary without introducing unnecessary egress or product surface.

> Tasktronaut is a project codename for an internal tool. It is not an official NASA product or endorsement.

## Overview

Tasktronaut is designed around three core ideas:

- agentic coding inside VS Code
- structured planning and execution
- controlled setup and deployment

The extension provides file editing, terminal execution, controlled external URL fetching, and human approval gates while aligning the product surface with a more internal, mission-ready workflow model.

## Architecture

The current direction is a lightweight hybrid model:

- a hardened extension runtime
- a bundled workflow layer
- a thin bridge that preserves planning state and execution context across long-running tasks

The canonical architecture note for this fork lives in the repository root at `docs/architecture.md`. KISS mode design notes live beside it in `docs/kiss-mode-design.md`.

## Product Direction

- Rebrand the extension surface around Tasktronaut
- Remove upstream-specific setup, account, and documentation references from the user-facing flow
- Replace default branding assets with Tasktronaut visuals
- Keep the extension usable in controlled internal deployments

## Visual Identity

The current brand exploration covers the sidebar icon, app icon, wordmark, sticker, and mascot direction for the extension. Those assets remain in-repo for product use, but the extension details page is intentionally text-only for offline-safe packaging and consistent rendering in controlled VS Code deployments.

## Notes

This fork builds on upstream open-source work and should continue to preserve license notices and document any behavior changes introduced by the Tasktronaut-specific surface.

## Attribution

Tasktronaut is a derivative work based on Cline by Cline Bot Inc. (github.com/cline/cline), licensed under the Apache License 2.0. The original copyright notice is preserved in the `LICENSE` file.

Tasktronaut also includes and adapts workflow, agent, hook, and SDK-shim concepts from GSD / Get Shit Done (`get-shit-done-cc` and `@gsd-build/sdk`) by Lex Christopherson and contributors (github.com/gsd-build/get-shit-done), licensed under the MIT License.

Modifications from upstream work are documented in `CHANGELOG.md`. Fork-level architecture and operating-mode decisions are documented in the root `docs/` directory.

See `THIRD_PARTY_NOTICES.md` for source, copyright, and license details for bundled/adapted upstream work.
