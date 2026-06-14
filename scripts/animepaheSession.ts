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
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"

const REQUIRED_COOKIE_NAMES = ["cf_clearance", "__ddg2_", "animepahe_session", "XSRF-TOKEN"]

let bootstrapInFlight: Promise<boolean> | null = null
let sessionReady = false
let webViewController: any = null

type PendingWebViewFetch = {
  resolve: (result: { status: number; body: string }) => void
  reject: (err: Error) => void
}

let pendingWebViewFetch: PendingWebViewFetch | null = null

function disposeWebViewController() {
  if (!webViewController) return
  try {
    webViewController.dispose()
  } catch {
    /* ignore */
  }
  webViewController = null
}

export function isWebViewSessionActive(): boolean {
  return !!webViewController && !!loadSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, false)
}

export function getBaseUrl(): string {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_BASE_URL, "https://animepahe.pw").replace(/\/$/, "")
}

function useApiMode(): boolean {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_API_URL, "").replace(/\/$/, "").length > 0
}

export function getStoredCookieHeader(): string {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, "").trim()
}

export function normalizeCookieHeader(raw: string): string {
  let header = raw.trim()
  if (/^cookie\s*:/i.test(header)) {
    header = header.replace(/^cookie\s*:/i, "").trim()
  }
  return header
}

export function saveCookieHeader(header: string) {
  saveSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, normalizeCookieHeader(header))
}

export function missingSessionCookies(header: string): string[] {
  const normalized = normalizeCookieHeader(header).toLowerCase()
  const missing: string[] = []
  for (let i = 0; i < REQUIRED_COOKIE_NAMES.length; i++) {
    const name = REQUIRED_COOKIE_NAMES[i].toLowerCase()
    if (normalized.indexOf(name + "=") < 0) missing.push(REQUIRED_COOKIE_NAMES[i])
  }
  return missing
}

export function clearStoredSession() {
  sessionReady = false
  saveSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, "")
  saveSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, false)
  disposeWebViewController()
}

export function hasStoredSession(): boolean {
  return getStoredCookieHeader().length > 0
}

