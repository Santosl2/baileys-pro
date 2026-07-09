/* eslint-disable max-depth */
import axios, { AxiosRequestConfig } from 'axios'
import { type CheerioAPI } from 'cheerio'
import { CacheStoreWithGeneric, WAMediaUploadFunction, WAUrlInfo } from '../Types'
import { ILogger } from './logger'
import { prepareWAMessageMedia } from './messages'
import { extractImageThumbResized, getHttpStream } from './messages-media'

const THUMBNAIL_WIDTH_PX = 1024

const getCompressedJpegThumbnailAndResizeIfNecessary = async (
	url: string,
	{ thumbnailWidth = 1024, fetchOpts }: URLGenerationOptions
) => {
	const stream = await getHttpStream(url, fetchOpts)
	const result = await extractImageThumbResized(stream, Math.max(1024, thumbnailWidth))
	return result
}

export type URLGenerationOptions = {
	thumbnailWidth: number
	cache?: CacheStoreWithGeneric<LoadOgImageProps | undefined>
	fetchOpts: {
		/** Timeout in ms */
		timeout: number
		proxyUrl?: string
		headers?: AxiosRequestConfig<{}>['headers']
	}
	uploadImage?: WAMediaUploadFunction
	logger?: ILogger
}

export type LoadOgImageProps = {
	title: string | null
	description?: string | null
	images?: string[] | null
	favicon?: string | null
	url: string
}

const getTag = ($: CheerioAPI, name: string) =>
	$(`meta[property="og:${name}"]`).attr('content') ||
	$(`meta[name="og:${name}"]`).attr('content') ||
	$(`meta[name="${name}"]`).attr('content') ||
	null

let cheerio: typeof import('cheerio') | undefined = undefined
async function loadOgImage(
	url: string,
	headers?: AxiosRequestConfig<{}>['headers'],
	logger?: ILogger
): Promise<LoadOgImageProps | undefined> {
	try {
		const request = async (link = url) =>
			axios.get(link, {
				maxRedirects: 21,
				timeout: 20_000,
				headers: {
					...headers,
					// https://github.com/jhy/jsoup/issues/976
					'User-Agent':
						headers?.['User-Agent'] ||
						'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7093.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
				}
			})

		let data = await request()

		const isShopee = new URL(data.request.res.responseUrl).hostname.includes('shopee')

		if (isShopee) {
			data = await request(data.request.res.responseUrl.replace('opaanlp', 'product').replace(/\?.*$/, ''))
		}

		if (!cheerio) {
			cheerio = await import('cheerio')
		}

		// only load the head of the page to avoid loading large images and other resources
		const html = data.data as string
		const head = '</head>'
		const headOnly = html.slice(0, html.indexOf(head) + head.length) || html
		const $ = cheerio.load(headOnly)

		return {
			title: getTag($, 'title') || $('title').text() || null,
			description: getTag($, 'description'),
			images: [getTag($, 'image') || null].filter(Boolean) as string[],
			url: getTag($, 'url') || url,
			favicon: $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || null
		}
	} catch (error) {
		logger?.debug({ err: error.stack, url }, 'error in fetching og image')
		return undefined
	}
}

/**
 * Given a piece of text, checks for any URL present, generates link preview for the same and returns it
 * Return undefined if the fetch failed or no URL was found
 * @param text first matched URL in text
 * @returns the URL info required to generate link preview
 */
export const getUrlInfo = async (
	text: string,
	opts: URLGenerationOptions = {
		cache: undefined,
		thumbnailWidth: THUMBNAIL_WIDTH_PX,
		fetchOpts: { timeout: 3000 }
	}
): Promise<WAUrlInfo | undefined> => {
	try {
		let previewLink = text
		if (!text.startsWith('https://') && !text.startsWith('http://')) {
			previewLink = 'https://' + previewLink
		}

		let cached: LoadOgImageProps | undefined
		if (opts.cache) {
			cached = await opts.cache.get(previewLink)
			if (cached) {
				opts.logger?.debug({ url: previewLink }, 'cache hit for url preview')
			}
		}

		const ogImageFromHttpRequest = !cached
			? await loadOgImage(previewLink, opts.fetchOpts?.headers, opts.logger)
			: undefined

		const info: LoadOgImageProps | undefined = cached || ogImageFromHttpRequest || undefined

		if (info && 'title' in info && info.title) {
			const [image] = info.images && Array.isArray(info.images) ? info.images : []

			const urlInfo: WAUrlInfo = {
				'canonical-url': info.url,
				'matched-text': text,
				title: info.title,
				description: info.description || undefined,
				originalThumbnailUrl: image
			}

			if (opts.cache) {
				opts.logger?.debug({ url: previewLink }, 'caching url preview')
				await opts.cache.set(previewLink, info)
			}

			if (opts.uploadImage) {
				const imageNeedsUpload = await getCompressedJpegThumbnailAndResizeIfNecessary(image, opts)
				const hasPreviousUploaded = 'original' in imageNeedsUpload

				const { imageMessage } = await prepareWAMessageMedia(
					{ image: hasPreviousUploaded ? imageNeedsUpload.buffer : { url: image } },
					{
						upload: opts.uploadImage,
						mediaTypeOverride: 'thumbnail-link',
						options: opts.fetchOpts
					}
				)

				let imageWidth = imageMessage?.width
				let imageHeight = imageMessage?.height
				let compressedThumbnail: Buffer | undefined = hasPreviousUploaded ? imageNeedsUpload.buffer : undefined

				if (!imageWidth || !imageHeight) {
					const ogImageSize = hasPreviousUploaded
						? imageNeedsUpload
						: await getCompressedJpegThumbnailAndResizeIfNecessary(image, opts)
					imageWidth = ogImageSize?.original.width
					imageHeight = ogImageSize?.original.height

					compressedThumbnail = ogImageSize.buffer
				}

				if (!imageMessage?.jpegThumbnail && !compressedThumbnail) {
					compressedThumbnail = (await getCompressedJpegThumbnailAndResizeIfNecessary(image, opts)).buffer
				}

				urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail
					? Buffer.from(imageMessage.jpegThumbnail)
					: compressedThumbnail
				urlInfo.highQualityThumbnail = imageMessage || undefined
				urlInfo.thumbnailWidth = imageWidth
				urlInfo.thumbnailHeight = imageHeight
			} else {
				try {
					// eslint-disable-next-line max-depth
					if (image) {
						const thumb = await getCompressedJpegThumbnailAndResizeIfNecessary(image, opts)
						urlInfo.jpegThumbnail = thumb.buffer
						urlInfo.thumbnailWidth = opts.thumbnailWidth
						urlInfo.thumbnailHeight =
							thumb.original?.width && thumb.original?.height
								? Math.round((opts.thumbnailWidth * thumb.original.height) / thumb.original.width)
								: undefined
					}
				} catch (error) {
					opts.logger?.debug({ err: error.stack, url: previewLink }, 'error in generating thumbnail')
				}
			}

			return urlInfo
		}
	} catch (error) {
		if (!error.message.includes('receive a valid')) {
			throw error
		}
	}
}
