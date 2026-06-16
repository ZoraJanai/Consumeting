import { fetch } from "scripting"
import { loadSetting, STORAGE_KEYS } from "./storage"
import {
  apiHeaders,
  bootstrapAnimepaheSession,
  ensureAnimepaheSession,
  getBaseUrl,
  getStoredCookieHeader,
  isChallengePage,
  isLikelyJsonApi,
  isPaheProtectedUrl,
  isWebViewSessionActive,
  mergeCookieHeaders,
  normalizePaheUrl,
  paheHeaders,
  playPageHeaders,
  paheImageHeaders,
  paheNavigateImageHeaders,
  paheAnimeReferer,
  paheResourceHeaders,
  saveCookieHeader,
  webViewFetch,
  webViewLoadImage,
} from "./animepaheSession"

declare const UIImage: {
  fromData(data: any): any | null
  fromFile(filePath: string): any | null
  fromBase64String(base64String: string): any | null
}

declare const Data: {
  fromUint8Array(bytes: Uint8Array): any | null
  fromBase64String(base64: string): any | null
  fromFile(filePath: string): any | null
}

declare const FileManager: {
  documentsDirectory: string
  temporaryDirectory: string
  createDirectory(path: string, recursive?: boolean): Promise<void>
  writeAsData(path: string, data: any): Promise<void>
  writeAsBytes(path: string, bytes: Uint8Array): Promise<void>
  exists(path: string): Promise<boolean>
}

function logPaheImage(phase: string, message: string, extra?: string) {
  const line = "[paheImage] " + phase + ": " + message + (extra ? " | " + extra : "")
  console.log(line)
}

function headerSummary(headers: Record<string, string>): string {
  const keys = Object.keys(headers)
  let summary = keys.join(", ")
  if (headers.Cookie) summary += " cookieLen=" + String(headers.Cookie.length)
  else summary += " no-cookie"
  if (headers["Sec-Fetch-Site"]) summary += " site=" + headers["Sec-Fetch-Site"]
  if (headers.Referer) summary += " ref=" + headers.Referer.slice(0, 60)
  return summary
}

function hasUIImage(): boolean {
  try {
    return typeof UIImage !== "undefined" && !!UIImage.fromData
  } catch {
    return false
  }
}

function bytesPreview(bytes: Uint8Array): string {
  if (!bytes || !bytes.length) return "empty"
  const n = Math.min(bytes.length, 8)
  let hex = ""
  for (let i = 0; i < n; i++) {
    const h = bytes[i].toString(16)
    hex += (h.length < 2 ? "0" : "") + h + " "
  }
  return "len=" + String(bytes.length) + " head=" + hex.trim()
}

function bytesLookLikeImage(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 4) return false
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return true
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return true
  return false
}

function bytesToTextPreview(bytes: Uint8Array, max = 120): string {
  const n = Math.min(bytes.length, max)
  let text = ""
  for (let i = 0; i < n; i++) {
    const c = bytes[i]
    text += c >= 32 && c < 127 ? String.fromCharCode(c) : "."
  }
  return text
}

const imageCache: Record<string, any> = {}
const imageFileCache: Record<string, string> = {}
const imageDataUrlCache: Record<string, string> = {}
const imageInflight: Record<string, Promise<PaheImageLoad | null>> = {}

export function isLocalPosterPath(url: string): boolean {
  if (!url) return false
  if (url.indexOf("data:") === 0) return false
  return url.indexOf("http") !== 0 && url.indexOf("//") !== 0
}

function posterCacheDir(): string {
  return FileManager.documentsDirectory + "/Consumeting/posters/"
}

function posterDiskPath(url: string, mimeType?: string): string {
  return posterCacheDir() + hashUrl(url) + imageExtFromUrl(url, mimeType)
}

