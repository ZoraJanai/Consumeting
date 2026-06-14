import { fetch } from "scripting"
import { loadSetting, saveSetting, STORAGE_KEYS } from "./storage"

type WebCookie = {
  name: string
  value: string
  domain: string
  path: string
  isSecure: boolean
  isHTTPOnly: boolean
  isSessionOnly: boolean
  expiresDate?: Date | null
}

declare const WebViewController: {
  new (): any
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
const JSON_ACCEPT = "application/json, text/javascript, */*; q=0.01"
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

let bootstrapInFlight: Promise<boolean> | null = null
let sessionReady = false

export function getBaseUrl(): string {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_BASE_URL, "https://animepahe.pw").replace(/\/$/, "")
}

function useApiMode(): boolean {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_API_URL, "").replace(/\/$/, "").length > 0
}

export function getStoredCookieHeader(): string {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, "").trim()
}

export function saveCookieHeader(header: string) {
  saveSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, header.trim())
}

export function clearStoredSession() {
  sessionReady = false
  saveSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, "")
  saveSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, false)
}

export function hasStoredSession(): boolean {
  return getStoredCookieHeader().length > 0
}

export function isSessionReady(): boolean {
  return sessionReady && hasStoredSession()
}

export function isChallengePage(body: string): boolean {
  const sample = body.slice(0, 8000).toLowerCase()
  return (
    sample.includes("ddos-guard") ||
    sample.includes("ddg-cookie") ||
    sample.includes("checking your browser") ||
    sample.includes("just a moment") ||
    sample.includes("cf-challenge") ||
    sample.includes("cdn-cgi/challenge") ||
    sample.includes("please wait while") ||
    sample.includes("id=\"cf-")
  )
}

export function isLikelyJsonApi(body: string): boolean {
  const trimmed = body.replace(/^\s+/, "")
  return trimmed.startsWith("{") || trimmed.startsWith("[")
}

function cookiesToHeader(cookies: WebCookie[]): string {
  const seen: Record<string, boolean> = {}
  const parts: string[] = []

  for (let i = 0; i < cookies.length; i++) {
    const cookie = cookies[i]
    if (!cookie.name || seen[cookie.name]) continue
    seen[cookie.name] = true
    parts.push(cookie.name + "=" + cookie.value)
  }

  return parts.join("; ")
}

