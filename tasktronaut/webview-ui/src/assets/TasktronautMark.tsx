import { SVGProps } from "react"
import tasktronautIconUrl from "../../../assets/icons/icon.svg?url"

type TasktronautMarkProps = SVGProps<SVGSVGElement> & {
	monochrome?: string
}

const TasktronautMark = ({ monochrome, ...props }: TasktronautMarkProps) => {
	const { className, height, style, width } = props

	if (!monochrome) {
		return (
			<img
				alt="Tasktronaut"
				className={className}
				draggable={false}
				height={height}
				src={tasktronautIconUrl}
				style={style}
				width={width}
			/>
		)
	}

	const navy = monochrome ?? "#0B1F5C"
	const helmet = monochrome ?? "#FFFFFF"
	const face = monochrome ?? "#0B1F5C"
	const cyan = monochrome ?? "#22D3EE"
	const orange = monochrome ?? "#FF9F1C"

	return (
		<svg fill="none" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" {...props}>
			<path
				d="M10 64C15 77 33 85 54 83C69 81 81 75 88 66"
				stroke={cyan}
				strokeLinecap="round"
				strokeWidth="6"
			/>
			<path
				d="M81 59L84 63L89 62L85 66L86 71L81 68L77 71L78 66L74 62L79 63L81 59Z"
				fill={cyan}
			/>
			<path d="M46 14V8" stroke={navy} strokeLinecap="round" strokeWidth="4" />
			<circle cx="46" cy="5" fill={orange} r="4" stroke={navy} strokeWidth="2" />
			<rect fill={helmet} height="50" rx="18" stroke={navy} strokeWidth="4" width="52" x="20" y="16" />
			<rect fill={helmet} height="18" rx="7" stroke={navy} strokeWidth="4" width="10" x="12" y="34" />
			<rect fill={helmet} height="18" rx="7" stroke={navy} strokeWidth="4" width="10" x="72" y="34" />
			<rect fill={face} height="24" rx="10" width="36" x="28" y="28" />
			<path d="M35 40C36.6 37.4 39.4 37.4 41 40" stroke={cyan} strokeLinecap="round" strokeWidth="3.5" />
			<path d="M51 40C52.6 37.4 55.4 37.4 57 40" stroke={cyan} strokeLinecap="round" strokeWidth="3.5" />
			<path d="M40 57L43 69" stroke={orange} strokeLinecap="round" strokeWidth="5" />
			<path d="M48 57L48 72" stroke={orange} strokeLinecap="round" strokeWidth="5" />
			<path d="M56 57L53 69" stroke={orange} strokeLinecap="round" strokeWidth="5" />
		</svg>
	)
}

export default TasktronautMark