async function getPosterDiskPath(url: string): Promise<string | null> {
  const key = imageCacheKey(url)
  if (!key || isLocalPosterPath(key)) return isLocalPosterPath(key) ? key : null
  const path = posterDiskPath(key)
  try {
    if (await FileManager.exists(path)) {
      imageFileCache[key] = path
      return path
    }
  } catch {
    /* ignore */
  }
  return null
}

export type PaheImageLoad =
  | { kind: "ui"; image: any }
  | { kind: "file"; path: string }
  | { kind: "dataUrl"; url: string }

type ImageFetchResult = {
  ok: boolean
  status: number
  mimeType?: string
  data?: any
  bytes?: Uint8Array
  body?: string
  challenge?: boolean
  dataUrl?: string
}

type PaginationInfo = { lastPage?: number }

type StreamSource = {
  url: string
  resolution?: string
  isDub?: boolean
  isBD?: boolean
  fanSub?: string
}

function getApiBaseUrl(): string {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_API_URL, "").replace(/\/$/, "")
}

function useApiMode(): boolean {
  return getApiBaseUrl().length > 0
}

async function directFetch(
  requestUrl: string,
  headers: Record<string, string>,
  retried = false,
  expectJson = true
): Promise<string> {
  await ensureAnimepaheSession()

  if (isWebViewSessionActive()) {
    const referer = headers.Referer || getBaseUrl() + "/"
    const fetchMode = expectJson ? "cors" : "navigate"
    const result = await webViewFetch(requestUrl, referer, fetchMode)
    const body = result.body

    if (result.status >= 200 && result.status < 300) {
      if (!expectJson || isLikelyJsonApi(body)) return body
      if (!isChallengePage(body)) return body
    }

    if (!retried && (result.status === 403 || result.status === 503 || isChallengePage(body))) {
      console.log("[animepaheClient] WebView session expired, re-bootstrapping")
      await bootstrapAnimepaheSession()
      return directFetch(requestUrl, headers, true, expectJson)
    }

    if (result.status < 200 || result.status >= 300) {
      console.error("[animepaheClient] WebView HTTP", result.status, body.slice(0, 200))
      throw new Error("Animepahe error " + result.status)
    }

    return body
  }

  const response = await fetch(requestUrl, { headers })
  const body = await response.text()

  mergeResponseCookies(response)

  if (response.ok) {
    if (!expectJson || isLikelyJsonApi(body)) return body
    if (!isChallengePage(body)) return body
  }

  if (!retried && (response.status === 403 || response.status === 503 || isChallengePage(body))) {
    console.log("[animepaheClient] Session expired, re-bootstrapping")
    await bootstrapAnimepaheSession()
    const nextHeaders: Record<string, string> = {}
    for (const key of Object.keys(headers)) {
      nextHeaders[key] = headers[key]
    }
    const cookies = getStoredCookieHeader()
    if (cookies) nextHeaders.Cookie = cookies
    return directFetch(requestUrl, nextHeaders, true, expectJson)
  }

  if (!response.ok) {
    console.error("[animepaheClient] HTTP", response.status, body.slice(0, 200))
    throw new Error("Animepahe error " + response.status)
  }

  return body
}

async function directGet(requestUrl: string, sessionId?: string) {
  const body = await directFetch(requestUrl, apiHeaders(sessionId), false, true)
  return JSON.parse(body)
}

async function apiGet<T>(path: string): Promise<T> {
  const base = getApiBaseUrl()
  const pathPart = path.startsWith("/") ? path : "/" + path
  const requestUrl = base + pathPart

  const response = await fetch(requestUrl, { headers: { Accept: "application/json" } })
  if (!response.ok) {
    throw new Error("Animepahe API error " + response.status)
  }
  return response.json()
}

export function buildQualityTag(source: StreamSource): string | null {
  if (source.isDub || !source.url) return null

  const resolution = source.resolution || "default"
  const resTag = resolution === "default" ? "default" : resolution + "p"

  if (source.isBD) return "-" + resTag + " BD"
  if (source.fanSub && source.fanSub.toLowerCase().includes("chi")) return "-" + resTag + " chi"
  return "-" + resTag
}

