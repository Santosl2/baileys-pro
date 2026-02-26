import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import { UserFacingSocketConfig } from '../Types'
import { makeBusinessSocket } from './business'

// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig) => {
	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config
	}

	return makeBusinessSocket(newConfig)
}

export default makeWASocket
