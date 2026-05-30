export interface BridgeEventRecord {
	event_id?: string
	event?: string
	workspace_root?: string
	wave?: number
	card_id?: string
	target_actor_id?: string | null
	source?: string
	timestamp_unix_ms?: number
	payload?: Record<string, unknown> | null
}

export interface ActorLeaseRecord {
	active_actor_id?: string | null
	phase_actor_assignments?: Record<string, string>
	updated_at_unix_ms?: number
	source?: string
}

const EXECUTABLE_EVENTS = new Set([
	"gsd_command_requested",
	"verification_requested",
	"task_start_requested",
	"task_resume_requested",
	"task_status_requested",
	"task_pause_requested",
	"task_abort_requested",
	"task_ready_for_review",
	"task_verified",
	"task_request_changes",
	"task_add_review_note",
	"task_add_review_comment",
	"task_restore_checkpoint",
	"task_request_commit",
	"task_request_sync",
	"task_request_ship_check",
	"task_request_pr",
	"focus_actor_requested",
	"open_path_requested",
	"tasktronaut_ui_requested",
	"tasktronaut_auto_approval_updated",
])

export function parseBridgeEventLine(line: string): BridgeEventRecord | undefined {
	const trimmed = line.trim()
	if (!trimmed) {
		return undefined
	}

	try {
		return JSON.parse(trimmed) as BridgeEventRecord
	} catch {
		return undefined
	}
}

function assignedActorForEvent(event: BridgeEventRecord, lease?: ActorLeaseRecord | null): string | null {
	if (!lease) {
		return null
	}

	if (typeof event.wave === "number") {
		const phaseActorId = lease.phase_actor_assignments?.[String(event.wave)]
		if (typeof phaseActorId === "string" && phaseActorId.length > 0) {
			return phaseActorId
		}
	}

	return typeof lease.active_actor_id === "string" && lease.active_actor_id.length > 0 ? lease.active_actor_id : null
}

export function shouldExecuteBridgeEvent(
	event: BridgeEventRecord,
	currentActorId: string,
	lease?: ActorLeaseRecord | null,
): boolean {
	if (!event.event || !EXECUTABLE_EVENTS.has(event.event)) {
		return false
	}
	if (!event.target_actor_id || event.target_actor_id !== currentActorId) {
		return false
	}
	const assignedActorId = assignedActorForEvent(event, lease)
	if (assignedActorId && assignedActorId !== currentActorId) {
		return false
	}
	return true
}

export function getBridgeEventCommand(event: BridgeEventRecord): string | undefined {
	const payload = event.payload
	const directCommand =
		payload && typeof payload.command === "string" && payload.command.trim().length > 0 ? payload.command.trim() : undefined

	if (directCommand) {
		return directCommand
	}

	if (event.event === "verification_requested" && typeof event.wave === "number") {
		return `/gsd-verify-work ${event.wave}`
	}

	return undefined
}