function cleanSearchQuery(query: string): string {
  return query.replace(/[^a-zA-Z0-9\s\u0080-\uFFFF]/g, "").trim()
}

export async function paheSearch(
  query: string
): Promise<{ title: string; session: string; poster: string }[]> {
  const cleanQuery = cleanSearchQuery(query)
  const encodedQuery = encodeURIComponent(cleanQuery)

  if (useApiMode()) {
    const data = await apiGet<{ data: { title: string; session: string; poster: string }[] }>(
      "/api/search?q=" + encodedQuery
    )
    return data.data ?? []
  }

  const baseUrl = getBaseUrl()
  const searchUrl = baseUrl + "/api?m=search&q=" + encodedQuery
  const data = await directGet(searchUrl)
  return (data.data ?? []).map(function (item: any) {
    return {
      title: item.title,
      session: item.session,
      poster: item.poster,
    }
  })
}

export async function paheFetchEpisodesPage(
  session: string,
  page: number
): Promise<{ episodes: { id: string; number: number }[]; lastPage: number }> {
  if (useApiMode()) {
    const data = await apiGet<{
      data: { episode: number; session: string }[]
      paginationInfo?: PaginationInfo
    }>("/api/" + encodeURIComponent(session) + "/releases?sort=episode_asc&page=" + String(page))

    return {
      episodes: (data.data ?? []).map(function (item) {
        return {
          id: session + "/" + item.session,
          number: item.episode,
        }
      }),
      lastPage: data.paginationInfo?.lastPage ?? 1,
    }
  }

  const baseUrl = getBaseUrl()
  const releasesUrl =
    baseUrl +
    "/api?m=release&id=" +
    encodeURIComponent(session) +
    "&sort=episode_asc&page=" +
    String(page)
  const data = await directGet(releasesUrl, session)

  return {
    episodes: (data.data ?? []).map(function (item: any) {
      return {
        id: session + "/" + item.session,
        number: item.episode,
      }
    }),
    lastPage: data.last_page ?? 1,
  }
}

export async function paheFetchAllEpisodes(session: string) {
  const firstPage = await paheFetchEpisodesPage(session, 1)
  const allEpisodes = firstPage.episodes.slice()

  for (let page = 2; page <= firstPage.lastPage; page++) {
    const pageData = await paheFetchEpisodesPage(session, page)
    for (let i = 0; i < pageData.episodes.length; i++) {
      allEpisodes.push(pageData.episodes[i])
    }
  }

  return allEpisodes.filter(function (ep) {
    const num = Number(ep.number)
    return Math.ceil(num) === num && num !== 0
  })
}

export async function directFetchPlayPage(episodeId: string): Promise<string> {
  const baseUrl = getBaseUrl()
  const animeSession = episodeId.split("/")[0]
  const playUrl = baseUrl + "/play/" + episodeId
  return directFetch(playUrl, playPageHeaders(animeSession), false, false)
}

export function getDirectBaseUrl(): string {
  return getBaseUrl()
}

export async function paheFetchStreamingSourcesFromApi(
  episodeId: string
): Promise<Record<string, string>> {
  const parts = episodeId.split("/")
  const animeSession = parts[0]
  const episodeSession = parts[1]
  if (!animeSession || !episodeSession) {
    throw new Error("Invalid episode id: " + episodeId)
  }

  const data = await apiGet<{ sources?: StreamSource[] }>(
    "/api/play/" +
      encodeURIComponent(animeSession) +
      "?episodeId=" +
      encodeURIComponent(episodeSession) +
      "&downloads=false"
  )

  const dict: Record<string, string> = {}
  const sources = data.sources ?? []
  for (let i = 0; i < sources.length; i++) {
    const tag = buildQualityTag(sources[i])
    if (tag && !dict[tag]) dict[tag] = sources[i].url
  }
  return dict
}

