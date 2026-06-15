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
  paheResourceHeaders,
  saveCookieHeader,
  webViewFetch,
  webViewFetchBinary,
} from "./animepaheSession"

declare const UIImage: {
  fromData(data: any): any | null
  fromFile(filePath: string): any | null
  fromBase64String(base64String: string): any | null
}

const imageCache: Record<string, any> = {}
const imageFileCache: Record<string, string> = {}
const imageInflight: Record<string, Promise<PaheImageLoad | null>> = {}

export type PaheImageLoad =
  | { kind: "ui"; image: any }
  | { kind: "file"; path: string }

declare const FileManager: {
  temporaryDirectory: string
  createDirectory(path: string, recursive?: boolean): Promise<void>
  writeAsData(path: string, data: any): Promise<void>
  exists(path: string): Promise<boolean>
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

function dataToUIImage(data: any): any | null {
  if (!data) return null

  let img = UIImage.fromData(data)
  if (img) return img

  try {
    if (typeof data.toBase64String === "function") {
      img = UIImage.fromBase64String(data.toBase64String())
      if (img) return img
    }
  } catch {
    /* ignore */
  }

  return null
}

async function saveImageToCacheFile(
  url: string,
  data: any,
  mimeType?: string
): Promise<string | null> {
  try {
    const dir = FileManager.temporaryDirectory + "/pahe-images/"
    await FileManager.createDirectory(dir, true)
    const path = dir + hashUrl(url) + imageExtFromUrl(url, mimeType)
    await FileManager.writeAsData(path, data)

    let img = UIImage.fromFile(path)
    if (img) return path

    return path
  } catch (err) {
    console.log("[animepaheClient] Image cache write failed:", err)
    return null
  }
}

function bodyLooksLikeHtml(body: string): boolean {
  const sample = body.slice(0, 200).trim().toLowerCase()
  return sample.indexOf("<!doctype") >= 0 || sample.indexOf("<html") >= 0
}

/** Fetch image bytes with the same session headers as API calls. */
export async function paheFetchImage(url: string): Promise<PaheImageLoad | null> {
  const key = imageCacheKey(url)
  if (!key) return null

  if (imageCache[key]) return { kind: "ui", image: imageCache[key] }
  if (imageFileCache[key]) return { kind: "file", path: imageFileCache[key] }
  if (imageInflight[key]) return imageInflight[key]

  const promise = paheFetchImageInternal(key)
  imageInflight[key] = promise
  try {
    return await promise
  } finally {
    delete imageInflight[key]
  }
}

async function fetchImageBytes(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number; data?: any; mimeType?: string; body?: string }> {
  const response = await fetch(url, { headers })
  mergeResponseCookies(response)

  const mimeType = response.mimeType || ""
  if (!response.ok) {
    const body = await response.text()
    return { ok: false, status: response.status, body: body, mimeType: mimeType }
  }

  if (mimeType.indexOf("text/html") >= 0 || mimeType.indexOf("application/json") >= 0) {
    const body = await response.text()
    return { ok: false, status: response.status, body: body, mimeType: mimeType }
  }

  const data = await response.data()
  return { ok: true, status: response.status, data: data, mimeType: mimeType }
}

async function paheFetchImageInternal(url: string): Promise<PaheImageLoad | null> {
  if (!isPaheProtectedUrl(url)) {
    console.log("[animepaheClient] Image URL not protected:", url.slice(0, 80))
    return null
  }

  await ensureAnimepaheSession()
  const referer = getBaseUrl() + "/"
  const resourceHeaders = paheResourceHeaders(referer)
  const apiStyleHeaders = paheHeaders({ referer: referer, mode: "cors", requestUrl: url })

  if (isWebViewSessionActive()) {
    try {
      const result = await webViewFetchBinary(url, referer, "cors", resourceHeaders)
      if (result.status < 200 || result.status >= 300 || !result.binary) {
        console.log("[animepaheClient] WebView image HTTP", result.status, url.slice(0, 80))
        return null
      }
      if (bodyLooksLikeHtml(result.body)) {
        console.log("[animepaheClient] WebView image got HTML:", url.slice(0, 80))
        return null
      }
      const img = UIImage.fromBase64String(result.body)
      if (img) {
        imageCache[url] = img
        return { kind: "ui", image: img }
      }
      console.log("[animepaheClient] WebView image decode failed:", url.slice(0, 80))
      return null
    } catch (err) {
      console.log("[animepaheClient] WebView image fetch failed:", err)
      return null
    }
  }

  const headerSets = [resourceHeaders, apiStyleHeaders, { Referer: referer, "User-Agent": resourceHeaders["User-Agent"] }]

  for (let i = 0; i < headerSets.length; i++) {
    try {
      const result = await fetchImageBytes(url, headerSets[i])
      if (!result.ok) {
        console.log(
          "[animepaheClient] Image HTTP",
          result.status,
          "try",
          String(i + 1),
          url.slice(0, 80),
          result.body ? result.body.slice(0, 60) : ""
        )
        continue
      }

      const img = dataToUIImage(result.data)
      if (img) {
        imageCache[url] = img
        return { kind: "ui", image: img }
      }

      const path = await saveImageToCacheFile(url, result.data, result.mimeType)
      if (path) {
        imageFileCache[url] = path
        const fileImg = UIImage.fromFile(path)
        if (fileImg) {
          imageCache[url] = fileImg
          return { kind: "ui", image: fileImg }
        }
        return { kind: "file", path: path }
      }
    } catch (err) {
      console.log("[animepaheClient] Image fetch try", String(i + 1), "failed:", err)
    }
  }

  return null
}

export { bootstrapAnimepaheSession, ensureAnimepaheSession, isPaheProtectedUrl, normalizePaheUrl, paheHeaders, paheResourceHeaders }
