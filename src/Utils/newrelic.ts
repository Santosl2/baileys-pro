import { createRequire } from 'module'
const _require = createRequire(import.meta.url)

type NewRelicAttributes = Record<string, string | number | boolean | null | undefined>

type NewRelicAgent = {
	startSegment?: <T>(name: string, record: boolean, handler: () => T) => T
	recordCustomEvent?: (eventType: string, attributes: Record<string, unknown>) => void
	noticeError?: (error: Error, customAttributes?: Record<string, unknown>) => void
	addCustomAttributes?: (attributes: NewRelicAttributes) => void
}

let cachedNewRelicAgent: NewRelicAgent | null | undefined

const getNewRelicAgent = () => {
	if (cachedNewRelicAgent !== undefined) {
		return cachedNewRelicAgent
	}

	try {
		const loaded = _require('newrelic') as NewRelicAgent
		cachedNewRelicAgent = loaded
	} catch {
		cachedNewRelicAgent = null
	}

	return cachedNewRelicAgent
}

export const withNewRelicSegment = async <T>(name: string, handler: () => Promise<T>) => {
	const agent = getNewRelicAgent()
	if (agent?.startSegment) {
		return await agent.startSegment(name, true, handler)
	}

	return await handler()
}

export const addNewRelicAttributes = (attributes: NewRelicAttributes) => {
	const agent = getNewRelicAgent()
	if (!agent?.addCustomAttributes) {
		return
	}

	try {
		agent.addCustomAttributes(attributes)
	} catch {
		// no-op: instrumentation should never break the message flow
	}
}

export const recordNewRelicCustomEvent = (eventType: string, attributes: Record<string, unknown>) => {
	const agent = getNewRelicAgent()
	if (!agent?.recordCustomEvent) {
		return
	}

	try {
		agent.recordCustomEvent(eventType, attributes)
	} catch {
		// no-op: instrumentation should never break the message flow
	}
}

export const noticeNewRelicError = (error: unknown, customAttributes?: Record<string, unknown>) => {
	const agent = getNewRelicAgent()
	if (!agent?.noticeError || !(error instanceof Error)) {
		return
	}

	try {
		agent.noticeError(error, customAttributes)
	} catch {
		// no-op: instrumentation should never break the message flow
	}
}