function mergeCookieHeaders(existing: string, incoming: string): string {
  const map: Record<string, string> = {}

  function ingest(header: string) {
    const parts = header.split(";")
    for (let i = 0; i < parts.length; i++) {
      const trimmed = parts[i].trim()
      const eq = trimmed.indexOf("=")
      if (eq <= 0) continue
      map[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
  }

  if (existing) ingest(existing)
  if (incoming) ingest(incoming)

  const keys = Object.keys(map)
  const merged: string[] = []
  for (let i = 0; i < keys.length; i++) {
    merged.push(keys[i] + "=" + map[keys[i]])
  }
  return merged.join("; ")
}

function hostFromBaseUrl(baseUrl: string): string {
  const match = baseUrl.match(/^https?:\/\/([^/?#]+)/i)
  const host = match ? match[1] : baseUrl
  return host.replace(/^www\./, "")
}

function originFromBaseUrl(baseUrl: string): string {
  const match = baseUrl.match(/^(https?:\/\/[^/?#]+)/i)
  return (match ? match[1] : baseUrl) + "/"
}

function homepageHeaders(baseUrl: string): Record<string, string> {
  return {
    Accept: HTML_ACCEPT,
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": USER_AGENT,
    Referer: baseUrl + "/",
  }
}

export function apiHeaders(sessionId?: string): Record<string, string> {
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
    Referer: sessionId ? baseUrl + "/anime/" + sessionId : baseUrl + "/",
    "User-Agent": USER_AGENT,
  }

  const cookies = getStoredCookieHeader()
  if (cookies) headers.Cookie = cookies

  return headers
}

export function playPageHeaders(sessionId: string): Record<string, string> {
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

function saveResponseCookies(response: any) {
  const cookies = response.cookies
  if (!cookies || !cookies.length) return

  const parts: string[] = []
  for (let i = 0; i < cookies.length; i++) {
    parts.push(cookies[i].name + "=" + cookies[i].value)
  }

  const incoming = parts.join("; ")
  if (!incoming) return

  const merged = mergeCookieHeaders(getStoredCookieHeader(), incoming)
  saveCookieHeader(merged)
}

async function preloadStoredCookies(controller: any, baseUrl: string) {
  if (!controller.setCookie) return

  const header = getStoredCookieHeader()
  if (!header) return

  const host = hostFromBaseUrl(baseUrl)
  const parts = header.split(";")

  for (let i = 0; i < parts.length; i++) {
    const trimmed = parts[i].trim()
    if (!trimmed) continue

    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue

    const name = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!name || !value) continue

    try {
      await controller.setCookie({
        name: name,
        value: value,
        domain: "." + host,
        path: "/",
        isSecure: true,
        isHTTPOnly: false,
        isSessionOnly: false,
      })
    } catch {
      /* ignore */
    }
  }
}

async function captureCookiesFromDocument(controller: any): Promise<WebCookie[]> {
  if (!controller.evaluateJavaScript) return []

  try {
    const raw = await controller.evaluateJavaScript("return document.cookie || ''")
    if (!raw || typeof raw !== "string" || !raw.trim()) return []

    const cookies: WebCookie[] = []
    const parts = raw.split(";")
    for (let i = 0; i < parts.length; i++) {
      const trimmed = parts[i].trim()
      const eq = trimmed.indexOf("=")
      if (eq <= 0) continue
      cookies.push({
        name: trimmed.slice(0, eq).trim(),
        value: trimmed.slice(eq + 1).trim(),
        domain: "",
        path: "/",
        isSecure: true,
        isHTTPOnly: false,
        isSessionOnly: true,
      })
    }
    return cookies
  } catch {
    return []
  }
}

async function captureCookies(controller: any, baseUrl: string): Promise<WebCookie[]> {
  const origin = originFromBaseUrl(baseUrl)
  const host = hostFromBaseUrl(baseUrl)
  const urlsToTry = [baseUrl, origin, origin + "api/"]

  if (controller.getCookies) {
    for (let i = 0; i < urlsToTry.length; i++) {
      try {
        const matched = await controller.getCookies(urlsToTry[i])
        if (matched && matched.length) return matched
      } catch {
        /* ignore */
      }
    }
  }

  if (controller.getAllCookies) {
    try {
      const all = await controller.getAllCookies()
      if (all && all.length) {
        const filtered: WebCookie[] = []
        for (let i = 0; i < all.length; i++) {
          const cookie = all[i]
          const domain = (cookie.domain || "").replace(/^\./, "")
          if (!domain || domain.indexOf(host) >= 0 || host.indexOf(domain) >= 0) {
            filtered.push(cookie)
          }
        }
        if (filtered.length) return filtered
        return all
      }
    } catch {
      /* ignore */
    }
  }

  return captureCookiesFromDocument(controller)
}

async function probeApi(baseUrl: string): Promise<boolean> {
  const probeUrl = baseUrl + "/api?m=search&q=" + encodeURIComponent("a")
  try {
    const response = await fetch(probeUrl, { headers: apiHeaders() })
    const body = await response.text()
    saveResponseCookies(response)
    return response.ok && isLikelyJsonApi(body) && !isChallengePage(body)
  } catch {
    return false
  }
}

async function fetchMainPage(baseUrl: string): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(baseUrl + "/", { headers: homepageHeaders(baseUrl) })
  const body = await response.text()
  saveResponseCookies(response)
  return { ok: response.ok, status: response.status, body: body }
}

function needsVerificationPage(status: number, body: string): boolean {
  if (status === 403 || status === 503) return true
  return isChallengePage(body)
}

async function captureSessionFromWebView(baseUrl: string): Promise<boolean> {
  const controller = new WebViewController()

  try {
    await preloadStoredCookies(controller, baseUrl)
    await controller.loadURL(baseUrl + "/")
    if (controller.waitForLoad) await controller.waitForLoad()

    await controller.present({
      fullscreen: true,
      navigationTitle: "Complete verification",
    })

    const cookies = await captureCookies(controller, baseUrl)
    const header = cookiesToHeader(cookies)
    if (header) {
      saveCookieHeader(mergeCookieHeaders(getStoredCookieHeader(), header))
      console.log("[animepaheSession] Saved cookies from WebView:", cookies.length)
    }

    controller.dispose()
    return await probeApi(baseUrl)
  } catch (err) {
    try {
      controller.dispose()
    } catch {
      /* ignore */
    }
    console.error("[animepaheSession] WebView capture failed:", err)
    return false
  }
}

async function runBootstrap(): Promise<boolean> {
  if (useApiMode()) {
    sessionReady = true
    return true
  }

  const baseUrl = getBaseUrl()
  console.log("[animepaheSession] Bootstrapping session for", baseUrl)

  if (getStoredCookieHeader()) {
    const cachedOk = await probeApi(baseUrl)
    if (cachedOk) {
      sessionReady = true
      console.log("[animepaheSession] Reused stored cookies")
      return true
    }
    clearStoredSession()
  }

  const main = await fetchMainPage(baseUrl)
  if (main.ok && !needsVerificationPage(main.status, main.body)) {
    const ok = await probeApi(baseUrl)
    if (ok) {
      sessionReady = true
      console.log("[animepaheSession] Main page fetch established session")
      return true
    }
    console.log("[animepaheSession] Main page loaded but API probe failed")
  } else {
    console.log("[animepaheSession] Main page blocked:", main.status)
  }
  console.log("[animepaheSession] Opening verification sheet")
  const verified = await captureSessionFromWebView(baseUrl)
  sessionReady = verified
  return verified
}

/** Load animepahe main page on boot. On 403/challenge, open WebView and save cookies for later requests. */
export async function bootstrapAnimepaheSession(): Promise<boolean> {
  if (sessionReady && hasStoredSession()) return true
  if (bootstrapInFlight) return bootstrapInFlight

  bootstrapInFlight = runBootstrap().finally(function () {
    bootstrapInFlight = null
  })

  return bootstrapInFlight
}

/** Wait until boot session is ready before API calls. */
export async function ensureAnimepaheSession(): Promise<boolean> {
  if (useApiMode()) return true
  if (sessionReady && hasStoredSession()) return true
  return bootstrapAnimepaheSession()
}

/** Manual re-verify from Settings. */
export async function refreshAnimepaheSession(): Promise<boolean> {
  clearStoredSession()
  return bootstrapAnimepaheSession()
}
