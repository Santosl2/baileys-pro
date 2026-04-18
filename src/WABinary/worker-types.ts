import type { BinaryNode } from './types'

export type BinaryCodecTask =
	| {
			id: number
			type: 'encode'
			node: BinaryNode
	  }
	| {
			id: number
			type: 'decode'
			buffer: Buffer
	  }
	| {
			id: number
			type: 'decompress'
			buffer: Buffer
	  }
	| {
			id: number
			type: 'decode-decompressed'
			buffer: Buffer
	  }

export type BinaryCodecSuccess =
	| {
			id: number
			type: 'encode'
			result: Buffer
	  }
	| {
			id: number
			type: 'decode'
			result: BinaryNode
	  }
	| {
			id: number
			type: 'decompress'
			result: Buffer
	  }
	| {
			id: number
			type: 'decode-decompressed'
			result: BinaryNode
	  }

export type BinaryCodecFailure = {
	id: number
	error: {
		message: string
		stack?: string
	}
}

export type BinaryCodecResponse = BinaryCodecSuccess | BinaryCodecFailure

export type BinaryCodecTaskInput =
	| {
			type: 'encode'
			node: BinaryNode
	  }
	| {
			type: 'decode'
			buffer: Buffer
	  }
	| {
			type: 'decompress'
			buffer: Buffer
	  }
	| {
			type: 'decode-decompressed'
			buffer: Buffer
	  }
