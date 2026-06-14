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

let bypassInFlight: Promise<boolean> | null = null
let sessionController: any = null

const JSON_ACCEPT = "application/json, text/javascript, */*; q=0.01"
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

export function getStoredCookieHeader(): string {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, "").trim()
}

export function saveCookieHeader(header: string) {
  saveSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, header.trim())
}

export function hasWebViewSession(): boolean {
  if (sessionController) return true
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, false) === true
}

function markWebViewSessionActive() {
  saveSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, true)
}

export function clearStoredSession() {
  saveSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, "")
  saveSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, false)
  if (sessionController) {
    try {
      sessionController.dispose()
    } catch {
      /* ignore */
    }
    sessionController = null
  }
}

export function hasStoredSession(): boolean {
  return getStoredCookieHeader().length > 0 || hasWebViewSession()
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

/** @deprecated use isChallengePage for sheet decisions */
export function isBlockedResponse(status: number, body: string): boolean {
  return isChallengePage(body)
}

export function shouldShowVerificationSheet(
  status: number,
  body: string,
  expectJson: boolean
): boolean {
  return isChallengePage(body)
}

export function shouldTrySilentWebView(
  status: number,
  body: string,
  expectJson: boolean
): boolean {
  if (isChallengePage(body)) return false
  if (status === 403 || status === 503) return true
  if (expectJson && !isLikelyJsonApi(body)) return true
  return false
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

function hostFromBaseUrl(baseUrl: string): string {
  const match = baseUrl.match(/^https?:\/\/([^/?#]+)/i)
  const host = match ? match[1] : baseUrl
  return host.replace(/^www\./, "")
}

function originFromBaseUrl(baseUrl: string): string {
  const match = baseUrl.match(/^(https?:\/\/[^/?#]+)/i)
  return (match ? match[1] : baseUrl) + "/"
}

function escapeForJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
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
    } catch (err) {
      console.warn("[cloudflareBypass] Failed to preload cookie:", name, err)
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
  } catch (err) {
    console.warn("[cloudflareBypass] document.cookie read failed:", err)
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
        if (matched && matched.length) {
          console.log("[cloudflareBypass] getCookies hit on", urlsToTry[i], matched.length)
          return matched
        }
      } catch (err) {
        console.warn("[cloudflareBypass] getCookies failed for", urlsToTry[i], err)
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
        if (filtered.length) {
          console.log("[cloudflareBypass] getAllCookies filtered:", filtered.length)
          return filtered
        }
        console.log("[cloudflareBypass] getAllCookies unfiltered:", all.length)
        return all
      }
    } catch (err) {
      console.warn("[cloudflareBypass] getAllCookies failed:", err)
    }
  }

  const docCookies = await captureCookiesFromDocument(controller)
  if (docCookies.length) {
    console.log("[cloudflareBypass] document.cookie:", docCookies.length)
  }
  return docCookies
}

async function webViewFetchOnController(
  controller: any,
  requestUrl: string,
  accept: string
): Promise<string> {
  const escapedUrl = escapeForJsString(requestUrl)
  const escapedAccept = escapeForJsString(accept)
  const js =
    "return fetch('" +
    escapedUrl +
    "', { credentials: 'include', headers: { 'Accept': '" +
    escapedAccept +
    "', 'X-Requested-With': 'XMLHttpRequest' } }).then(function(r) { return r.text(); });"

  const body = await controller.evaluateJavaScript(js)
  if (body == null) throw new Error("WebView fetch returned empty response")
  return String(body)
}

async function verifyWebViewSession(controller: any, baseUrl: string): Promise<boolean> {
  const probeUrl = baseUrl + "/api?m=search&q=" + encodeURIComponent("a")
  try {
    const body = await webViewFetchOnController(controller, probeUrl, JSON_ACCEPT)
    if (isChallengePage(body) || !isLikelyJsonApi(body)) return false
    const data = JSON.parse(body)
    return !!(data && data.data)
  } catch (err) {
    console.warn("[cloudflareBypass] WebView session probe failed:", err)
    return false
  }
}

async function getOrCreateSessionController(baseUrl: string): Promise<any> {
  if (sessionController) return sessionController

  sessionController = new WebViewController()
  await preloadStoredCookies(sessionController, baseUrl)
  await sessionController.loadURL(baseUrl)
  if (sessionController.waitForLoad) await sessionController.waitForLoad()
  return sessionController
}

export async function trySilentWebViewFetch(
  requestUrl: string,
  accept?: string
): Promise<string | null> {
  const baseUrl = loadSetting(STORAGE_KEYS.ANIMEPAHE_BASE_URL, "https://animepahe.pw").replace(/\/$/, "")
  const acceptHeader = accept || JSON_ACCEPT

  if (sessionController) {
    try {
      const body = await webViewFetchOnController(sessionController, requestUrl, acceptHeader)
      if (!isChallengePage(body)) return body
    } catch (err) {
      console.warn("[cloudflareBypass] Silent fetch on existing session failed:", err)
    }
    return null
  }

  const controller = new WebViewController()
  try {
    await preloadStoredCookies(controller, baseUrl)
    await controller.loadURL(baseUrl)
    if (controller.waitForLoad) await controller.waitForLoad()

    if (controller.getHTML) {
      const html = await controller.getHTML()
      if (isChallengePage(html)) {
        console.log("[cloudflareBypass] Challenge page detected, opening verification sheet")
        await controller.present({
          fullscreen: true,
          navigationTitle: "Complete verification",
        })
        const verified = await verifyWebViewSession(controller, baseUrl)
        if (verified) {
          sessionController = controller
          markWebViewSessionActive()
          return webViewFetchOnController(controller, requestUrl, acceptHeader)
        }
        controller.dispose()
        return null
      }
    }

    const body = await webViewFetchOnController(controller, requestUrl, acceptHeader)
    if (isChallengePage(body)) return null

    sessionController = controller
    markWebViewSessionActive()
    console.log("[cloudflareBypass] Silent WebView session established")
    return body
  } catch (err) {
    console.warn("[cloudflareBypass] Silent WebView bootstrap failed:", err)
    try {
      controller.dispose()
    } catch {
      /* ignore */
    }
    return null
  }
}

export async function webViewFetch(requestUrl: string, accept?: string): Promise<string> {
  const baseUrl = loadSetting(STORAGE_KEYS.ANIMEPAHE_BASE_URL, "https://animepahe.pw").replace(/\/$/, "")
  const controller = await getOrCreateSessionController(baseUrl)
  const acceptHeader = accept || JSON_ACCEPT
  const body = await webViewFetchOnController(controller, requestUrl, acceptHeader)

  if (isChallengePage(body)) {
    saveSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, false)
    throw new Error("WebView session expired")
  }

  return body
}

async function runBypassSheet(baseUrl: string): Promise<boolean> {
  const controller = new WebViewController()

  try {
    await preloadStoredCookies(controller, baseUrl)
    await controller.loadURL(baseUrl)
    if (controller.waitForLoad) await controller.waitForLoad()

    await controller.present({
      fullscreen: true,
      navigationTitle: "Complete verification",
    })

    const cookies = await captureCookies(controller, baseUrl)
    const header = cookiesToHeader(cookies)
    if (header) {
      saveCookieHeader(header)
      console.log("[cloudflareBypass] Saved cookie header,", cookies.length, "cookies")
    }

    const verified = await verifyWebViewSession(controller, baseUrl)
    if (verified) {
      if (sessionController && sessionController !== controller) {
        try {
          sessionController.dispose()
        } catch {
          /* ignore */
        }
      }
      sessionController = controller
      markWebViewSessionActive()
      console.log("[cloudflareBypass] WebView session active")
      return true
    }

    if (header) {
      if (sessionController && sessionController !== controller) {
        try {
          sessionController.dispose()
        } catch {
          /* ignore */
        }
      }
      sessionController = controller
      markWebViewSessionActive()
      return true
    }

    console.warn("[cloudflareBypass] Sheet closed without usable session")
    controller.dispose()
    return false
  } catch (err) {
    try {
      controller.dispose()
    } catch {
      /* ignore */
    }
    throw err
  }
}

export async function presentCloudflareBypass(baseUrl: string): Promise<boolean> {
  if (bypassInFlight) return bypassInFlight

  bypassInFlight = runBypassSheet(baseUrl).finally(function () {
    bypassInFlight = null
  })

  return bypassInFlight
}

export async function handleBlockedResponse(
  baseUrl: string,
  status: number,
  body: string,
  alreadyRetried: boolean
): Promise<boolean> {
  if (alreadyRetried || !isChallengePage(body)) return false

  console.log("[cloudflareBypass] Challenge page detected, opening verification sheet")
  return presentCloudflareBypass(baseUrl)
}
