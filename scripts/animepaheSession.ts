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

const HARDWIRED_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1"

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"

const REQUIRED_COOKIE_NAMES = ["cf_clearance", "__ddg2_", "animepahe_session", "XSRF-TOKEN"]

let bootstrapInFlight: Promise<boolean> | null = null
let sessionReady = false
let webViewController: any = null

type PendingWebViewFetch = {
  id: number
  resolve: (result: { status: number; body: string }) => void
  reject: (err: Error) => void
  requestUrl?: string
  referer?: string
  fetchMode?: string
  extraHeaders?: Record<string, string>
}

let pendingWebViewFetches: Record<number, PendingWebViewFetch> = {}
let webViewJsQueue: WebViewJsJob[] = []
let webViewJsBusy = false
let nextWebViewFetchId = 1
let verificationController: any = null

// ── kwik.cx CF session flag ────────────────────────────────────────────────────
// While true, the pahePageReady "wrong host → reload home" guard is suppressed
// so the WebView can stay on kwik.cx long enough to solve the CF challenge.
// Also acts as a mutex to prevent concurrent kwik captures.
let _kwikCapturing = false

const WEBVIEW_FETCH_TIMEOUT_MS = 90000
const fetchTimeouts: Record<number, ReturnType<typeof setTimeout>> = {}

type WebViewJsJob =
  | { kind: "fetch"; fetchId: number; script: string }
  | {
      kind: "script"
      script: string
      resolve: (value: any) => void
      reject: (err: Error) => void
    }

function clearFetchTimeout(fetchId: number) {
  const timer = fetchTimeouts[fetchId]
  if (timer) {
    clearTimeout(timer)
    delete fetchTimeouts[fetchId]
  }
}

function clearAllFetchTimeouts() {
  const ids = Object.keys(fetchTimeouts)
  for (let i = 0; i < ids.length; i++) {
    clearFetchTimeout(Number(ids[i]))
  }
}

function scheduleFetchTimeout(fetchId: number, controller: any) {
  clearFetchTimeout(fetchId)
  fetchTimeouts[fetchId] = setTimeout(function () {
    const pending = pendingWebViewFetches[fetchId]
    if (!pending) return
    console.log("[animepaheSession] WebView fetch timed out id=" + String(fetchId))
    delete pendingWebViewFetches[fetchId]
    webViewJsBusy = false
    pending.reject(new Error("WebView fetch timed out"))
    pumpWebViewJsQueue(controller)
  }, WEBVIEW_FETCH_TIMEOUT_MS)
}

function pumpWebViewJsQueue(controller?: any) {
  const ctrl = controller || webViewController
  if (webViewJsBusy || !webViewJsQueue.length || !ctrl) return

  const job = webViewJsQueue.shift()
  if (!job) return

  webViewJsBusy = true
  if (job.kind === "fetch") {
    scheduleFetchTimeout(job.fetchId, ctrl)
  }

  ctrl.evaluateJavaScript(job.script)
    .then(function (result: any) {
      if (job.kind === "script") {
        webViewJsBusy = false
        job.resolve(result)
        pumpWebViewJsQueue(ctrl)
      }
    })
    .catch(function (err: any) {
      console.log("[animepaheSession] evaluateJavaScript error:", String(err))
      webViewJsBusy = false
      if (job.kind === "fetch") {
        clearFetchTimeout(job.fetchId)
        const pending = pendingWebViewFetches[job.fetchId]
        delete pendingWebViewFetches[job.fetchId]
        if (pending) {
          pending.reject(err instanceof Error ? err : new Error(String(err)))
        }
      } else {
        job.reject(err instanceof Error ? err : new Error(String(err)))
      }
      pumpWebViewJsQueue(ctrl)
    })
}

function finishWebViewFetch(
  controller: any,
  fetchId: number,
  result: { status: number; body: string }
) {
  clearFetchTimeout(fetchId)
  const pending = pendingWebViewFetches[fetchId]
  if (!pending) {
    console.log("[animepaheSession] paheFetchDone unknown or stale id=" + String(fetchId))
    webViewJsBusy = false
    pumpWebViewJsQueue(controller)
    return
  }

  delete pendingWebViewFetches[fetchId]
  webViewJsBusy = false
  pending.resolve(result)
  pumpWebViewJsQueue(controller)
}

