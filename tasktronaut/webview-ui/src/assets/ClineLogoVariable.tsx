import { SVGProps } from "react"
import type { Environment } from "../../../src/shared/config-types"
import TasktronautMark from "./TasktronautMark"

/**
 * ClineLogoVariable component renders the Cline logo with automatic theme adaptation
 * and environment-based color indicators.
 *
 * This component uses VS Code theme variables for the fill color, with environment-specific colors:
 * - Local: yellow/orange (development/experimental)
 * - Staging: blue (stable testing)
 * - Production: gray/white (default icon color)
 *
 * @param {SVGProps<SVGSVGElement> & { environment?: Environment }} props - Standard SVG props plus optional environment
 * @returns {JSX.Element} SVG Cline logo that adapts to VS Code themes and environment
 */
const ClineLogoVariable = (props: SVGProps<SVGSVGElement> & { environment?: Environment }) => {
	const { environment: _environment, ...svgProps } = props
	return <TasktronautMark {...svgProps} />
}
export default ClineLogoVariable
