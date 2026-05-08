import { createGrpcClient } from "@hosts/vscode/hostbridge/client/host-grpc-client-base"
import { DiffServiceDefinition } from "../../../../shared/proto/host/diff"
import { EnvServiceDefinition } from "../../../../shared/proto/host/env"
import { WindowServiceDefinition } from "../../../../shared/proto/host/window"
import { WorkspaceServiceDefinition } from "../../../../shared/proto/host/workspace"
import { HostBridgeClientProvider } from "@/hosts/host-provider-types"

export const vscodeHostBridgeClient: HostBridgeClientProvider = {
	workspaceClient: createGrpcClient(WorkspaceServiceDefinition),
	envClient: createGrpcClient(EnvServiceDefinition),
	windowClient: createGrpcClient(WindowServiceDefinition),
	diffClient: createGrpcClient(DiffServiceDefinition),
}
