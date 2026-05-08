import { McpViewTab } from "@shared/mcp"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import ViewHeader from "../../common/ViewHeader"
import ConfigureServersView from "./tabs/installed/ConfigureServersView"

type McpViewProps = {
	onDone: () => void
	initialTab?: McpViewTab
}

const McpConfigurationView = ({ onDone }: McpViewProps) => {
	const { environment } = useExtensionState()

	return (
		<div
			style={{
				position: "fixed",
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				display: "flex",
				flexDirection: "column",
			}}>
			<ViewHeader environment={environment} onDone={onDone} title="MCP Servers" />

			<div style={{ flex: 1, overflow: "auto" }}>
				<ConfigureServersView />
			</div>
		</div>
	)
}

const StyledTabButton = styled.button.withConfig({
	shouldForwardProp: (prop) => !["isActive"].includes(prop),
})<{ isActive: boolean; disabled?: boolean }>`
	background: none;
	border: none;
	border-bottom: 2px solid ${(props) => (props.isActive ? "var(--vscode-foreground)" : "transparent")};
	color: ${(props) => (props.isActive ? "var(--vscode-foreground)" : "var(--vscode-descriptionForeground)")};
	padding: 8px 16px;
	cursor: ${(props) => (props.disabled ? "not-allowed" : "pointer")};
	font-size: 13px;
	margin-bottom: -1px;
	font-family: inherit;
	opacity: ${(props) => (props.disabled ? 0.6 : 1)};
	pointer-events: ${(props) => (props.disabled ? "none" : "auto")};

	&:hover {
		color: ${(props) => (props.disabled ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)")};
	}
`

export const TabButton = ({
	children,
	isActive,
	onClick,
	disabled,
	style,
}: {
	children: React.ReactNode
	isActive: boolean
	onClick: () => void
	disabled?: boolean
	style?: React.CSSProperties
}) => (
	<StyledTabButton disabled={disabled} isActive={isActive} onClick={onClick} style={style}>
		{children}
	</StyledTabButton>
)

export default McpConfigurationView
