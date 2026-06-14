export const STORAGE_KEYS = {
  VIDEO_PLAYER: "settings.videoPlayer",
  AUTO_QUALITY: "settings.autoQuality",
  QUALITY_ORDER: "settings.qualityOrder",
  PROVIDER: "settings.provider",
  CACHE_PATH: "cache.path",
  QUEUE_PATH: "queue.path",
  ANIMEPAHE_BASE_URL: "settings.animepaheBaseUrl",
  ANIMEPAHE_API_URL: "settings.animepaheApiUrl",
  ANIMEPAHE_COOKIES: "settings.animepaheCookies",
  RUST_PROXY_URL: "settings.rustProxyUrl",
}

export function loadSetting<T>(key: string, defaultValue: T): T {
  if (Storage.contains(key)) {
    try {
      const stored = Storage.get<any>(key)
      return typeof defaultValue === "object" ? JSON.parse(stored) : stored
    } catch {
      return defaultValue
    }
  }
  return defaultValue
}

export function saveSetting(key: string, value: any) {
  Storage.set(key, typeof value === "object" ? JSON.stringify(value) : value)
}
