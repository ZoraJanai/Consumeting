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

type WebViewControllerInstance = {
  loadURL(url: string): Promise<boolean>
  present(options?: { fullscreen?: boolean; navigationTitle?: string }): Promise<void>
  getCookies?(url: string): Promise<WebCookie[]>
  getAllCookies?(): Promise<WebCookie[]>
  setCookie?(cookie: WebCookie): Promise<boolean>
  dispose(): void
}

declare const WebViewController: new () => WebViewControllerInstance

let bypassInFlight: Promise<string | null> | null = null

export function getStoredCookieHeader(): string {
  return loadSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, "").trim()
}

export function saveCookieHeader(header: string) {
  saveSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, header.trim())
}

export function clearStoredSession() {
  saveSetting(STORAGE_KEYS.ANIMEPAHE_COOKIES, "")
}

export function hasStoredSession(): boolean {
  return getStoredCookieHeader().length > 0
}

export function isBlockedResponse(status: number, body: string): boolean {
  if (status === 403 || status === 503) return true

  const sample = body.slice(0, 4000).toLowerCase()
  if (
    sample.includes("ddos-guard") ||
    sample.includes("checking your browser") ||
    sample.includes("just a moment") ||
    sample.includes("cf-challenge") ||
    sample.includes("cdn-cgi/challenge")
  ) {
    return true
  }

  // JSON endpoints returning an HTML challenge page
  if (status === 200 && body.trimStart().startsWith("<")) return true

  return false
}

function cookiesToHeader(cookies: WebCookie[]): string {
  const seen = new Set<string>()
  const parts: string[] = []

  for (const cookie of cookies) {
    if (!cookie.name || seen.has(cookie.name)) continue
    seen.add(cookie.name)
    parts.push(`${cookie.name}=${cookie.value}`)
  }

  return parts.join("; ")
}

function hostFromBaseUrl(baseUrl: string): string {
  return new URL(baseUrl).hostname.replace(/^www\./, "")
}

async function preloadStoredCookies(controller: WebViewControllerInstance, baseUrl: string) {
  if (!controller.setCookie) return

  const header = getStoredCookieHeader()
  if (!header) return

  const host = hostFromBaseUrl(baseUrl)
  for (const part of header.split(";")) {
    const trimmed = part.trim()
    if (!trimmed) continue

    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue

    const name = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!name || !value) continue

    try {
      await controller.setCookie({
        name,
        value,
        domain: `.${host}`,
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

async function captureCookies(controller: WebViewControllerInstance, baseUrl: string): Promise<WebCookie[]> {
  const origin = new URL(baseUrl).origin + "/"
  const host = hostFromBaseUrl(baseUrl)

  if (controller.getCookies) {
    const matched = await controller.getCookies(origin)
    if (matched.length) return matched
  }

  if (controller.getAllCookies) {
    const all = await controller.getAllCookies()
    return all.filter(cookie => cookie.domain.replace(/^\./, "").includes(host))
  }

  return []
}

async function runBypassSheet(baseUrl: string): Promise<string | null> {
  const controller = new WebViewController()

  try {
    await preloadStoredCookies(controller, baseUrl)
    await controller.loadURL(baseUrl)

    await controller.present({
      fullscreen: true,
      navigationTitle: "Complete verification",
    })

    const cookies = await captureCookies(controller, baseUrl)
    const header = cookiesToHeader(cookies)

    if (!header) {
      console.warn("[cloudflareBypass] Sheet closed without usable cookies")
      return null
    }

    saveCookieHeader(header)
    console.log("[cloudflareBypass] Session saved,", cookies.length, "cookies")
    return header
  } finally {
    controller.dispose()
  }
}

/** Show the verification browser sheet and save cookies when the user closes it. */
export async function presentCloudflareBypass(baseUrl: string): Promise<string | null> {
  if (bypassInFlight) return bypassInFlight

  bypassInFlight = runBypassSheet(baseUrl).finally(() => {
    bypassInFlight = null
  })

  return bypassInFlight
}

/**
 * If the response looks blocked, show the bypass sheet once and return true when
 * new cookies were saved (caller should retry).
 */
export async function handleBlockedResponse(
  baseUrl: string,
  status: number,
  body: string,
  alreadyRetried: boolean
): Promise<boolean> {
  if (alreadyRetried || !isBlockedResponse(status, body)) return false

  console.log("[cloudflareBypass] Blocked response detected, opening verification sheet")
  const header = await presentCloudflareBypass(baseUrl)
  return header != null && header.length > 0
}