export function isSessionReady(): boolean {
  return isWebViewSessionActive() || (sessionReady && hasStoredSession())
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

export function mergeCookieHeaders(existing: string, incoming: string): string {
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

/** Headers matching a same-origin browser fetch to /api (see DevTools Network tab). */
export function apiHeaders(_sessionId?: string): Record<string, string> {
  const baseUrl = getBaseUrl()
  const headers: Record<string, string> = {
    Referer: baseUrl + "/",
    "User-Agent": USER_AGENT,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
  }

  const cookies = getStoredCookieHeader()
  if (cookies) headers.Cookie = cookies

  return headers
}

export function playPageHeaders(sessionId: string): Record<string, string> {
  const baseUrl = getBaseUrl()
  const headers: Record<string, string> = {
    Referer: baseUrl + "/anime/" + sessionId,
    "User-Agent": USER_AGENT,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "navigate",
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
        domain: host,
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

function buildWebViewFetchScript(requestUrl: string, referer: string, fetchMode: string): string {
  return (
    "(function(){fetch('" +
    requestUrl +
    "',{credentials:'include',headers:{Referer:'" +
    referer +
    "','Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'" +
    fetchMode +
    "'}}).then(function(r){return r.text().then(function(t){window.webkit.messageHandlers.paheFetchDone.postMessage({status:r.status,body:t});});})" +
    ".catch(function(e){window.webkit.messageHandlers.paheFetchDone.postMessage({status:0,body:String(e)});});})();"
  )
}

function webViewFetchViaMessageHandler(
  controller: any,
  requestUrl: string,
  referer: string,
  fetchMode: string
): Promise<{ status: number; body: string }> {
  return new Promise(function (resolve, reject) {
    if (!controller || !controller.evaluateJavaScript) {
      reject(new Error("WebView evaluateJavaScript unavailable"))
      return
    }
    if (pendingWebViewFetch) {
      reject(new Error("WebView fetch already in progress"))
      return
    }

    pendingWebViewFetch = { resolve: resolve, reject: reject }

    controller.evaluateJavaScript(buildWebViewFetchScript(requestUrl, referer, fetchMode)).catch(function (err) {
      if (pendingWebViewFetch) {
        pendingWebViewFetch = null
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  })
}

async function registerWebViewHandlers(controller: any, baseUrl: string) {
  const host = hostFromBaseUrl(baseUrl)

  if (controller.addScriptMessageHandler) {
    await controller.addScriptMessageHandler("paheFetchDone", function (payload: any) {
      if (!pendingWebViewFetch) return "ok"

      let data = payload
      if (typeof payload === "string") {
        try {
          data = JSON.parse(payload)
        } catch {
          data = { status: 0, body: payload }
        }
      }

      const pending = pendingWebViewFetch
      pendingWebViewFetch = null
      const status = data && data.status ? data.status : 0
      const body = data && data.body ? data.body : ""
      pending.resolve({ status: status, body: body })
      return "ok"
    })
  } else {
    console.log("[animepaheSession] addScriptMessageHandler unavailable")
  }

  controller.shouldAllowRequest = async function (request: any) {
    if (!request || !request.url || request.url.indexOf(host) < 0) return true

    const headers = request.headers || {}
    const cookie = headers.Cookie || headers.cookie
    if (cookie) {
      saveCookieHeader(mergeCookieHeaders(getStoredCookieHeader(), cookie))
      console.log("[animepaheSession] Sniffed request Cookie length:", cookie.length)
    }

    injectContinueButton(controller)
    return true
  }
}

async function saveCookiesFromWebView(controller: any, baseUrl: string) {
  const cookies = await captureCookies(controller, baseUrl)
  const header = cookiesToHeader(cookies)
  if (header) {
    saveCookieHeader(mergeCookieHeaders(getStoredCookieHeader(), header))
    console.log("[animepaheSession] Saved cookie header length:", getStoredCookieHeader().length)
  } else {
    console.log("[animepaheSession] No exportable cookies (HttpOnly stay in WebView jar)")
  }
}

async function probeApiInWebView(controller: any, baseUrl: string): Promise<boolean> {
  const probeUrl = baseUrl + "/api?m=search&q=a"
  const referer = baseUrl + "/"

  try {
    const result = await webViewFetchViaMessageHandler(controller, probeUrl, referer, "cors")
    const body = result.body || ""
    const ok = result.status === 200 && isLikelyJsonApi(body) && !isChallengePage(body)
    if (!ok) {
      console.log("[animepaheSession] WebView probe status:", result.status, "body:", body.slice(0, 80))
    }
    return ok
  } catch (err) {
    console.log("[animepaheSession] WebView probe failed:", err)
    return false
  }
}

async function injectContinueButton(controller: any) {
  if (!controller.evaluateJavaScript) return

  const script =
    "(function(){function addBtn(){if(!window.webkit||!window.webkit.messageHandlers||!window.webkit.messageHandlers.paheContinue)return;" +
    "if(document.getElementById('pahe-continue'))return;var btn=document.createElement('button');btn.id='pahe-continue';" +
    "btn.textContent='Continue to app';btn.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:16px 24px;font-size:17px;font-weight:600;background:#007AFF;color:#fff;border:none;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.35);';" +
    "btn.onclick=function(){window.webkit.messageHandlers.paheContinue.postMessage('');};" +
    "(document.body||document.documentElement).appendChild(btn);}addBtn();" +
    "try{new MutationObserver(addBtn).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}})();"

  try {
    await controller.evaluateJavaScript(script)
  } catch (err) {
    console.log("[animepaheSession] Continue button inject failed:", err)
  }
}

async function captureCookiesFromDocument(controller: any): Promise<WebCookie[]> {
  if (!controller.evaluateJavaScript) return []

  try {
    const raw = await controller.evaluateJavaScript("return document.cookie || ''")
    console.log("[animepaheSession] document.cookie length:", raw ? String(raw).length : 0)
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
    console.log("[animepaheSession] document.cookie failed:", err)
    return []
  }
}

function filterCookiesForHost(cookies: WebCookie[], host: string): WebCookie[] {
  const filtered: WebCookie[] = []
  for (let i = 0; i < cookies.length; i++) {
    const cookie = cookies[i]
    const domain = (cookie.domain || "").replace(/^\./, "")
    if (!domain || domain.indexOf(host) >= 0 || host.indexOf(domain) >= 0) {
      filtered.push(cookie)
    }
  }
  return filtered.length ? filtered : cookies
}

function cookieNames(cookies: WebCookie[]): string {
  const names: string[] = []
  const seen: Record<string, boolean> = {}
  for (let i = 0; i < cookies.length; i++) {
    const name = cookies[i].name
    if (!name || seen[name]) continue
    seen[name] = true
    names.push(name)
  }
  return names.join(", ")
}

async function captureCookies(controller: any, baseUrl: string): Promise<WebCookie[]> {
  const host = hostFromBaseUrl(baseUrl)
  const urlsToTry = [
    baseUrl + "/",
    baseUrl,
    baseUrl + "/api?m=search&q=a",
    "https://" + host + "/",
  ]
  const collected: WebCookie[] = []
  const sources: string[] = []

  if (typeof controller.getAllCookies === "function") {
    try {
      const all = await controller.getAllCookies()
      const count = all ? all.length : 0
      console.log("[animepaheSession] getAllCookies:", count)
      if (all && all.length) {
        collected.push.apply(collected, all)
        sources.push("getAllCookies=" + count)
      }
    } catch (err) {
      console.log("[animepaheSession] getAllCookies failed:", err)
    }
  } else {
    console.log("[animepaheSession] getAllCookies unavailable (TestFlight feature?)")
  }

  if (typeof controller.getCookies === "function") {
    for (let i = 0; i < urlsToTry.length; i++) {
      try {
        const matched = await controller.getCookies(urlsToTry[i])
        if (matched && matched.length) {
          collected.push.apply(collected, matched)
          sources.push("getCookies=" + matched.length + "@" + urlsToTry[i])
        }
      } catch (err) {
        console.log("[animepaheSession] getCookies failed:", urlsToTry[i], err)
      }
    }
  } else {
    console.log("[animepaheSession] getCookies unavailable")
  }

  const documentCookies = await captureCookiesFromDocument(controller)
  if (documentCookies.length) {
    collected.push.apply(collected, documentCookies)
    sources.push("document=" + documentCookies.length)
  }

  const filtered = filterCookiesForHost(collected, host)
  console.log("[animepaheSession] Cookie sources:", sources.join("; ") || "none")
  console.log("[animepaheSession] Captured cookie names:", cookieNames(filtered) || "(empty)")

  return filtered
}

/** Run a fetch inside the live WebView (HttpOnly cookies stay in the jar). */
export async function webViewFetch(
  requestUrl: string,
  referer: string,
  fetchMode: "cors" | "navigate" = "cors"
): Promise<{ status: number; body: string }> {
  if (!webViewController) {
    throw new Error("No active WebView session")
  }
  return webViewFetchViaMessageHandler(webViewController, requestUrl, referer, fetchMode)
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

async function captureSessionFromWebView(baseUrl: string): Promise<boolean> {
  disposeWebViewController()
  const controller = new WebViewController()
  webViewController = controller

  let webViewProbeOk = false

  try {
    await registerWebViewHandlers(controller, baseUrl)

    if (controller.addScriptMessageHandler) {
      await controller.addScriptMessageHandler("paheContinue", async function () {
        console.log("[animepaheSession] Continue tapped — saving session from live WebView")
        await saveCookiesFromWebView(controller, baseUrl)
        webViewProbeOk = await probeApiInWebView(controller, baseUrl)
        console.log("[animepaheSession] WebView probe while open:", webViewProbeOk ? "ok" : "failed")
        if (controller.dismiss) controller.dismiss()
        return "ok"
      })
    }

    await preloadStoredCookies(controller, baseUrl)
    await controller.loadURL(baseUrl + "/")
    if (controller.waitForLoad) await controller.waitForLoad()
    await injectContinueButton(controller)

    await controller.present({
      fullscreen: true,
      navigationTitle: "Verify site, then tap Continue",
    })

    if (!webViewProbeOk) {
      console.log("[animepaheSession] Sheet closed — probing live WebView session")
      await saveCookiesFromWebView(controller, baseUrl)
      webViewProbeOk = await probeApiInWebView(controller, baseUrl)
    }

    const probeOk = getStoredCookieHeader() ? await probeApi(baseUrl) : false
    if (probeOk) {
      saveSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, false)
      sessionReady = true
      disposeWebViewController()
      console.log("[animepaheSession] Exported cookies work with fetch()")
      return true
    }

    if (webViewProbeOk) {
      saveSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, true)
      sessionReady = true
      console.log("[animepaheSession] Live WebView session active — requests run inside WebView")
      return true
    }

    disposeWebViewController()
    return false
  } catch (err) {
    disposeWebViewController()
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
    const missing = missingSessionCookies(getStoredCookieHeader())
    if (missing.length) {
      console.log("[animepaheSession] Stored cookies missing:", missing.join(", "))
    }

    const cachedOk = await probeApi(baseUrl)
    if (cachedOk) {
      sessionReady = true
      console.log("[animepaheSession] Reused stored cookies")
      return true
    }
    console.log("[animepaheSession] Stored cookies rejected by API probe")
  }

  console.log("[animepaheSession] Opening verification sheet")
  const verified = await captureSessionFromWebView(baseUrl)
  sessionReady = verified
  return verified
}

/** Load animepahe main page on boot. On 403/challenge, open WebView and save cookies for later requests. */
export async function bootstrapAnimepaheSession(): Promise<boolean> {
  if (isWebViewSessionActive()) return true
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
  if (isWebViewSessionActive()) return true
  if (sessionReady && hasStoredSession()) return true
  return bootstrapAnimepaheSession()
}

/** Save cookies pasted from browser DevTools and validate with a probe. */
export async function importCookieHeader(raw: string): Promise<boolean> {
  const header = normalizeCookieHeader(raw)
  if (!header) return false

  saveCookieHeader(header)
  sessionReady = false

  const missing = missingSessionCookies(header)
  if (missing.length) {
    console.log("[animepaheSession] Imported cookies missing:", missing.join(", "))
  }

  const ok = await probeApi(getBaseUrl())
  sessionReady = ok
  return ok
}

/** Manual re-verify from Settings. */
export async function refreshAnimepaheSession(): Promise<boolean> {
  clearStoredSession()
  return bootstrapAnimepaheSession()
}
