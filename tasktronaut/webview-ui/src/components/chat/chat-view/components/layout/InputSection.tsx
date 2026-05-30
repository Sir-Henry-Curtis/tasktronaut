import React, { useCallback } from "react"
import ChatTextArea from "@/components/chat/ChatTextArea"
import QuotedMessagePreview from "@/components/chat/QuotedMessagePreview"
import { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"
import { MessageQueuePanel } from "./MessageQueuePanel"

interface InputSectionProps {
	chatState: ChatState
	messageHandlers: MessageHandlers
	scrollBehavior: ScrollBehavior
	placeholderText: string
	shouldDisableFilesAndImages: boolean
	selectFilesAndImages: () => Promise<void>
}

/**
 * Input section including quoted message preview, chat text area, and message queue
 */
export const InputSection: React.FC<InputSectionProps> = ({
	chatState,
	messageHandlers,
	scrollBehavior,
	placeholderText,
	shouldDisableFilesAndImages,
	selectFilesAndImages,
}) => {
	const {
		activeQuote,
		setActiveQuote,
		isTextAreaFocused,
		inputValue,
		setInputValue,
		sendingDisabled,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		textAreaRef,
		handleFocusChange,
		messageQueue,
	} = chatState

	const { isAtBottom, scrollToBottomAuto } = scrollBehavior

	// When the task is busy, queue the current input instead of sending
	const handleQueueMessage = useCallback(() => {
		const text = inputValue.trim()
		if (!text && !selectedImages.length && !selectedFiles.length) return
		messageHandlers.handleQueueMessage(text, selectedImages, selectedFiles)
		setInputValue("")
		setSelectedImages([])
		setSelectedFiles([])
	}, [inputValue, selectedImages, selectedFiles, messageHandlers, setInputValue, setSelectedImages, setSelectedFiles])

	return (
		<>
			{activeQuote && (
				<div style={{ marginBottom: "-12px", marginTop: "10px" }}>
					<QuotedMessagePreview
						isFocused={isTextAreaFocused}
						onDismiss={() => setActiveQuote(null)}
						text={activeQuote}
					/>
				</div>
			)}

			<ChatTextArea
				activeQuote={activeQuote}
				inputValue={inputValue}
				onFocusChange={handleFocusChange}
				onHeightChange={() => {
					if (isAtBottom) {
						scrollToBottomAuto()
					}
				}}
				onQueueMessage={sendingDisabled ? handleQueueMessage : undefined}
				onSelectFilesAndImages={selectFilesAndImages}
				onSend={() => messageHandlers.handleSendMessage(inputValue, selectedImages, selectedFiles)}
				placeholderText={placeholderText}
				ref={textAreaRef}
				selectedFiles={selectedFiles}
				selectedImages={selectedImages}
				sendingDisabled={sendingDisabled}
				setInputValue={setInputValue}
				setSelectedFiles={setSelectedFiles}
				setSelectedImages={setSelectedImages}
				shouldDisableFilesAndImages={shouldDisableFilesAndImages}
			/>

			<MessageQueuePanel
				isBusy={sendingDisabled}
				onRemove={messageHandlers.removeFromQueue}
				onStopAndProcess={messageHandlers.stopAndProcessQueue}
				queue={messageQueue}
			/>
		</>
	)
}
