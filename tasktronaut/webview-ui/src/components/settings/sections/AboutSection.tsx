import Section from "../Section"

interface AboutSectionProps {
	version: string
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const AboutSection = ({ version, renderSectionHeader }: AboutSectionProps) => {
	return (
		<div>
			{renderSectionHeader("about")}
			<Section>
				<div className="flex px-4 flex-col gap-2">
					<h2 className="text-lg font-semibold">Tasktronaut v{version}</h2>
					<p>
						Tasktronaut is a mission-ready coding assistant for structured engineering workflows. It can explore your
						codebase, edit files, run terminal commands, and use browser tools while keeping you in the approval loop.
					</p>

					<h3 className="text-md font-semibold">Distribution</h3>
					<p>This build is intended for internally managed deployment and configuration.</p>

					<h3 className="text-md font-semibold">Architecture</h3>
					<p>
						Tasktronaut combines a hardened extension runtime with structured execution workflows and controlled tool
						access.
					</p>

					<h3 className="text-md font-semibold">Support</h3>
					<p>Project-specific documentation and support channels should be provided by the internal distribution owner.</p>
				</div>
			</Section>
		</div>
	)
}

export default AboutSection
