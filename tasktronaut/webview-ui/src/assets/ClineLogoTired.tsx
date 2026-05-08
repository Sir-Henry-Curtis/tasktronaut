import { SVGProps } from "react"
import type { Environment } from "../../../src/shared/config-types"
import TasktronautMark from "./TasktronautMark"

/**
 * ClineLogoTired component renders the sleepy Cline logo for "Lazy Teammate Mode".
 *
 * Based on the sleepy-cline.svg asset. Features droopy half-closed eyes and a
 * small sleepy mouth, giving the bot a tired/lazy appearance.
 *
 * @param {SVGProps<SVGSVGElement> & { environment?: Environment }} props - Standard SVG props plus optional environment
 * @returns {JSX.Element} SVG Cline logo with sleepy/tired expression
 */
const ClineLogoTired = (props: SVGProps<SVGSVGElement> & { environment?: Environment }) => {
	const { environment: _environment, ...svgProps } = props
	return <TasktronautMark {...svgProps} />
}
export default ClineLogoTired