function mergeResponseCookies(response: any) {
  if (!response.cookies || !response.cookies.length) return

  const parts: string[] = []
  for (let i = 0; i < response.cookies.length; i++) {
    parts.push(response.cookies[i].name + "=" + response.cookies[i].value)
  }
  const incoming = parts.join("; ")
  if (incoming) {
    saveCookieHeader(mergeCookieHeaders(getStoredCookieHeader(), incoming))
  }
}

function imageCacheKey(url: string): string {
  return normalizePaheUrl(url)
}

function imageExtFromUrl(url: string, mimeType?: string): string {
  const lower = url.toLowerCase()
  if (lower.indexOf(".png") >= 0) return ".png"
  if (lower.indexOf(".webp") >= 0) return ".webp"
  if (lower.indexOf(".gif") >= 0) return ".gif"
  if (mimeType) {
    if (mimeType.indexOf("png") >= 0) return ".png"
    if (mimeType.indexOf("webp") >= 0) return ".webp"
    if (mimeType.indexOf("gif") >= 0) return ".gif"
  }
  return ".jpg"
}

function hashUrl(url: string): string {
  let hash = 0
  for (let i = 0; i < url.length; i++) {
    hash = (hash * 31 + url.charCodeAt(i)) | 0
  }
  return String(hash >>> 0)
}

function imageSizeLabel(img: any): string {
  if (!img) return ""
  const w = img.width ? String(img.width) : "?"
  const h = img.height ? String(img.height) : "?"
  return w + "x" + h
}

/** UIImage only decodes PNG/JPEG — animepahe posters are usually WebP. */
function isUiImageFormat(url: string, mimeType?: string): boolean {
  const lower = url.toLowerCase()
  if (lower.indexOf(".webp") >= 0 || lower.indexOf(".gif") >= 0 || lower.indexOf(".avif") >= 0) {
    return false
  }
  if (mimeType) {
    const m = mimeType.toLowerCase()
    if (m.indexOf("webp") >= 0 || m.indexOf("gif") >= 0 || m.indexOf("avif") >= 0) return false
  }
  return true
}

async function readImageBody(response: any): Promise<{ data: any | null; bytes: Uint8Array | null }> {
  let data: any = null
  let bytes: Uint8Array | null = null

  try {
    if (response.data) {
      data = await response.data()
      if (data && typeof data.toUint8Array === "function") {
        bytes = data.toUint8Array()
      }
    }
  } catch (err) {
    logPaheImage("read", "response.data() failed", String(err))
  }

  if (!bytes) {
    try {
      if (response.bytes) {
        bytes = await response.bytes()
        if (bytes && !data && typeof Data !== "undefined" && Data.fromUint8Array) {
          data = Data.fromUint8Array(bytes)
        }
      }
    } catch (err) {
      logPaheImage("read", "response.bytes() failed", String(err))
    }
  }

  return { data: data, bytes: bytes }
}

async function saveImageDataToCache(url: string, data: any, bytes: Uint8Array | null, mimeType?: string): Promise<string | null> {
  try {
    const dir = posterCacheDir()
    await FileManager.createDirectory(dir, true)
    const path = posterDiskPath(url, mimeType)

    if (data) {
      await FileManager.writeAsData(path, data)
      logPaheImage("cache", "writeAsData ok", path)
      return path
    }
    if (bytes) {
      await FileManager.writeAsBytes(path, bytes)
      logPaheImage("cache", "writeAsBytes ok", path)
      return path
    }
  } catch (err) {
    logPaheImage("cache", "save failed", String(err))
  }
  return null
}

function mimeFromUrl(url: string, mimeType?: string): string {
  if (mimeType && mimeType.indexOf("image") >= 0) return mimeType
  const lower = url.toLowerCase()
  if (lower.indexOf(".webp") >= 0) return "image/webp"
  if (lower.indexOf(".png") >= 0) return "image/png"
  if (lower.indexOf(".gif") >= 0) return "image/gif"
  return "image/jpeg"
}

