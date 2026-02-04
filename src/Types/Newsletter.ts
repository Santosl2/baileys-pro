export enum XWAPaths {
	xwa2_newsletter_create = 'xwa2_newsletter_create',
	xwa2_newsletter_subscribers = 'xwa2_newsletter_subscribers',
	xwa2_newsletter_view = 'xwa2_newsletter_view',
	xwa2_newsletter_metadata = 'xwa2_newsletter',
	xwa2_newsletter_admin_count = 'xwa2_newsletter_admin',
	xwa2_newsletter_subscribed = 'xwa2_newsletter_subscribed',
	xwa2_newsletter_mute_v2 = 'xwa2_newsletter_mute_v2',
	xwa2_newsletter_unmute_v2 = 'xwa2_newsletter_unmute_v2',
	xwa2_newsletter_follow = 'xwa2_newsletter_follow',
	xwa2_newsletter_unfollow = 'xwa2_newsletter_unfollow',
	xwa2_newsletter_change_owner = 'xwa2_newsletter_change_owner',
	xwa2_newsletter_demote = 'xwa2_newsletter_demote',
	xwa2_newsletter_delete_v2 = 'xwa2_newsletter_delete_v2'
}
export enum QueryIds {
	CREATE = '8823471724422422',
	UPDATE_METADATA = '24250201037901610',
	METADATA = '6563316087068696',
	GET_SUBSCRIBED = '8621797084555037',
	SUBSCRIBERS = '9783111038412085',
	FOLLOW = '7871414976211147',
	UNFOLLOW = '7238632346214362',
	MUTE = '29766401636284406',
	UNMUTE = '9864994326891137',
	ADMIN_COUNT = '7130823597031706',
	CHANGE_OWNER = '7341777602580933',
	DEMOTE = '6551828931592903',
	DELETE = '30062808666639665'
}
export type NewsletterUpdate = {
	name?: string
	description?: string
	picture?: string
}
export interface NewsletterCreateResponse {
	id: string
	state: { type: string }
	thread_metadata: {
		creation_time: string
		description: { id: string; text: string; update_time: string }
		handle: string | null
		invite: string
		name: { id: string; text: string; update_time: string }
		picture: { direct_path: string; id: string; type: string }
		preview: { direct_path: string; id: string; type: string }
		subscribers_count: string
		verification: 'VERIFIED' | 'UNVERIFIED'
	}
	viewer_metadata: {
		mute: 'ON' | 'OFF'
		role: NewsletterViewRole
	}
}
export interface NewsletterCreateResponse {
	id: string
	state: { type: string }
	thread_metadata: {
		creation_time: string
		description: { id: string; text: string; update_time: string }
		handle: string | null
		invite: string
		name: { id: string; text: string; update_time: string }
		picture: { direct_path: string; id: string; type: string }
		preview: { direct_path: string; id: string; type: string }
		subscribers_count: string
		verification: 'VERIFIED' | 'UNVERIFIED'
	}
	viewer_metadata: {
		mute: 'ON' | 'OFF'
		role: NewsletterViewRole
	}
}
export type NewsletterViewRole = 'ADMIN' | 'GUEST' | 'OWNER' | 'SUBSCRIBER'
export interface NewsletterMetadata {
	id: string
	owner?: string
	name: string
	description?: string
	invite?: string
	creation_time?: number
	subscribers?: number
	picture?: {
		url?: string
		directPath?: string
		mediaKey?: string
		id?: string
	}
	verification?: 'VERIFIED' | 'UNVERIFIED'
	reaction_codes?: {
		code: string
		count: number
	}[]
	mute_state?: 'ON' | 'OFF'
	thread_metadata?: {
		creation_time?: number
		name?: string
		description?: string
	}
}

export namespace NewsletterMetadaNew {
	export interface Response {
		id: string
		state: State
		thread_metadata: Threadmetadatum | null
		viewer_metadata: Viewermetadatum | null
	}

	interface Viewermetadatum {
		mute: string
		role: string
		wamo_sub_status: string
	}

	interface Threadmetadatum {
		creation_time: string
		description: Description
		followers_count: string
		handle: null
		invite: string
		name: Description
		picture: null
		preview: Preview
		settings: Settings
		subscribers_count: string
		verification: string
		verification_source: string
	}
}

export interface NewsletterEventPayloads {
	xwa2_notify_newsletter_on_join: NewsletterJoinPayload
	xwa2_notify_newsletter_on_metadata_update: NewsletterMetadataUpdate
	xwa2_notify_newsletter_on_leave: NewsletterLeavePayload
	xwa2_notify_newsletter_admin_promote: NewsletterAdminPromotePayload
	xwa2_notify_newsletter_milestone: NewsletterMilestonePayload
	xwa2_notify_newsletter_admin_demote: NewsletterAdminPromotePayload
	xwa2_notify_newsletter_on_state_change: NewsletterOnStateChangePayload
}

export interface NewsletterOnStateChangePayload {
	id: string
	is_requestor: boolean
	state: {
		type: string
	}
}

export interface NewsletterMilestonePayload {
	message_server_id: string
	newsletter_id: string
	reaction_code: string
	type: string
	value: number
}
export interface NewsletterAdminPromotePayload {
	actor: Actor
	admin: any
	id: string
	user: User
	user_new_role: 'ADMIN' | 'OWNER' | 'GUEST'
}

export interface Actor {
	id: string
	pn: any
}

export interface User {
	id: string
	pn: any
}

export interface NewsletterLeavePayload {
	id: string
	role: 'GUEST'
}
export interface NewsletterJoinPayload {
	id: string
	state: State
	thread_metadata: NewsletterCreatedThreadMetadataPayload
	viewer_metadata: Viewermetadata
}

interface Viewermetadata {
	mute: string
	role: string
	settings: Setting[]
	wamo_sub_status: string
}

interface Setting {
	type: string
	value: string
}

export interface NewsletterCreatedThreadMetadataPayload {
	creation_time: string
	description: Description
	followers_count: string
	handle: null
	image: null
	invite: string
	name: Description
	preview: Preview
	settings: Settings
	subscribers_count: string
	verification: string
	verification_source: null
	wamo_sub: Wamosub
}

interface Wamosub {
	plan_id: null
}

interface Settings {
	reaction_codes: Reactioncodes
}

interface Reactioncodes {
	blocked_codes: null
	enabled_ts_sec: null
	value: 'NONE' | 'ALL' | 'BASIC'
}

interface Preview {
	direct_path: string
	id: string
	type: string
}

interface Description {
	id: string
	text: string
	update_time: string
}

interface State {
	type: string
}

export interface NewsletterMetadataUpdate {
	thread_metadata: {
		description?: Description
		name?: Description
		preview?: Preview
		settings?: Settings
	}
}
