import { fetch } from "scripting"
import { loadSetting, STORAGE_KEYS } from "./storage"
import {
  getStoredCookieHeader,
  handleBlockedResponse,
  isBlockedResponse,
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
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    DNT: "1",
    "sec-ch-ua": '"Not A(Brand";v="99", "Microsoft Edge";v="121", "Chromium";v="121"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "x-requested-with": "XMLHttpRequest",
    Referer: sessionId ? `${baseUrl}/anime/${sessionId}` : baseUrl,
    "User-Agent": USER_AGENT,
  }

  const cookies = getStoredCookieHeader()
  if (cookies) headers.Cookie = cookies

  return headers
}

function playPageHeaders(sessionId: string): Record<string, string> {
  const baseUrl = getBaseUrl()
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${baseUrl}/anime/${sessionId}`,
    "User-Agent": USER_AGENT,
  }

  const cookies = getStoredCookieHeader()
  if (cookies) headers.Cookie = cookies

  return headers
}

async function directFetch(url: string, headers: Record<string, string>, retried = false): Promise<string> {
  const response = await fetch(url, { headers })
  const body = await response.text()

  if (isBlockedResponse(response.status, body)) {
    const bypassed = await handleBlockedResponse(getBaseUrl(), response.status, body, retried)
    if (bypassed) {
      const nextHeaders = { ...headers }
      const cookies = getStoredCookieHeader()
      if (cookies) nextHeaders.Cookie = cookies
      return directFetch(url, nextHeaders, true)
    }
    throw new Error("Animepahe verification failed or was cancelled")
  }

  if (!response.ok) {
    console.error("[animepaheClient] HTTP", response.status, body.slice(0, 200))
    throw new Error(`Animepahe error ${response.status}`)
  }

  return body
}

async function directGet(url: string, sessionId?: string) {
  const body = await directFetch(url, directHeaders(sessionId))
  return JSON.parse(body)
}

async function apiGet<T>(path: string): Promise<T> {
  const base = getApiBaseUrl()
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`
  console.log("[animepaheClient] API GET", url)

  const response = await fetch(url, { headers: { Accept: "application/json" } })
  if (!response.ok) {
    const body = await response.text()
    console.error("[animepaheClient] API HTTP", response.status, body.slice(0, 200))
    throw new Error(`Animepahe API error ${response.status}`)
  }
  return response.json()
}

export function buildQualityTag(source: StreamSource): string | null {
  if (source.isDub || !source.url) return null

  const resolution = source.resolution || "default"
  const resTag = resolution === "default" ? "default" : `${resolution}p`

  if (source.isBD) return `-${resTag} BD`
  if (source.fanSub?.toLowerCase().includes("chi")) return `-${resTag} chi`
  return `-${resTag}`
}

export async function paheSearch(
  query: string
): Promise<{ title: string; session: string; poster: string }[]> {
  const cleanQuery = query.replaceAll(/[^\p{L}\p{N}\s]/gu, "")

  if (useApiMode()) {
    const data = await apiGet<{ data: { title: string; session: string; poster: string }[] }>(
      `/api/search?q=${encodeURIComponent(cleanQuery)}`
    )
    return data.data ?? []
  }

  const baseUrl = getBaseUrl()
  const data = await directGet(`${baseUrl}/api?m=search&q=${encodeURIComponent(cleanQuery)}`)
  return (data.data ?? []).map((item: any) => ({
    title: item.title,
    session: item.session,
    poster: item.poster,
  }))
}

export async function paheFetchEpisodesPage(
  session: string,
  page: number
): Promise<{ episodes: { id: string; number: number }[]; lastPage: number }> {
  if (useApiMode()) {
    const data = await apiGet<{
      data: { episode: number; session: string }[]
      paginationInfo?: PaginationInfo
    }>(`/api/${encodeURIComponent(session)}/releases?sort=episode_asc&page=${page}`)

    return {
      episodes: (data.data ?? []).map(item => ({
        id: `${session}/${item.session}`,
        number: item.episode,
      })),
      lastPage: data.paginationInfo?.lastPage ?? 1,
    }
  }

  const baseUrl = getBaseUrl()
  const data = await directGet(
    `${baseUrl}/api?m=release&id=${encodeURIComponent(session)}&sort=episode_asc&page=${page}`,
    session
  )

  return {
    episodes: (data.data ?? []).map((item: any) => ({
      id: `${session}/${item.session}`,
      number: item.episode,
    })),
    lastPage: data.last_page ?? 1,
  }
}

export async function paheFetchAllEpisodes(session: string) {
  const firstPage = await paheFetchEpisodesPage(session, 1)
  const allEpisodes = [...firstPage.episodes]

  for (let page = 2; page <= firstPage.lastPage; page++) {
    const pageData = await paheFetchEpisodesPage(session, page)
    allEpisodes.push(...pageData.episodes)
  }

  return allEpisodes.filter(ep => {
    const num = Number(ep.number)
    return Math.ceil(num) === num && num !== 0
  })
}

export async function directFetchPlayPage(episodeId: string): Promise<string> {
  const baseUrl = getBaseUrl()
  const animeSession = episodeId.split("/")[0]
  return directFetch(`${baseUrl}/play/${episodeId}`, playPageHeaders(animeSession))
}

export function getDirectBaseUrl(): string {
  return getBaseUrl()
}

export async function paheFetchStreamingSourcesFromApi(
  episodeId: string
): Promise<Record<string, string>> {
  const [animeSession, episodeSession] = episodeId.split("/")
  if (!animeSession || !episodeSession) {
    throw new Error(`Invalid episode id: ${episodeId}`)
  }

  const data = await apiGet<{ sources?: StreamSource[] }>(
    `/api/play/${encodeURIComponent(animeSession)}?episodeId=${encodeURIComponent(episodeSession)}&downloads=false`
  )

  const dict: Record<string, string> = {}
  for (const source of data.sources ?? []) {
    const tag = buildQualityTag(source)
    if (tag && !dict[tag]) dict[tag] = source.url
  }
  return dict
}