function bytesToDataUrl(bytes: Uint8Array, url: string, mimeType?: string): string | null {
  const mime = mimeFromUrl(url, mimeType)
  try {
    if (typeof Data !== "undefined" && Data.fromUint8Array) {
      const data = Data.fromUint8Array(bytes)
      if (data && typeof data.toBase64String === "function") {
        return "data:" + mime + ";base64," + data.toBase64String()
      }
    }
  } catch (err) {
    logPaheImage("decode", "bytesToDataUrl failed", String(err))
  }
  return null
}

async function filePathToDataUrl(path: string, url: string): Promise<string | null> {
  try {
    if (typeof Data !== "undefined" && Data.fromFile) {
      const data = Data.fromFile(path)
      const bytes = data && typeof data.toUint8Array === "function" ? data.toUint8Array() : null
      if (bytes) return bytesToDataUrl(bytes, url)
    }
  } catch (err) {
    logPaheImage("decode", "filePathToDataUrl failed", String(err))
  }
  return null
}

async function decodeImageDataToLoad(
  url: string,
  data: any,
  bytes: Uint8Array | null,
  mimeType?: string
): Promise<PaheImageLoad | null> {
  const rawBytes =
    bytes || (data && typeof data.toUint8Array === "function" ? data.toUint8Array() : null)
  if (!rawBytes || !rawBytes.length) {
    logPaheImage("decode", "no bytes to decode")
    return null
  }

  const dataUrl = bytesToDataUrl(rawBytes, url, mimeType)
  if (dataUrl) {
    imageDataUrlCache[url] = dataUrl
    logPaheImage("decode", "data URL ok", "len=" + String(dataUrl.length))
    return { kind: "dataUrl", url: dataUrl }
  }

  const path = await saveImageDataToCache(url, data, rawBytes, mimeType)
  if (!path) return null

  const useUi = isUiImageFormat(url, mimeType)
  if (useUi && hasUIImage() && data) {
    try {
      const img = UIImage.fromData(data)
      if (img) {
        logPaheImage("decode", "UIImage.fromData ok", imageSizeLabel(img))
        return { kind: "ui", image: img }
      }
    } catch (err) {
      logPaheImage("decode", "UIImage.fromData threw", String(err))
    }
  }

  logPaheImage("decode", "filePath fallback", path)
  return { kind: "file", path: path }
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    if (typeof atob === "undefined") return null
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i)
    }
    return bytes
  } catch (err) {
    logPaheImage("decode", "base64ToBytes failed", String(err))
    return null
  }
}

/** Posters on i.animepahe.* need Referer + cookies — plain Image imageUrl cannot send them. */
export function needsPosterAuthFetch(url: string): boolean {
  if (!url || url.indexOf("http") !== 0) return false
  if (url.indexOf("data:image") === 0) return false
  const lower = url.toLowerCase()
  if (lower.indexOf("anilist.co") >= 0 || lower.indexOf("ibb.co") >= 0) return false
  return true
}

function bodyLooksLikeHtml(body: string): boolean {
  const sample = body.slice(0, 200).trim().toLowerCase()
  return sample.indexOf("<!doctype") >= 0 || sample.indexOf("<html") >= 0
}

