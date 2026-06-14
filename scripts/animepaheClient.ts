import { fetch } from "scripting"
import { loadSetting, STORAGE_KEYS } from "./storage"
import {
  getStoredCookieHeader,
  handleBlockedResponse,
  hasWebViewSession,
  isChallengePage,
  isLikelyJsonApi,
  shouldShowVerificationSheet,
  shouldTrySilentWebView,
  trySilentWebViewFetch,
  webViewFetch,
} from "./cloudflareBypass"

type PaginationInfo = { lastPage?: number }
type StreamSource = {
  url: string
  resolution?: string
  isDub?: boolean
  isBD?: boolean
  fanSub?: string
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
const JSON_ACCEPT = "application/json, text/javascript, */*; q=0.01"
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

function getBaseUrl(): string {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_BASE_URL, "https://animepahe.pw").replace(/\/$/, "")
}

function getApiBaseUrl(): string {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_API_URL, "").replace(/\/$/, "")
}

function useApiMode(): boolean {
  return getApiBaseUrl().length > 0
}

function directHeaders(sessionId?: string): Record<string, string> {
  const baseUrl = getBaseUrl()
  const headers: Record<string, string> = {
    Accept: JSON_ACCEPT,
    "Accept-Language": "en-US,en;q=0.9",
    DNT: "1",
    "sec-ch-ua": '"Not A(Brand";v="99", "Microsoft Edge";v="121", "Chromium";v="121"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "x-requested-with": "XMLHttpRequest",
    Referer: sessionId ? baseUrl + "/anime/" + sessionId : baseUrl,
    "User-Agent": USER_AGENT,
  }

  const cookies = getStoredCookieHeader()
  if (cookies) headers.Cookie = cookies

  return headers
}

function playPageHeaders(sessionId: string): Record<string, string> {
  const baseUrl = getBaseUrl()
  const headers: Record<string, string> = {
    Accept: HTML_ACCEPT,
    "Accept-Language": "en-US,en;q=0.9",
    Referer: baseUrl + "/anime/" + sessionId,
    "User-Agent": USER_AGENT,
  }

  const cookies = getStoredCookieHeader()
  if (cookies) headers.Cookie = cookies

  return headers
}

async function directFetch(
  requestUrl: string,
  headers: Record<string, string>,
  retried = false,
  expectJson = true
): Promise<string> {
  const accept = headers.Accept || JSON_ACCEPT

  if (hasWebViewSession()) {
    try {
      const body = await webViewFetch(requestUrl, accept)
      if (!isChallengePage(body)) return body
      console.warn("[animepaheClient] WebView session hit challenge page")
    } catch (err) {
      console.warn("[animepaheClient] WebView fetch failed:", err)
    }
  }

  const response = await fetch(requestUrl, { headers })
  const body = await response.text()

  if (response.ok) {
    if (!expectJson || isLikelyJsonApi(body)) return body
    if (!isChallengePage(body)) return body
  }

  if (shouldShowVerificationSheet(response.status, body, expectJson) && !retried) {
    const bypassed = await handleBlockedResponse(getBaseUrl(), response.status, body, retried)
    if (bypassed) {
      if (hasWebViewSession()) return webViewFetch(requestUrl, accept)

      const nextHeaders: Record<string, string> = {}
      for (const key of Object.keys(headers)) {
        nextHeaders[key] = headers[key]
      }
      const cookies = getStoredCookieHeader()
      if (cookies) nextHeaders.Cookie = cookies
      return directFetch(requestUrl, nextHeaders, true, expectJson)
    }
    throw new Error("Animepahe verification failed or was cancelled")
  }

  if (!retried && shouldTrySilentWebView(response.status, body, expectJson)) {
    console.log("[animepaheClient] Trying silent WebView session (no sheet)")
    const silentBody = await trySilentWebViewFetch(requestUrl, accept)
    if (silentBody != null) return silentBody
  }

  if (!response.ok) {
    console.error("[animepaheClient] HTTP", response.status, body.slice(0, 200))
    throw new Error("Animepahe error " + response.status)
  }

  return body
}

async function directGet(requestUrl: string, sessionId?: string) {
  const body = await directFetch(requestUrl, directHeaders(sessionId), false, true)
  return JSON.parse(body)
}

async function apiGet<T>(path: string): Promise<T> {
  const base = getApiBaseUrl()
  const pathPart = path.startsWith("/") ? path : "/" + path
  const requestUrl = base + pathPart
  console.log("[animepaheClient] API GET", requestUrl)

  const response = await fetch(requestUrl, { headers: { Accept: "application/json" } })
  if (!response.ok) {
    const body = await response.text()
    console.error("[animepaheClient] API HTTP", response.status, body.slice(0, 200))
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
    const source = sources[i]
    const tag = buildQualityTag(source)
    if (tag && !dict[tag]) dict[tag] = source.url
  }
  return dict
}
