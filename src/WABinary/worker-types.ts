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
			buffer: ArrayBuffer
	  }
	| {
			id: number
			type: 'decompress'
			buffer: ArrayBuffer
	  }
	| {
			id: number
			type: 'decode-decompressed'
			buffer: ArrayBuffer
	  }

export type BinaryCodecSuccess =
	| {
			id: number
			type: 'encode'
			result: ArrayBuffer
	  }
	| {
			id: number
			type: 'decode'
			result: BinaryNode
	  }
	| {
			id: number
			type: 'decompress'
			result: ArrayBuffer
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