/** Fetch image bytes with session headers; caches WebP to disk for cache/queue/search. */
export async function paheFetchImage(
  url: string,
  opts?: { animeSession?: string }
): Promise<PaheImageLoad | null> {
  if (isLocalPosterPath(url)) {
    logPaheImage("local", "using saved path", url)
    return { kind: "file", path: url }
  }
  if (url.indexOf("data:image") === 0) {
    logPaheImage("local", "using data URL", "len=" + String(url.length))
    return { kind: "dataUrl", url: url }
  }

  const key = imageCacheKey(url)
  logPaheImage(
    "start",
    "raw=" + String(url),
    "normalized=" + String(key) + " session=" + String(opts?.animeSession || "")
  )

  if (!key) {
    logPaheImage("abort", "empty url after normalize")
    return null
  }

  if (imageCache[key]) {
    logPaheImage("cache-hit", "ui image")
    return { kind: "ui", image: imageCache[key] }
  }
  if (imageDataUrlCache[key]) {
    logPaheImage("cache-hit", "dataUrl len=" + String(imageDataUrlCache[key].length))
    return { kind: "dataUrl", url: imageDataUrlCache[key] }
  }
  if (imageFileCache[key]) {
    logPaheImage("cache-hit", "file " + imageFileCache[key])
    return { kind: "file", path: imageFileCache[key] }
  }

  const diskPath = await getPosterDiskPath(key)
  if (diskPath) {
    const cachedUrl = await filePathToDataUrl(diskPath, key)
    if (cachedUrl) {
      imageDataUrlCache[key] = cachedUrl
      logPaheImage("disk-hit", "dataUrl from " + diskPath)
      return { kind: "dataUrl", url: cachedUrl }
    }
    logPaheImage("disk-hit", diskPath)
    return { kind: "file", path: diskPath }
  }

  if (imageInflight[key]) {
    logPaheImage("queue", "waiting for in-flight fetch")
    return imageInflight[key]
  }

  const promise = paheFetchImageInternal(key, opts)
  imageInflight[key] = promise
  try {
    const result = await promise
    if (result) {
      logPaheImage("done", "success kind=" + result.kind, key.slice(0, 80))
    } else {
      logPaheImage("done", "failed all attempts", key.slice(0, 80))
    }
    return result
  } finally {
    delete imageInflight[key]
  }
}

async function fetchImageWithHeaders(
  url: string,
  headers: Record<string, string>,
  label: string
): Promise<ImageFetchResult> {
  logPaheImage("fetch", label, url.slice(0, 100))
  logPaheImage("headers", label, headerSummary(headers))

  try {
    const response = await fetch(url, { headers: headers, debugLabel: "pahe-image" })
    mergeResponseCookies(response)

    const mimeType = response.mimeType || ""
    const status = response.status
    logPaheImage(
      "response",
      label,
      "status=" + String(status) + " mime=" + (mimeType || "(none)") + " len=" + String(response.expectedContentLength || 0)
    )

    if (!response.ok) {
      const body = await response.text()
      logPaheImage("response", label + " error body", body.slice(0, 120))
      return {
        ok: false,
        status: status,
        mimeType: mimeType,
        body: body,
        challenge: isChallengePage(body),
      }
    }

    const body = await readImageBody(response)
    const bytes = body.bytes
    if (!bytes || !bytes.length) {
      logPaheImage("response", label + " empty body", "")
      return { ok: false, status: status, mimeType: mimeType, body: "empty body" }
    }

    logPaheImage("response", label + " bytes", bytesPreview(bytes))

    if (!bytesLookLikeImage(bytes)) {
      const preview = bytesToTextPreview(bytes)
      logPaheImage("response", label + " not image bytes", preview)
      return {
        ok: false,
        status: status,
        mimeType: mimeType,
        body: preview,
        challenge: bodyLooksLikeHtml(preview) || isChallengePage(preview),
      }
    }

    return { ok: true, status: status, mimeType: mimeType, data: body.data, bytes: bytes }
  } catch (err) {
    logPaheImage("fetch", label + " threw", String(err))
    return { ok: false, status: 0, body: String(err) }
  }
}

async function fetchImageViaWebView(url: string): Promise<ImageFetchResult> {
  logPaheImage("webview", "img element load", url.slice(0, 100))
  try {
    const result = await webViewLoadImage(url)
    logPaheImage(
      "webview",
      "status=" + String(result.status),
      "dataUrl=" + String(!!result.dataUrl) + " bodyLen=" + String(result.body ? result.body.length : 0)
    )
    if (result.status < 200 || result.status >= 300 || !result.body) {
      return {
        ok: false,
        status: result.status,
        body: result.body ? result.body.slice(0, 120) : "",
        challenge: result.body ? isChallengePage(result.body) : false,
      }
    }

    if (result.dataUrl && result.body.indexOf("data:image") === 0) {
      return { ok: true, status: result.status, dataUrl: result.body }
    }

    logPaheImage("webview", "unexpected img response", result.body.slice(0, 80))
    return { ok: false, status: result.status, body: "unexpected img response" }
  } catch (err) {
    logPaheImage("webview", "img load threw", String(err))
    return { ok: false, status: 0, body: String(err) }
  }
}

