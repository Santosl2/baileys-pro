import { KEY_BUNDLE_TYPE } from '../Defaults'
import { SignalRepository } from '../Types'
import {
	AuthenticationCreds,
	AuthenticationState,
	KeyPair,
	SignalIdentity,
	SignalKeyStore,
	SignedKeyPair
} from '../Types/Auth'
import {
	assertNodeErrorFree,
	BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildren,
	getBinaryNodeChildUInt,
	jidDecode,
	JidWithDevice,
	S_WHATSAPP_NET
} from '../WABinary'
import { DeviceListData, ParsedDeviceInfo, USyncQueryResultList } from '../WAUSync'
import { Curve, generateSignalPubKey } from './crypto'
import { encodeBigEndian } from './generics'
import { ILogger } from './logger'

export const createSignalIdentity = (wid: string, accountSignatureKey: Uint8Array): SignalIdentity => {
	return {
		identifier: { name: wid, deviceId: 0 },
		identifierKey: generateSignalPubKey(accountSignatureKey)
	}
}

export const getPreKeys = async ({ get }: SignalKeyStore, min: number, limit: number) => {
	const idList: string[] = []
	for (let id = min; id < limit; id++) {
		idList.push(id.toString())
	}

	return get('pre-key', idList)
}

export const generateOrGetPreKeys = (creds: AuthenticationCreds, range: number) => {
	const avaliable = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId
	const remaining = range - avaliable
	const lastPreKeyId = creds.nextPreKeyId + remaining - 1
	const newPreKeys: { [id: number]: KeyPair } = {}
	if (remaining > 0) {
		for (let i = creds.nextPreKeyId; i <= lastPreKeyId; i++) {
			newPreKeys[i] = Curve.generateKeyPair()
		}
	}

	return {
		newPreKeys,
		lastPreKeyId,
		preKeysRange: [creds.firstUnuploadedPreKeyId, range] as const
	}
}

export const xmppSignedPreKey = (key: SignedKeyPair): BinaryNode => ({
	tag: 'skey',
	attrs: {},
	content: [
		{ tag: 'id', attrs: {}, content: encodeBigEndian(key.keyId, 3) },
		{ tag: 'value', attrs: {}, content: key.keyPair.public },
		{ tag: 'signature', attrs: {}, content: key.signature }
	]
})

export const xmppPreKey = (pair: KeyPair, id: number): BinaryNode => ({
	tag: 'key',
	attrs: {},
	content: [
		{ tag: 'id', attrs: {}, content: encodeBigEndian(id, 3) },
		{ tag: 'value', attrs: {}, content: pair.public }
	]
})

export const parseAndInjectE2ESessions = async (node: BinaryNode, repository: SignalRepository, logger?: ILogger) => {
	const extractKey = (key: BinaryNode) =>
		key
			? {
					keyId: getBinaryNodeChildUInt(key, 'id', 3)!,
					publicKey: generateSignalPubKey(getBinaryNodeChildBuffer(key, 'value')!),
					signature: getBinaryNodeChildBuffer(key, 'signature')!
				}
			: undefined

	const nodes = getBinaryNodeChildren(getBinaryNodeChild(node, 'list'), 'user')

	for (const node of nodes) {
		assertNodeErrorFree(node)
	}

	// repository.injectE2ESession is CPU-bound (WASM crypto), not IO.
	// A fixed chunk size doesn't adapt to actual execution time — 100 heavy ops
	// can block the event loop for hundreds of ms.
	// Instead, use a time-budget: yield via setImmediate whenever >= BUDGET_MS
	// of CPU time has been consumed, regardless of how many items that took.
	// Note: if a single injectE2ESession exceeds BUDGET_MS, we can't avoid that
	// spike — yielding happens after each call. Worker Threads would be the only
	// true fix for that edge case.
	const BUDGET_MS = 5
	const startTime = performance.now()
	let budgetStart = startTime

	for (const node of nodes) {
		const signedKey = getBinaryNodeChild(node, 'skey')!
		const key = getBinaryNodeChild(node, 'key')!
		const identity = getBinaryNodeChildBuffer(node, 'identity')!
		const jid = node.attrs.jid
		const registrationId = getBinaryNodeChildUInt(node, 'registration', 4)

		await repository.injectE2ESession({
			jid,
			session: {
				registrationId: registrationId!,
				identityKey: generateSignalPubKey(identity),
				signedPreKey: extractKey(signedKey)!,
				preKey: extractKey(key)!
			}
		})

		if (performance.now() - budgetStart >= BUDGET_MS) {
			await new Promise<void>(resolve => setImmediate(resolve))
			budgetStart = performance.now()
		}
	}

	const elapsed = performance.now() - startTime
	logger?.warn(`Injected E2E sessions for ${nodes.length} users in ${elapsed.toFixed(2)}ms`)
}

export const extractDeviceJids = (
	result: USyncQueryResultList[],
	myJid: string,
	excludeZeroDevices: boolean,
	deviceResults: JidWithDevice[] = []
) => {
	const { user: myUser, device: myDevice } = jidDecode(myJid)!

	// Map em vez de plain object: sem prototype chain, lookup O(1) real
	const deviceMap = new Map<string, JidWithDevice[]>()

	for (const userResult of result) {
		const { devices, id } = userResult as { devices: ParsedDeviceInfo; id: string }
		const { user, server } = jidDecode(id)!
		const deviceList = devices?.deviceList as DeviceListData[]

		if (Array.isArray(deviceList)) {
			for (const { id: device, keyIndex } of deviceList) {
				if (
					(!excludeZeroDevices || device !== 0) &&
					(myUser !== user || myDevice !== device) &&
					(device === 0 || !!keyIndex)
				) {
					const item: JidWithDevice = { user, device, server }

					let userDevices = deviceMap.get(user)
					// eslint-disable-next-line max-depth
					if (!userDevices) {
						userDevices = []
						deviceMap.set(user, userDevices)
					}

					userDevices.push(item)
					deviceResults.push(item) // mesmo objeto, sem cópia
				}
			}
		}
	}

	// extracted removido — nunca era usado pelo caller
	return { deviceMap }
}

/**
 * get the next N keys for upload or processing
 * @param count number of pre-keys to get or generate
 */
export const getNextPreKeys = async ({ creds, keys }: AuthenticationState, count: number) => {
	const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, count)

	const update: Partial<AuthenticationCreds> = {
		nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
		firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1)
	}

	await keys.set({ 'pre-key': newPreKeys })

	const preKeys = await getPreKeys(keys, preKeysRange[0], preKeysRange[0] + preKeysRange[1])

	return { update, preKeys }
}

export const getNextPreKeysNode = async (state: AuthenticationState, count: number) => {
	const { creds } = state
	const { update, preKeys } = await getNextPreKeys(state, count)

	const node: BinaryNode = {
		tag: 'iq',
		attrs: {
			xmlns: 'encrypt',
			type: 'set',
			to: S_WHATSAPP_NET
		},
		content: [
			{ tag: 'registration', attrs: {}, content: encodeBigEndian(creds.registrationId) },
			{ tag: 'type', attrs: {}, content: KEY_BUNDLE_TYPE },
			{ tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
			{ tag: 'list', attrs: {}, content: Object.keys(preKeys).map(k => xmppPreKey(preKeys[+k], +k)) },
			xmppSignedPreKey(creds.signedPreKey)
		]
	}

	return { update, node }
}
