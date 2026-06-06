import type { LIDMapping, SignalKeyStoreWithTransaction } from '../Types'
import type { ILogger } from '../Utils/logger'
import { makeMutex } from '../Utils/make-mutex'
import { isLidUser, jidDecode, WAJIDDomains } from '../WABinary'

const isPnUser = (jid: string | undefined) => jid?.endsWith('@s.whatsapp.net')
const isHostedPnUser = (jid: string | undefined) => jid?.endsWith('@hosted')

export class LIDMappingStore {
	private readonly keys: SignalKeyStoreWithTransaction
	private readonly logger: ILogger
	private readonly mutex = makeMutex()

	constructor(keys: SignalKeyStoreWithTransaction, logger: ILogger) {
		this.keys = keys
		this.logger = logger
	}

	async storeLIDPNMappings(pairs: LIDMapping[]): Promise<void> {
		if (pairs.length === 0) return

		await this.mutex.mutex(async () => {
			await this.keys.transaction(async () => this.keys.set({ 'lid-mapping': pairs }), 'lid-mapping')
		})
	}

	async getLIDForPN(pn: string): Promise<string | null> {
		const data = await this.getLIDsForPNs([pn])

		if (data && !Array.isArray(data)) {
			this.logger.warn(
				{ pn },
				'Expected array of LID mappings but got single object, this may cause issues with multiple devices for the same PN'
			)
			return (data as LIDMapping).lid
		}

		return data?.[0]?.lid || null
	}

	async getLIDsForPNs(pns: string[]): Promise<LIDMapping[] | null> {
		if (pns.length === 0) return null

		const validPns = [...new Set(pns)].filter(pn => isPnUser(pn) || isHostedPnUser(pn))
		if (validPns.length === 0) return null

		const pnUsers = [...new Set(validPns.map(pn => jidDecode(pn)?.user).filter(Boolean))] as string[]
		return this.keys.get('lid-mapping', pnUsers) as unknown as Promise<LIDMapping[]>

		// const results: LIDMapping[] = []
		// const missing: string[] = []

		// for (const pn of validPns) {
		// 	const decoded = jidDecode(pn)
		// 	if (!decoded) continue

		// 	const lidUser = stored[decoded.user]
		// 	if (!lidUser) {
		// 		missing.push(pn)
		// 		continue
		// 	}

		// 	const pnDevice = decoded.device ?? 0
		// 	const deviceSpecificLid = `${lidUser}${pnDevice ? `:${pnDevice}` : ''}@${isHostedPnUser(pn) ? 'hosted.lid' : 'lid'}`
		// 	this.logger.trace(`getLIDForPN: ${pn} → ${deviceSpecificLid}`)
		// 	results.push({ lid: deviceSpecificLid, pn })
		// }

		// // if (missing.length > 0) {
		// // 	const usyncResult = await this.pnToLIDFunc(toFetch)
		// // 	if (usyncResult && usyncResult.length > 0) {
		// // 		await this.storeLIDPNMappings(usyncResult)
		// // 		results.push(...usyncResult)
		// // 	} else {
		// // 		this.logger.warn('USync fetch yielded no results for pending PNs')
		// // 	}
		// // }

		// return results.length > 0 ? results : null
	}

	async getPNForLID(lid: string): Promise<string | null> {
		return (await this.getPNsForLIDs([lid]))?.[0]?.pn || null
	}

	async getPNsForLIDs(lids: string[]): Promise<LIDMapping[] | null> {
		if (lids.length === 0) return null

		const validLids = [...new Set(lids)].filter(lid => isLidUser(lid))
		if (validLids.length === 0) return null

		const reverseKeys = [
			...new Set(
				validLids
					.map(lid => jidDecode(lid)?.user)
					.filter(Boolean)
					.map(u => `${u}_reverse`)
			)
		] as string[]
		const stored = await this.keys.get('lid-mapping', reverseKeys)

		const results: LIDMapping[] = []
		for (const lid of validLids) {
			const decoded = jidDecode(lid)
			if (!decoded) continue

			const pnUser = stored[`${decoded.user}_reverse`]
			if (!pnUser) continue

			const lidDevice = decoded.device ?? 0
			const pnJid = `${pnUser}:${lidDevice}@${decoded.domainType === WAJIDDomains.HOSTED_LID ? 'hosted' : 's.whatsapp.net'}`
			this.logger.trace(`getPNForLID: ${lid} → ${pnJid}`)
			results.push({ lid, pn: pnJid })
		}

		return results.length > 0 ? results : null
	}
}