async function resultToImageLoad(url: string, result: ImageFetchResult): Promise<PaheImageLoad | null> {
  if (!result.ok) return null
  if (result.dataUrl) {
    imageDataUrlCache[url] = result.dataUrl
    logPaheImage("decode", "webview dataUrl ok", "len=" + String(result.dataUrl.length))
    return { kind: "dataUrl", url: result.dataUrl }
  }
  if (!result.bytes) return null
  return decodeImageDataToLoad(url, result.data, result.bytes, result.mimeType)
}

async function paheFetchImageInternal(
  url: string,
  opts?: { animeSession?: string },
  retried = false
): Promise<PaheImageLoad | null> {
  const lower = url.toLowerCase()
  if (
    !url ||
    isLocalPosterPath(url) ||
    url.indexOf("http") !== 0 ||
    lower.indexOf("anilist.co") >= 0 ||
    lower.indexOf("graphql.anilist") >= 0 ||
    lower.indexOf("ibb.co") >= 0
  ) {
    logPaheImage("abort", "URL skipped", url)
    return null
  }

  await ensureAnimepaheSession()

  const headers = paheNavigateImageHeaders()
  logPaheImage(
    "session",
    "webview=" + String(isWebViewSessionActive()) +
      " cookieLen=" + String(getStoredCookieHeader().length),
    headerSummary(headers)
  )

  let result: ImageFetchResult

  if (isWebViewSessionActive()) {
    result = await fetchImageViaWebView(url)
  } else {
    result = await fetchImageWithHeaders(url, headers, "navigate")
  }

  if (!result.ok && !retried && isWebViewSessionActive()) {
    logPaheImage("retry", "img load retry", url.slice(0, 80))
    return paheFetchImageInternal(url, opts, true)
  }

  if (!result.ok) {
    logPaheImage("fail", "fetch failed", "status=" + String(result.status) + " " + String(result.body || "").slice(0, 80))
    return null
  }

  const load = await resultToImageLoad(url, result)
  if (load) {
    if (load.kind === "ui") imageCache[url] = load.image
    if (load.kind === "file") imageFileCache[url] = load.path
    if (load.kind === "dataUrl") imageDataUrlCache[url] = load.url
  } else {
    logPaheImage("fail", "decode failed", url.slice(0, 80))
  }
  return load
}

/** Download poster to disk and replace img with local path (for cache/queue). */
export async function cachePosterForAnime<T extends { img?: string; id?: string; source?: string }>(
  anime: T
): Promise<T> {
  const url = anime.img
  if (!url || isLocalPosterPath(url) || url.indexOf("http") !== 0) return anime
  const session = anime.id || anime.source
  const loaded = await paheFetchImage(url, { animeSession: session })
  if (loaded && loaded.kind === "dataUrl") {
    return { ...anime, img: loaded.url }
  }
  if (loaded && loaded.kind === "file") {
    return { ...anime, img: loaded.path }
  }
  return anime
}

/** Prefetch posters (WebView fetches share the same JS queue as API calls). */
export async function prefetchPahePosters(
  items: { url: string; session?: string }[]
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item.url || isLocalPosterPath(item.url) || item.url.indexOf("http") !== 0) continue
    await paheFetchImage(item.url, { animeSession: item.session })
  }
}

export { bootstrapAnimepaheSession, ensureAnimepaheSession, isPaheProtectedUrl, normalizePaheUrl, paheHeaders, paheImageHeaders, paheNavigateImageHeaders, paheAnimeReferer, paheResourceHeaders }
