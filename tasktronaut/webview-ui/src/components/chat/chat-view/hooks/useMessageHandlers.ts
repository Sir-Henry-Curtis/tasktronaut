import type { ClineMessage } from "@shared/ExtensionMessage"
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { AskResponseRequest, NewTaskRequest } from "@shared/proto/cline/task"
import { useCallback, useEffect, useRef } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { SlashServiceClient, TaskServiceClient } from "@/services/grpc-client"
import type { ButtonActionType } from "../shared/buttonConfig"
import type { ChatState, MessageHandlers } from "../types/chatTypes"

/**
 * Custom hook for managing message handlers
 * Handles sending messages, button clicks, and task management
 */
export function useMessageHandlers(messages: ClineMessage[], chatState: ChatState): MessageHandlers {
	const { backgroundCommandRunning } = useExtensionState()
	const {
		setInputValue,
		activeQuote,
		setActiveQuote,
		setSelectedImages,
		setSelectedFiles,
		setSendingDisabled,
		setEnableButtons,
		clineAsk,
		lastMessage,
		messageQueue,
		setMessageQueue,
	} = chatState
	const cancelInFlightRef = useRef(false)
	const stopInFlightRef = useRef(false)
	// Updated on every render — readable from async callbacks without stale-closure issues.
	const clineAskRef = useRef(clineAsk)
	clineAskRef.current = clineAsk

	// Handle sending a message
	const handleSendMessage = useCallback(
		async (text: string, images: string[], files: string[]) => {
			let messageToSend = text.trim()
			const hasContent = messageToSend || images.length > 0 || files.length > 0

			// Prepend the active quote if it exists
			if (activeQuote && hasContent) {
				const prefix = "[context] \n> "
				const formattedQuote = activeQuote
				const suffix = "\n[/context] \n\n"
				messageToSend = `${prefix} ${formattedQuote} ${suffix} ${messageToSend}`
			}

			if (hasContent) {
				console.log("[ChatView] handleSendMessage - Sending message:", messageToSend)
				let messageSent = false

				if (messages.length === 0) {
					await TaskServiceClient.newTask(
						NewTaskRequest.create({
							text: messageToSend,
							images,
							files,
						}),
					)
					messageSent = true
				} else if (clineAsk) {
					// For resume_task and resume_completed_task, use yesButtonClicked to match Resume button behavior
					// This ensures Enter key and Resume button work identically
					if (clineAsk === "resume_task" || clineAsk === "resume_completed_task") {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
								text: messageToSend,
								images,
								files,
							}),
						)
						messageSent = true
					} else {
						// All other ask types use messageResponse
						switch (clineAsk) {
							case "followup":
							case "plan_mode_respond":
							case "tool":
							case "command":
							case "command_output":
							case "use_mcp_server":
							case "use_subagents":
							case "completion_result":
							case "mistake_limit_reached":
							case "api_req_failed":
							case "new_task":
							case "condense":
							case "report_bug":
								await TaskServiceClient.askResponse(
									AskResponseRequest.create({
										responseType: "messageResponse",
										text: messageToSend,
										images,
										files,
									}),
								)
								messageSent = true
								break
						}
					}
				} else if (messages.length > 0) {
					// No clineAsk set - check if task is actively running
					// If so, allow interrupting it with feedback
					const lastMessage = messages[messages.length - 1]
					const isTaskRunning =
						lastMessage.partial === true || (lastMessage.type === "say" && lastMessage.say === "api_req_started")

					if (isTaskRunning) {
						// Task is running - send message as interruption/feedback
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "messageResponse",
								text: messageToSend,
								images,
								files,
							}),
						)
						messageSent = true
					}
				}

				// Only clear input and disable UI if message was actually sent
				if (messageSent) {
					setInputValue("")
					setActiveQuote(null)
					setSendingDisabled(true)
					setSelectedImages([])
					setSelectedFiles([])
					setEnableButtons(false)

					// Reset auto-scroll
					if ("disableAutoScrollRef" in chatState) {
						;(chatState as any).disableAutoScrollRef.current = false
					}
				}
			}
		},
		[
			messages.length,
			clineAsk,
			activeQuote,
			setInputValue,
			setActiveQuote,
			setSendingDisabled,
			setSelectedImages,
			setSelectedFiles,
			setEnableButtons,
			chatState,
		],
	)

	// Start a new task
	const startNewTask = useCallback(async () => {
		setActiveQuote(null)
		await TaskServiceClient.clearTask(EmptyRequest.create({}))
	}, [setActiveQuote])

	// Clear input state helper
	const clearInputState = useCallback(() => {
		setInputValue("")
		setActiveQuote(null)
		setSelectedImages([])
		setSelectedFiles([])
	}, [setInputValue, setActiveQuote, setSelectedImages, setSelectedFiles])

	// Execute button action based on type
	const executeButtonAction = useCallback(
		async (actionType: ButtonActionType, text?: string, images?: string[], files?: string[]) => {
			const trimmedInput = text?.trim()
			const hasContent = trimmedInput || (images && images.length > 0) || (files && files.length > 0)

			switch (actionType) {
				case "retry":
					// For API retry (api_req_failed), always send simple approval without content
					await TaskServiceClient.askResponse(
						AskResponseRequest.create({
							responseType: "yesButtonClicked",
						}),
					)
					clearInputState()
					break
				case "approve":
					if (hasContent) {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
							}),
						)
					}
					clearInputState()
					break

				case "reject":
					if (hasContent) {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "noButtonClicked",
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "noButtonClicked",
							}),
						)
					}
					clearInputState()
					break

				case "proceed":
					if (hasContent) {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
								text: trimmedInput,
								images: images,
								files: files,
							}),
						)
					} else {
						await TaskServiceClient.askResponse(
							AskResponseRequest.create({
								responseType: "yesButtonClicked",
							}),
						)
					}
					clearInputState()
					break

				case "new_task":
					if (clineAsk === "new_task") {
						await TaskServiceClient.newTask(
							NewTaskRequest.create({
								text: lastMessage?.text,
								images: [],
								files: [],
							}),
						)
					} else {
						await startNewTask()
					}
					break

				case "cancel": {
					if (cancelInFlightRef.current) {
						return
					}
					cancelInFlightRef.current = true
					setSendingDisabled(true)
					setEnableButtons(false)
					try {
						if (backgroundCommandRunning) {
							await TaskServiceClient.cancelBackgroundCommand(EmptyRequest.create({})).catch((err) =>
								console.error("Failed to cancel background command:", err),
							)
						}
						await TaskServiceClient.cancelTask(EmptyRequest.create({}))
					} finally {
						cancelInFlightRef.current = false
						// Clear any pending state that might interfere with resume
						setSendingDisabled(false)
						setEnableButtons(true)
					}
					break
				}

				case "utility":
					switch (clineAsk) {
						case "condense":
							await SlashServiceClient.condense(StringRequest.create({ value: lastMessage?.text })).catch((err) =>
								console.error(err),
							)
							break
						case "report_bug":
							await SlashServiceClient.reportBug(StringRequest.create({ value: lastMessage?.text })).catch((err) =>
								console.error(err),
							)
							break
					}
					break
			}

			if ("disableAutoScrollRef" in chatState) {
				;(chatState as any).disableAutoScrollRef.current = false
			}
		},
		[
			clineAsk,
			lastMessage,
			messages,
			clearInputState,
			handleSendMessage,
			startNewTask,
			chatState,
			backgroundCommandRunning,
			setSendingDisabled,
			setEnableButtons,
		],
	)

	// Handle task close button click
	const handleTaskCloseButtonClick = useCallback(() => {
		startNewTask()
	}, [startNewTask])

	// Add a message to the queue (called when task is busy)
	const handleQueueMessage = useCallback(
		(text: string, images: string[], files: string[]) => {
			const trimmed = text.trim()
			if (!trimmed && !images.length && !files.length) return
			setMessageQueue((prev) => [
				...prev,
				{
					id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
					text: trimmed,
					images,
					files,
				},
			])
		},
		[setMessageQueue],
	)

	// Remove a message from the queue by ID
	const removeFromQueue = useCallback(
		(id: string) => {
			setMessageQueue((prev) => prev.filter((m) => m.id !== id))
		},
		[setMessageQueue],
	)

	// Cancel the current task and auto-send the first queued message when resumed.
	// Polls clineAskRef directly so it works even when cancelTask() produces no
	// history item (and therefore no resume_task ask) — in that case we timeout
	// and put the message back in the queue.
	const stopAndProcessQueue = useCallback(async () => {
		if (!messageQueue.length) return
		if (stopInFlightRef.current) return
		stopInFlightRef.current = true

		const [first, ...rest] = messageQueue
		setMessageQueue(rest)
		setSendingDisabled(true)
		setEnableButtons(false)
		try {
			if (backgroundCommandRunning) {
				await TaskServiceClient.cancelBackgroundCommand(EmptyRequest.create({})).catch((err) =>
					console.error("Failed to cancel background command:", err),
				)
			}
			await TaskServiceClient.cancelTask(EmptyRequest.create({}))

			// Poll until the task enters resume state (max 15 s).
			// clineAskRef.current is updated on every render so it's always fresh.
			const deadline = Date.now() + 15_000
			while (
				clineAskRef.current !== "resume_task" &&
				clineAskRef.current !== "resume_completed_task"
			) {
				if (Date.now() > deadline) {
					throw new Error("[Queue] Timed out waiting for resume state")
				}
				await new Promise<void>((r) => setTimeout(r, 100))
			}

			await TaskServiceClient.askResponse(
				AskResponseRequest.create({
					responseType: "yesButtonClicked",
					text: first.text,
					images: first.images,
					files: first.files,
				}),
			)
		} catch (err) {
			console.error("[Queue] Failed to process queued message:", err)
			setMessageQueue((prev) => [first, ...prev])
		} finally {
			stopInFlightRef.current = false
		}
	}, [messageQueue, setMessageQueue, setSendingDisabled, setEnableButtons, backgroundCommandRunning])

	// Auto-drain the queue when the model becomes naturally idle (no user button press needed).
	// Fires when clineAsk transitions to a "waiting for input" state while items remain queued.
	const autoProcessInFlightRef = useRef(false)
	useEffect(() => {
		if (messageQueue.length === 0) return
		if (autoProcessInFlightRef.current || stopInFlightRef.current) return

		// Only auto-send when model is waiting for user input (not streaming, not tool approval)
		if (clineAsk !== "followup" && clineAsk !== "resume_task" && clineAsk !== "resume_completed_task") return

		autoProcessInFlightRef.current = true
		const [first, ...rest] = messageQueue
		setMessageQueue(rest)
		setSendingDisabled(true)
		setEnableButtons(false)

		const responseType =
			clineAsk === "resume_task" || clineAsk === "resume_completed_task" ? "yesButtonClicked" : "messageResponse"

		TaskServiceClient.askResponse(
			AskResponseRequest.create({
				responseType,
				text: first.text,
				images: first.images,
				files: first.files,
			}),
		)
			.catch((err) => {
				console.error("[Queue] Auto-process failed:", err)
				setMessageQueue((prev) => [first, ...prev])
			})
			.finally(() => {
				autoProcessInFlightRef.current = false
			})
	}, [clineAsk, messageQueue, setMessageQueue, setSendingDisabled, setEnableButtons])

	return {
		handleSendMessage,
		executeButtonAction,
		handleTaskCloseButtonClick,
		startNewTask,
		handleQueueMessage,
		removeFromQueue,
		stopAndProcessQueue,
	}
}
