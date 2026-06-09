import { noticeNewRelicError, recordNewRelicCustomEvent, withNewRelicSegment } from './newrelic'

export const trackRelayStep = async <T>(step: string, fn: () => Promise<T>, customProps?: object) => {
	const stepStartedAt = Date.now()
	let stepSuccess = false
	let stepError: unknown

	try {
		const result = await withNewRelicSegment(`Custom/Baileys/relayMessage/${step}`, fn)
		stepSuccess = true
		return result
	} catch (error) {
		stepError = error
		noticeNewRelicError(error, {
			...customProps,
			step
		})
		throw error
	} finally {
		recordNewRelicCustomEvent('BaileysRelayMessageStep', {
			...customProps,
			step,
			success: stepSuccess,
			duration_ms: Date.now() - stepStartedAt,
			error_name: stepError instanceof Error ? stepError.name : undefined
		})
	}
}
