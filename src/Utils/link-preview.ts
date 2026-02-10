import axios, { AxiosRequestConfig } from 'axios'
import { WAMediaUploadFunction, WAUrlInfo } from '../Types'
import { ILogger } from './logger'
import { prepareWAMessageMedia } from './messages'
import { extractImageThumb, getHttpStream } from './messages-media'

const THUMBNAIL_WIDTH_PX = 192

/** Fetches an image and generates a thumbnail for it */
const getCompressedJpegThumbnail = async (url: string, { thumbnailWidth, fetchOpts }: URLGenerationOptions) => {
	const stream = await getHttpStream(url, fetchOpts)
	const result = await extractImageThumb(stream, thumbnailWidth)
	return result
}

export type URLGenerationOptions = {
	thumbnailWidth: number
	fetchOpts: {
		/** Timeout in ms */
		timeout: number
		proxyUrl?: string
		headers?: AxiosRequestConfig<{}>['headers']
	}
	uploadImage?: WAMediaUploadFunction
	logger?: ILogger
}

type LoadOgImageProps = {
	title: string | null
	description?: string | null
	images?: string[] | null
	favicon?: string | null
	url: string
}

async function loadOgImage(url: string, logger?: ILogger): Promise<LoadOgImageProps | undefined> {
	const origin = new URL(url).origin
	try {
		const response = await axios.get(url, {
			maxRedirects: 21,
			headers: {
				'Sec-Ch-Ua': '"Chromium";v="143", "Not(A:Brand";v="99"',
				'Sec-Ch-Ua-Mobile': '?0',
				'Sec-Ch-Ua-Platform': '"Linux"',
				Origin: origin,
				'Accept-Language': 'pt-BR,pt;q=0.9',
				'Upgrade-Insecure-Requests': '1',
				// https://github.com/jhy/jsoup/issues/976
				'User-Agent':
					'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7093.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
				Accept:
					'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
				'Sec-Fetch-Site': 'none',
				'Sec-Fetch-Mode': 'navigate',
				'Sec-Fetch-User': '?1',
				'Sec-Fetch-Dest': 'document',
				'Accept-Encoding': 'gzip, deflate, br',
				Priority: 'u=0, i',
				Cookie:
					'noe_freight=AUTO; noe_hub_shipping_enabled=1; toggle_wishlist=false; show_seller_score_above=5; FCCDCF=1; ml2_redirect_8020=0; FCNEC=1; mixer_shipping=AUTO; mixer_hub_shipping=true; toggle_pdp_seller_score=true; toggle_vwo=true; toggle_agatha=true; toggle_ads=true; toggle_new_service_page=true; toggle_quick_click=false; enable_fallback_banner=0; toggle_new_service_page_spa=false; toggle_header_trends=false; toggle_trending_showcase=false; toggle_header_basket_counter=true; __uzma=caa90eda-5c89-4888-b986-eaccacb63dfd; __uzmb=1761942405; __uzme=2334; basket_abtest=B; MLPARCEIRO=0; __ssds=3; __rtbh.lid=%7B%22eventType%22%3A%22lid%22%2C%22id%22%3A%22jsVEisdAHUV5Q9Fq99O9%22%2C%22expiryDate%22%3A%222026-10-31T20%3A26%3A46.866Z%22%7D; __spdt=570e6652509b45619b61beae0eb82bf3; _vwo_uuid_v2=DDD5DC4E315256A648EC7067D21872244|2d2cfb5ee8a41555fa9f0b7b09184c30; __ssuzjsr3=a9be0cd8e; __uzmaj3=5665fd92-010b-435a-bc34-1168571fc7df; __uzmbj3=1761942406; __uzmcj3=269931052254; __uzmdj3=1761942406; _gcl_au=1.1.563685780.1761942407; ml_tid=0a845434-1d95-489d-bbee-bb0ef1d77946; stwu=temp_46b9ef2e-85a5-4f5c-bf2c-a2151346ea77; stwt=1; __bid=7761d1c9-d13b-467a-919a-9c49a0c32299; __rtbh.uid=%7B%22eventType%22%3A%22uid%22%2C%22id%22%3A%22unknown%22%2C%22expiryDate%22%3A%222026-10-31T20%3A26%3A48.844Z%22%7D; page_before_login=selecao; _uetsid=ed7351c0b69711f087b3d957c92135ee; _uetvid=ed73b290b69711f09a224f05b104d456; _azfp_sc=7ddc9f3f46955fd2a7d80af36847ee3e314d650ed3018d0d50ca4e81f1c5c2ad; _tt_enable_cookie=1; _ttp=01K8XZ73SEDPNM4MQWYR9A620Y_.tt.2; _vwo_uuid=DDD5DC4E315256A648EC7067D21872244; _vwo_ds=3%241761942406%3A96.34944662%3A%3A%3A%3A%3A1761942406%3A1761942406; _vis_opt_s=1%7C; _vis_opt_test_cookie=1; toggle_offer_timer=true; toggle_enable_product_review=true; __uzmc=975031392247; __uzmd=1761942409; ttcsid=1761942409014::VaDzs1XAjzx-nQhQTHkj.1.1761942409422.0; ttcsid_C1I87V1T0U322RQPSRKG=1761942409012::ne27gtH35q5Gf64EGgUU.1.1761942409423.0; _fbp=fb.2.1761942409554.101811968431619875; cto_bundle=5pTIYl9FSU8xQnA4bzVnRjFNQVBwQmc1MzNobW40VGxaclRHbXpaZHlQRklNJTJGUHBKVGVzWEFMMmVKJTJCUEhzUmxXcUx6S1VtMXRzVWNFY1lSUVprNU42djN4QWJSNWZ6VTRXSE9YNU43M1h2ZTBKTUxTNzhhNGlKN0slMkYwaUhhcWlLMFNjaHd5NVhxcHQ0NldzTDB3d1ppa1Rua2tFMG82RmFGbk5RMmp5TmYlMkJDUm4zdyUzRA; _pin_unauth=dWlkPU5EWXpOell5TkRFdE5qSTVPQzAwT1RWa0xUaGlaakF0TXprMVlqaGxaamxrWmpjMA; _clck=1uacbkv%5E2%5Eg0m%5E0%5E2130; _ga=GA1.1.2056094211.1761942410; _ga_LCJ5VBTH8V=GS2.1.s1761942409$o1$g0$t1761942410$j59$l0$h0; _clsk=10jaabb%5E1761942410894%5E1%5E0%5Ei.clarity.ms%2Fcollect; _dd_s=rum=0&expire=1761943307056; _vwo_sn=0%3A1%3A%3A%3A%3A%3A25'
			}
		})

		const cheerio = await import('cheerio')
		const $ = cheerio.load(response.data)

		const get = (name: string) =>
			$(`meta[property="og:${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content') || null

		return {
			title: get('title') || $('title').text() || null,
			description: get('description'),
			images: [get('image') || null].filter(Boolean) as string[],
			url: get('url') || url,
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
		thumbnailWidth: THUMBNAIL_WIDTH_PX,
		fetchOpts: { timeout: 3000 }
	}
): Promise<WAUrlInfo | undefined> => {
	try {
		// retries
		const retries = 0
		const maxRetry = 5

		const { getLinkPreview } = await import('link-preview-js')
		let previewLink = text
		if (!text.startsWith('https://') && !text.startsWith('http://')) {
			previewLink = 'https://' + previewLink
		}

		const ogImageFromHttpRequest = await loadOgImage(previewLink, opts.logger)
		let info: Awaited<ReturnType<typeof getLinkPreview>> | LoadOgImageProps | undefined =
			ogImageFromHttpRequest || undefined

		if (!info) {
			info = await getLinkPreview(previewLink, {
				...opts.fetchOpts,
				followRedirects: 'follow',
				imagesPropertyType: 'og',
				handleRedirects: (baseURL: string, forwardedURL: string) => {
					const urlObj = new URL(baseURL)
					const forwardedURLObj = new URL(forwardedURL)
					if (retries >= maxRetry) {
						return false
					}

					if (
						forwardedURLObj.hostname === urlObj.hostname ||
						forwardedURLObj.hostname === 'www.' + urlObj.hostname ||
						'www.' + forwardedURLObj.hostname === urlObj.hostname
					) {
						retries + 1
						return true
					} else {
						return false
					}
				},
				headers: opts.fetchOpts as {}
			})
		}

		if (info && 'title' in info && info.title) {
			const [image] = info.images && Array.isArray(info.images) ? info.images : []

			const urlInfo: WAUrlInfo = {
				'canonical-url': info.url,
				'matched-text': text,
				title: info.title,
				description: info.description || undefined,
				originalThumbnailUrl: image
			}

			if (opts.uploadImage) {
				const { imageMessage } = await prepareWAMessageMedia(
					{ image: { url: image } },
					{
						upload: opts.uploadImage,
						mediaTypeOverride: 'thumbnail-link',
						options: opts.fetchOpts
					}
				)
				urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail
					? Buffer.from(imageMessage.jpegThumbnail)
					: (await getCompressedJpegThumbnail(image, opts)).buffer
				urlInfo.highQualityThumbnail = imageMessage || undefined
			} else {
				try {
					urlInfo.jpegThumbnail = image ? (await getCompressedJpegThumbnail(image, opts)).buffer : undefined
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