function enqueueWebViewScript(controller: any, script: string): Promise<any> {
  return new Promise(function (resolve, reject) {
    if (!controller || !controller.evaluateJavaScript) {
      reject(new Error("WebView evaluateJavaScript unavailable"))
      return
    }
    webViewJsQueue.push({
      kind: "script",
      script: script,
      resolve: resolve,
      reject: reject,
    })
    pumpWebViewJsQueue(controller)
  })
}

function clearWebViewFetchState() {
  const ids = Object.keys(pendingWebViewFetches)
  for (let i = 0; i < ids.length; i++) {
    const pending = pendingWebViewFetches[Number(ids[i])]
    pending.reject(new Error("WebView disposed"))
  }
  pendingWebViewFetches = {}
  webViewJsQueue = []
  webViewJsBusy = false
  clearAllFetchTimeouts()
}

function disposeWebViewController() {
  if (!webViewController) return
  clearWebViewFetchState()
  verificationController = null
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
  return isWebViewSessionActive() || sessionReady
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

function hostFromUrl(url: string): string {
  const match = url.match(/^https?:\/\/([^/?#]+)/i)
  const host = match ? match[1] : url
  return host.replace(/^www\./, "")
}

function hostFromBaseUrl(baseUrl: string): string {
  return hostFromUrl(baseUrl)
}

/** eTLD+1 style domain for animepahe hosts (animepahe.pw === i.animepahe.pw). */
function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, "")
  const parts = h.split(".")
  if (parts.length < 2) return h
  return parts[parts.length - 2] + "." + parts[parts.length - 1]
}

function isPaheFamilyHost(host: string): boolean {
  const lower = host.toLowerCase()
  return (
    lower.indexOf("animepahe") >= 0 ||
    lower.indexOf("pahe.win") >= 0 ||
    lower.indexOf("ppahe.") >= 0
  )
}

/** Chrome Sec-Fetch-Site for a request URL vs the configured animepahe base. */
export function fetchSiteForPaheUrl(requestUrl: string, baseUrl?: string): "same-origin" | "same-site" | "cross-site" {
  const base = baseUrl || getBaseUrl()
  const baseHost = hostFromBaseUrl(base)
  const reqHost = hostFromUrl(requestUrl)
  if (reqHost === baseHost) return "same-origin"
  if (registrableDomain(reqHost) === registrableDomain(baseHost)) return "same-site"
  if (isPaheFamilyHost(reqHost) && isPaheFamilyHost(baseHost)) return "same-site"
  return "cross-site"
}

/** Headers for API / same-origin XHR on animepahe.pw */
export function paheHeaders(opts?: {
  referer?: string
  mode?: "cors" | "navigate"
  requestUrl?: string
}): Record<string, string> {
  const baseUrl = getBaseUrl()
  const referer = opts?.referer || baseUrl + "/"
  const mode = opts?.mode || "cors"
  const fetchSite = opts?.requestUrl
    ? fetchSiteForPaheUrl(opts.requestUrl, baseUrl)
    : "same-origin"

  const headers: Record<string, string> = {
    Referer: referer,
    "User-Agent": USER_AGENT,
    "Sec-Fetch-Site": fetchSite,
    "Sec-Fetch-Mode": mode,
  }

  const cookies = getStoredCookieHeader()
  if (cookies) headers.Cookie = cookies

  return headers
}

/** Headers matching a same-origin browser fetch to /api (see DevTools Network tab). */
export function apiHeaders(_sessionId?: string): Record<string, string> {
  return paheHeaders({ referer: getBaseUrl() + "/", mode: "cors" })
}

export function playPageHeaders(sessionId: string): Record<string, string> {
  return paheHeaders({ referer: getBaseUrl() + "/anime/" + sessionId, mode: "navigate" })
}

export function normalizePaheUrl(url: string): string {
  if (!url) return ""
  let normalized = url.trim()
  if (normalized.indexOf("http") !== 0 && normalized.indexOf("//") !== 0) {
    return normalized
  }
  if (normalized.indexOf("//") === 0) normalized = "https:" + normalized
  if (normalized.indexOf("/") === 0 && normalized.indexOf("//") !== 0) {
    normalized = getBaseUrl() + normalized
  }
  return normalized
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
        domain: "." + registrableDomain(host),
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

function buildWebViewFetchScript(
  requestUrl: string,
  referer: string,
  fetchMode: string,
  fetchId: number,
  extraHeaders?: Record<string, string>
): string {
  const pairs: string[] = []
  if (referer) {
    pairs.push("Referer:'" + referer.replace(/'/g, "\\'") + "'")
  }
  if (extraHeaders) {
    const keys = Object.keys(extraHeaders)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (key === "Referer") continue
      pairs.push("'" + key + "':'" + String(extraHeaders[key]).replace(/'/g, "\\'") + "'")
    }
  } else if (referer) {
    pairs.push("'Sec-Fetch-Site':'same-origin'")
    pairs.push("'Sec-Fetch-Mode':'" + fetchMode + "'")
  }

  const fetchHeaders = "{" + pairs.join(",") + "}"

  return (
    "(function(){fetch('" +
    requestUrl +
    "',{credentials:'include',headers:" +
    fetchHeaders +
    "}).then(function(r){return r.text().then(function(t){window.webkit.messageHandlers.paheFetchDone.postMessage({id:" +
    String(fetchId) +
    ",status:r.status,body:t});});})" +
    ".catch(function(e){window.webkit.messageHandlers.paheFetchDone.postMessage({id:" +
    String(fetchId) +
    ",status:0,body:String(e)});});})();"
  )
}

function webViewFetchViaMessageHandler(
  controller: any,
  requestUrl: string,
  referer: string,
  fetchMode: string,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise(function (resolve, reject) {
    if (!controller || !controller.evaluateJavaScript) {
      reject(new Error("WebView evaluateJavaScript unavailable"))
      return
    }

    const fetchId = nextWebViewFetchId++
    pendingWebViewFetches[fetchId] = {
      id: fetchId,
      resolve: resolve,
      reject: reject,
      requestUrl: requestUrl,
      referer: referer,
      fetchMode: fetchMode,
      extraHeaders: extraHeaders,
    }

    const script = buildWebViewFetchScript(
      requestUrl,
      referer,
      fetchMode,
      fetchId,
      extraHeaders
    )

    webViewJsQueue.push({ kind: "fetch", fetchId: fetchId, script: script })
    pumpWebViewJsQueue(controller)
  })
}

async function reinjectAfterNavigation(controller: any) {
  try {
    if (controller.waitForLoad) await controller.waitForLoad()
  } catch {
    /* ignore */
  }
  await injectContinueButton(controller)
}

function isBlankOrWrongHost(pageUrl: string, baseUrl: string): boolean {
  const url = (pageUrl || "").trim()
  if (!url || url === "about:blank") return true
  const host = hostFromBaseUrl(baseUrl)
  return url.indexOf(host) < 0
}

async function loadWebViewHome(controller: any, baseUrl: string): Promise<void> {
  const homeUrl = baseUrl + "/"
  //console.log("[animepaheSession] Loading WebView home:", homeUrl)
  try {
    controller.setCustomUserAgent(HARDWIRED_UA)
    const loaded = await controller.loadURL(homeUrl)
    if (loaded === false) {
      //console.log("[animepaheSession] loadURL returned false for", homeUrl)
    }
  } catch (err) {
    //console.log("[animepaheSession] loadURL failed:", err)
  }
}

async function registerWebViewHandlers(controller: any, baseUrl: string) {
  const host = hostFromBaseUrl(baseUrl)

  if (controller.addScriptMessageHandler) {
    await controller.addScriptMessageHandler("paheFetchDone", function (payload: any) {
      let data = payload
      if (typeof payload === "string") {
        try {
          data = JSON.parse(payload)
        } catch {
          data = { status: 0, body: payload }
        }
      }

      const fetchId = data && data.id ? Number(data.id) : 0
      if (!fetchId) {
        //console.log("[animepaheSession] paheFetchDone missing id")
        webViewJsBusy = false
        pumpWebViewJsQueue(controller)
        return "ok"
      }

      const status = data && data.status ? data.status : 0
      const body = data && data.body ? data.body : ""
      finishWebViewFetch(controller, fetchId, {
        status: status,
        body: body,
      })
      return "ok"
    })

    await controller.addScriptMessageHandler("pahePageReady", async function (pageUrl: string) {
      //console.log("[animepaheSession] WebView navigated:", pageUrl)
      // Suppress during kwik.cx CF capture — we intentionally left animepahe.pw
      if (_kwikCapturing) return "ok"
      if (isBlankOrWrongHost(pageUrl, baseUrl)) {
        console.log("[animepaheSession] Blank or wrong host — reloading home")
        await loadWebViewHome(controller, baseUrl)
        return "ok"
      }
      await injectContinueButton(controller)
      return "ok"
    })
  } else {
    //console.log("[animepaheSession] addScriptMessageHandler unavailable")
  }

  controller.shouldAllowRequest = async function (request: any) {
    if (!request || !request.url) return true

    if (request.url.indexOf(host) >= 0) {
      const headers = request.headers || {}
      const cookie = headers.Cookie || headers.cookie
      if (cookie) {
        saveCookieHeader(mergeCookieHeaders(getStoredCookieHeader(), cookie))
      }

      const navType = request.navigationType || ""
      const isMainDoc =
        navType === "linkActivated" ||
        navType === "other" ||
        navType === "formSubmitted" ||
        navType === "reload" ||
        navType === "backForward"

      if (isMainDoc) {
        void reinjectAfterNavigation(controller)
      }
    }

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
    //console.log("[animepaheSession] No exportable cookies (HttpOnly stay in WebView jar)")
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
      //console.log("[animepaheSession] WebView probe status:", result.status, "body:", body.slice(0, 80))
    }
    return ok
  } catch (err) {
    //console.log("[animepaheSession] WebView probe failed:", err)
    return false
  }
}

async function injectContinueButton(controller: any) {
  if (!controller.evaluateJavaScript) return

  const script =
    "(function(){function addBtn(){if(!window.webkit||!window.webkit.messageHandlers||!window.webkit.messageHandlers.paheContinue)return;" +
    "var old=document.getElementById('pahe-continue');if(old)old.remove();" +
    "var btn=document.createElement('button');btn.id='pahe-continue';" +
    "btn.textContent='Continue to app';btn.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:16px 24px;font-size:17px;font-weight:600;background:#007AFF;color:#fff;border:none;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.35);';" +
    "btn.onclick=function(){window.webkit.messageHandlers.paheContinue.postMessage('');};" +
    "(document.body||document.documentElement).appendChild(btn);}" +
    "function notify(){addBtn();if(window.webkit.messageHandlers.pahePageReady){try{window.webkit.messageHandlers.pahePageReady.postMessage(location.href||'');}catch(e){}}}" +
    "if(!window.__paheNavSetup){window.__paheNavSetup=true;" +
    "window.addEventListener('load',notify);window.addEventListener('pageshow',notify);" +
    "if(window.__paheNavTimer){clearInterval(window.__paheNavTimer);}" +
    "window.__paheNavTimer=setInterval(addBtn,2000);}" +
    "notify();})();"

  try {
    await enqueueWebViewScript(controller, script)
  } catch (err) {
    //console.log("[animepaheSession] Continue button inject failed:", err)
  }
}

async function captureCookiesFromDocument(controller: any): Promise<WebCookie[]> {
  if (!controller.evaluateJavaScript) return []

  try {
    const raw = await enqueueWebViewScript(controller, "return document.cookie || ''")
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
   // console.log("[animepaheSession] document.cookie failed:", err)
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
      //console.log("[animepaheSession] getAllCookies failed:", err)
    }
  } else {
    //console.log("[animepaheSession] getAllCookies unavailable (TestFlight feature?)")
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
  //console.log("[animepaheSession] Cookie sources:", sources.join("; ") || "none")
  //console.log("[animepaheSession] Captured cookie names:", cookieNames(filtered) || "(empty)")

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

async function probeApiStatus(
  baseUrl: string
): Promise<{ ok: boolean; status: number; reason?: string }> {
  const probeUrl = baseUrl + "/api?m=search&q=" + encodeURIComponent("a")
  try {
    const response = await fetch(probeUrl, { headers: apiHeaders() })
    const body = await response.text()
    saveResponseCookies(response)

    if (response.status === 403 || response.status === 503) {
      return { ok: false, status: response.status, reason: "blocked" }
    }
    if (isChallengePage(body)) {
      return { ok: false, status: response.status, reason: "challenge" }
    }
    const ok = response.ok && isLikelyJsonApi(body)
    return { ok: ok, status: response.status }
  } catch (err) {
    return { ok: false, status: 0, reason: String(err) }
  }
}

async function probeApi(baseUrl: string): Promise<boolean> {
  const result = await probeApiStatus(baseUrl)
  return result.ok
}

async function captureSessionFromWebView(baseUrl: string): Promise<boolean> {
  disposeWebViewController()
  const controller = new WebViewController()
  webViewController = controller
  verificationController = controller

  let webViewProbeOk = false

  try {
    await registerWebViewHandlers(controller, baseUrl)

    if (controller.addScriptMessageHandler) {
      await controller.addScriptMessageHandler("paheContinue", async function () {
        //console.log("[animepaheSession] Continue tapped — saving session from live WebView")
        await saveCookiesFromWebView(controller, baseUrl)
        webViewProbeOk = await probeApiInWebView(controller, baseUrl)
       // console.log("[animepaheSession] WebView probe while open:", webViewProbeOk ? "ok" : "failed")
        if (controller.dismiss) controller.dismiss()
        return "ok"
      })
    }

    await preloadStoredCookies(controller, baseUrl)

    // Start navigation but do not waitForLoad before present — on a fresh WebView that
    // resolves on about:blank and the sheet opens empty (Scripting loads after attach).
    void loadWebViewHome(controller, baseUrl)
    await injectContinueButton(controller)

    await controller.present({
      fullscreen: true,
      navigationTitle: "Verify site, then tap Continue",
    })

    if (!webViewProbeOk) {
     // console.log("[animepaheSession] Sheet closed — probing live WebView session")
      await reinjectAfterNavigation(controller)
      await saveCookiesFromWebView(controller, baseUrl)
      webViewProbeOk = await probeApiInWebView(controller, baseUrl)
    }

    const probeOk = getStoredCookieHeader() ? await probeApi(baseUrl) : false
    if (probeOk) {
      saveSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, false)
      sessionReady = true
      disposeWebViewController()
      //console.log("[animepaheSession] Exported cookies work with fetch()")
      return true
    }

    if (webViewProbeOk) {
      saveSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, true)
      sessionReady = true
      //console.log("[animepaheSession] Live WebView session active — API via WebView")
      return true
    }

    disposeWebViewController()
    return false
  } catch (err) {
    disposeWebViewController()
    //console.error("[animepaheSession] WebView capture failed:", err)
    return false
  }
}

async function runBootstrap(): Promise<boolean> {
  if (useApiMode()) {
    sessionReady = true
    return true
  }

  const baseUrl = getBaseUrl()
 // console.log("[animepaheSession] Bootstrapping session for", baseUrl)

  if (isWebViewSessionActive() && webViewController) {
    sessionReady = true
    return true
  }

 // console.log("[animepaheSession] Probing API /api?m=search&q=a")
  const probe = await probeApiStatus(baseUrl)
  if (probe.ok) {
    sessionReady = true
    saveSetting(STORAGE_KEYS.ANIMEPAHE_WEBVIEW_SESSION, false)
    //console.log("[animepaheSession] Boot probe HTTP", String(probe.status), "— session ready")
    return true
  }

  console.log(
    "[animepaheSession] Boot probe HTTP",
    String(probe.status),
    probe.reason || "",
    "— opening verification"
  )

  const verified = await captureSessionFromWebView(baseUrl)
  sessionReady = verified

  // Pre-warm kwik.cx CF session in the background so the first episode request
  // doesn't stall. Mirrors Aniyomi: CF bypass is resolved before video play.
  if (verified && webViewController && !getStoredKwikCookies().cookies) {
    captureKwikCookies().catch(e => console.log("[kwikCF] boot pre-warm failed:", String(e)))
  }

  return verified
}

/** Load animepahe main page on boot: probe API first, WebView sheet only on 403/challenge. */
export async function bootstrapAnimepaheSession(): Promise<boolean> {
  if (isWebViewSessionActive()) return true
  if (sessionReady) return true
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
  if (sessionReady) return true
  return bootstrapAnimepaheSession()
}

/** Manual re-verify from Settings (probe → WebView sheet if blocked). */
export async function refreshAnimepaheSession(): Promise<boolean> {
  clearStoredSession()
  return bootstrapAnimepaheSession()
}

// ── kwik.cx session ────────────────────────────────────────────────────────────

/** Return saved kwik.cx CF cookies + User-Agent from storage. */
export function getStoredKwikCookies(): { cookies: string; userAgent: string } {
  return {
    cookies: loadSetting(STORAGE_KEYS.KWIK_COOKIES, ""),
    userAgent: loadSetting(STORAGE_KEYS.KWIK_USER_AGENT, ""),
  }
}

function saveKwikCookies(cookies: string, userAgent: string): void {
  saveSetting(STORAGE_KEYS.KWIK_COOKIES, cookies)
  if (userAgent) saveSetting(STORAGE_KEYS.KWIK_USER_AGENT, userAgent)
}

/**
 * Navigate the live (background) WebView to kwik.cx, let it solve the
 * Cloudflare challenge, save the resulting cookies + User-Agent to storage,
 * then navigate back to animepahe.pw.
 *
 * Mirrors Aniyomi's CloudflareBypass.getCookies() + fetchKwikHtml flow.
 * Should be called once (on demand) and results reused across requests, just
 * like the animepahe.pw session.
 */
async function waitForKwikCaptureFree(): Promise<void> {
  while (_kwikCapturing) await new Promise<void>(r => setTimeout(r, 200))
}

export async function captureKwikCookies(): Promise<{ cookies: string; userAgent: string }> {
  if (!webViewController) throw new Error("[kwikCF] no active WebView session")
  await waitForKwikCaptureFree()

  _kwikCapturing = true
  console.log("[kwikCF] navigating WebView to kwik.cx for CF session capture")
  try {
    webViewController.setCustomUserAgent(HARDWIRED_UA)
    await webViewController.loadURL("https://kwik.cx/") } catch { /* ignore */ }

  // Poll cookie jar until kwik.cx cf_clearance appears
  const deadline = Date.now() + 25000
  let result: { cookies: string; userAgent: string } | null = null

  while (Date.now() < deadline) {
    await new Promise<void>(r => setTimeout(r, 800))
    try {
      if (typeof webViewController.getAllCookies !== "function") break
      const all: any[] = (await webViewController.getAllCookies()) || []
      const kwik = all.filter((c: any) => {
        const d = ((c.domain as string) || "").replace(/^\./, "").toLowerCase()
        return d === "kwik.cx" || d.endsWith(".kwik.cx")
      })
      if (!kwik.some((c: any) => c.name === "cf_clearance")) {
        console.log("[kwikCF] no cf_clearance yet, kwik cookie count:", kwik.length)
        continue
      }
      const cookieHeader = kwik
        .filter((c: any) => c.name && c.value)
        .map((c: any) => (c.name as string) + "=" + (c.value as string))
        .join("; ")
      let userAgent = ""
      try {
        userAgent = String((await enqueueWebViewScript(webViewController, "return navigator.userAgent")) || "")
      } catch { /* ignore */ }
      console.log("[kwikCF] cf_clearance obtained, cookies len:", cookieHeader.length, "UA:", userAgent.slice(0, 80))
      result = { cookies: cookieHeader, userAgent }
      break
    } catch (e) {
      console.log("[kwikCF] poll error:", String(e))
    }
  }

  // Navigate the WebView back to animepahe.pw so iframe injections keep working
  const baseUrl = getBaseUrl()
  console.log("[kwikCF] navigating WebView back to animepahe.pw")
  try { 
    webViewController.setCustomUserAgent(HARDWIRED_UA)
    await webViewController.loadURL(baseUrl + "/") } catch { /* ignore */ }
  // Give the page time to settle before the next iframe injection
  await new Promise<void>(r => setTimeout(r, 3000))
  _kwikCapturing = false

  if (!result) {
    console.log("[kwikCF] timed out waiting for kwik.cx cf_clearance")
    throw new Error("[kwikCF] kwik.cx CF clearance not obtained")
  }

  saveKwikCookies(result.cookies, result.userAgent)
  return result
}

