/**
 * scenarios.ts — pluggable response engines for the fake server.
 *
 * A scenario receives every inbound binary node *after* fault injection
 * decided to forward it. It returns one or more outbound nodes to send back.
 * Scenarios are stateful per-connection.
 */

import type { BinaryNode } from '../../src/WABinary'
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../../src/WABinary'
import type { ConnectionContext } from './server'

export type ScenarioReply = BinaryNode | BinaryNode[] | void | null

export type ScenarioHook = (
	node: BinaryNode,
	ctx: ConnectionContext
) => Promise<ScenarioReply> | ScenarioReply

export type Scenario = {
	name: string
	/**
	 * Called once immediately after the handshake completes (post-handshake
	 * "welcome" frames such as `<success/>` or `<iq type=set><pair-device/>`
	 * are produced here).
	 */
	onConnected?: (ctx: ConnectionContext) => Promise<BinaryNode[]> | BinaryNode[]
	/** Called for every inbound node from this client. */
	onNode?: ScenarioHook
}

/** Convenience builder for an `<iq type="result"/>` reply. */
export const replyIqResult = (req: BinaryNode, content?: BinaryNode[]): BinaryNode => ({
	tag: 'iq',
	attrs: {
		from: S_WHATSAPP_NET,
		type: 'result',
		id: req.attrs.id!
	},
	content
})

/** Convenience builder for an `<iq type="error"/>` reply. */
export const replyIqError = (req: BinaryNode, code = 500, text = 'fake-server-error'): BinaryNode => ({
	tag: 'iq',
	attrs: {
		from: S_WHATSAPP_NET,
		type: 'error',
		id: req.attrs.id!
	},
	content: [
		{
			tag: 'error',
			attrs: { code: String(code), text }
		}
	]
})

/**
 * Default scenario: minimum behaviour required for a Baileys client whose
 * credentials are already populated to reach the `connection: 'open'` state
 * and remain stable.
 *
 * Implemented responses:
 *   - `<success/>` is emitted right after the handshake (logged-in path).
 *   - `<iq xmlns="encrypt"><count/></iq>` → returns 100 keys available so
 *     the client skips pre-key upload.
 *   - `<iq xmlns="passive"><active/></iq>` → empty success result.
 *   - Any other `<iq type="get"|"set"/>` → empty success result.
 *   - `<message/>` from client → server `<ack/>` (best-effort).
 *
 * This is intentionally permissive: it returns success for unknown queries
 * so concurrency tests are not bottlenecked on missing protocol coverage.
 */
export const defaultLoggedInScenario = (): Scenario => ({
	name: 'default-logged-in',
	onConnected: ctx => {
		const lid = ctx.identity.lid ?? `${ctx.identity.user}.0:0@lid`
		return [
			{
				tag: 'success',
				attrs: {
					t: String(Math.floor(Date.now() / 1000)),
					lid,
					creation: String(Math.floor(Date.now() / 1000))
				}
			}
		]
	},
	onNode: (node, _ctx) => {
		if (node.tag === 'iq') {
			const type = node.attrs.type
			if (type === 'get' || type === 'set') {
				const xmlns = node.attrs.xmlns
				if (xmlns === 'encrypt' && getBinaryNodeChild(node, 'count')) {
					return replyIqResult(node, [{ tag: 'count', attrs: { value: '100' } }])
				}
				return replyIqResult(node)
			}
			return null
		}

		if (node.tag === 'message') {
			const id = node.attrs.id
			const to = node.attrs.to
			if (!id || !to) {
				return null
			}
			return {
				tag: 'ack',
				attrs: {
					id,
					to,
					class: 'message'
				}
			}
		}

		if (node.tag === 'presence') {
			return null
		}

		// Unknown — ignore. Tests can compose richer scenarios.
		return null
	}
})

/**
 * Scenario that pretends the device is *not* registered and exercises the
 * QR-pair flow.
 */
export const pairDeviceScenario = (): Scenario => ({
	name: 'pair-device',
	onConnected: () => [
		{
			tag: 'iq',
			attrs: {
				from: S_WHATSAPP_NET,
				type: 'set',
				id: `${Date.now()}.pd`
			},
			content: [
				{
					tag: 'pair-device',
					attrs: {},
					content: [
						{ tag: 'ref', attrs: {}, content: Buffer.from(`fake-ref-${Date.now()}-1`, 'utf-8') },
						{ tag: 'ref', attrs: {}, content: Buffer.from(`fake-ref-${Date.now()}-2`, 'utf-8') },
						{ tag: 'ref', attrs: {}, content: Buffer.from(`fake-ref-${Date.now()}-3`, 'utf-8') }
					]
				}
			]
		}
	],
	onNode: () => null
})

/** Composes multiple scenarios — the first non-null reply wins. */
export const composeScenarios = (...all: Scenario[]): Scenario => ({
	name: `compose(${all.map(s => s.name).join(',')})`,
	onConnected: async ctx => {
		const out: BinaryNode[] = []
		for (const s of all) {
			if (s.onConnected) {
				const r = await s.onConnected(ctx)
				out.push(...r)
			}
		}
		return out
	},
	onNode: async (node, ctx) => {
		for (const s of all) {
			if (!s.onNode) {
				continue
			}
			const r = await s.onNode(node, ctx)
			if (r !== undefined && r !== null) {
				return r
			}
		}
		return null
	}
})
