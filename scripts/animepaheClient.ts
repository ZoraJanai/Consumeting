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
  mergeCookieHeaders,
  playPageHeaders,
  saveCookieHeader,
} from "./animepaheSession"

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

  const response = await fetch(requestUrl, { headers })
  const body = await response.text()

  if (response.cookies && response.cookies.length) {
    const parts: string[] = []
    for (let i = 0; i < response.cookies.length; i++) {
      parts.push(response.cookies[i].name + "=" + response.cookies[i].value)
    }
    const incoming = parts.join("; ")
    if (incoming) {
      saveCookieHeader(mergeCookieHeaders(getStoredCookieHeader(), incoming))
    }
  }

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

export { bootstrapAnimepaheSession, ensureAnimepaheSession }
