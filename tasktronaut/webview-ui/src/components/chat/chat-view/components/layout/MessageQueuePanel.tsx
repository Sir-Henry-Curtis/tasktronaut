import React from "react"
import styled from "styled-components"
import type { QueuedMessage } from "../../types/chatTypes"

interface MessageQueuePanelProps {
	queue: QueuedMessage[]
	isBusy: boolean
	onRemove: (id: string) => void
	onStopAndProcess: () => void
}

export const MessageQueuePanel: React.FC<MessageQueuePanelProps> = ({ queue, isBusy, onRemove, onStopAndProcess }) => {
	if (queue.length === 0) return null

	return (
		<Container>
			<Header>
				<HeaderLeft>
					<span className="codicon codicon-list-ordered" style={{ fontSize: 11, opacity: 0.7 }} />
					<HeaderLabel>Queued ({queue.length})</HeaderLabel>
				</HeaderLeft>
				{isBusy && (
					<StopButton onClick={onStopAndProcess} title="Stop current task and process first queued message">
						<span className="codicon codicon-debug-stop" style={{ fontSize: 10 }} />
						Stop &amp; Process
					</StopButton>
				)}
			</Header>
			<ItemList>
				{queue.map((item, index) => (
					<Item key={item.id}>
						<ItemIndex>{index + 1}</ItemIndex>
						<ItemText>
							{item.text || (item.images.length > 0 ? "[image attachment]" : "[file attachment]")}
						</ItemText>
						<DeleteButton
							onClick={() => onRemove(item.id)}
							title="Remove from queue"
							className="codicon codicon-close"
						/>
					</Item>
				))}
			</ItemList>
		</Container>
	)
}

const Container = styled.div`
	margin: 0 15px 6px 15px;
	border-radius: 0 0 4px 4px;
	background-color: var(--vscode-input-background);
	border: 1px solid color-mix(in srgb, var(--vscode-input-border) 60%, transparent 40%);
	border-top: none;
	overflow: hidden;
`

const Header = styled.div`
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 4px 8px;
	background-color: color-mix(in srgb, var(--vscode-input-background) 80%, var(--vscode-editor-background) 20%);
	border-bottom: 1px solid color-mix(in srgb, var(--vscode-input-border) 40%, transparent 60%);
`

const HeaderLeft = styled.div`
	display: flex;
	align-items: center;
	gap: 5px;
`

const HeaderLabel = styled.span`
	font-size: 10px;
	opacity: 0.7;
	text-transform: uppercase;
	letter-spacing: 0.05em;
`

const StopButton = styled.button`
	display: flex;
	align-items: center;
	gap: 4px;
	font-size: 10px;
	padding: 2px 6px;
	border-radius: 3px;
	border: 1px solid var(--vscode-button-border, transparent);
	background-color: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
	cursor: pointer;
	opacity: 0.85;
	transition: opacity 0.1s;

	&:hover {
		opacity: 1;
		background-color: var(--vscode-button-secondaryHoverBackground);
	}
`

const ItemList = styled.div`
	display: flex;
	flex-direction: column;
`

const Item = styled.div`
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 8px;
	border-bottom: 1px solid color-mix(in srgb, var(--vscode-input-border) 20%, transparent 80%);

	&:last-child {
		border-bottom: none;
	}
`

const ItemIndex = styled.span`
	font-size: 10px;
	opacity: 0.4;
	min-width: 12px;
	text-align: right;
	flex-shrink: 0;
`

const ItemText = styled.span`
	flex: 1;
	font-size: 11px;
	opacity: 0.75;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
`

const DeleteButton = styled.span`
	font-size: 11px;
	opacity: 0.4;
	cursor: pointer;
	flex-shrink: 0;
	padding: 1px;
	border-radius: 2px;

	&:hover {
		opacity: 0.9;
		background-color: var(--vscode-toolbar-hoverBackground);
	}
`
