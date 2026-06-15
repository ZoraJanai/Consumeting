import { Image, useEffect, useState } from "scripting"
import { normalizePaheUrl, paheFetchImage } from "../scripts/animepaheClient"

type PaheImageProps = {
  url: string
  /** Animepahe session id — sets Referer to /anime/{session} like Chrome. */
  animeSession?: string
  aspectRatio?: { contentMode: string; value: number }
  frame?: Record<string, any>
  resizable?: boolean
  padding?: number
}

function isExternalImage(url: string): boolean {
  if (!url || url.indexOf("http") !== 0) return false
  const lower = url.toLowerCase()
  return lower.indexOf("anilist.co") < 0 && lower.indexOf("ibb.co") < 0
}

/** Poster with session headers when needed. WebP posters use filePath (UIImage is PNG/JPEG only). */
export function PaheImage(props: PaheImageProps) {
  const rawUrl = props.url
  const url = normalizePaheUrl(rawUrl)
  const needsAuth = isExternalImage(url)
  const [uiImage, setUiImage] = useState<any>(null)
  const [filePath, setFilePath] = useState("")

  useEffect(
    function () {
      let cancelled = false
      setUiImage(null)
      setFilePath("")

      if (!url) return

      if (!needsAuth) {
        console.log("[paheImage] direct url", url.slice(0, 80))
        return
      }

      console.log("[paheImage] fetch", url.slice(0, 80), "session=" + String(props.animeSession || ""))

      paheFetchImage(url, { animeSession: props.animeSession })
        .then(function (result) {
          if (cancelled || !result) return
          if (result.kind === "ui") {
            console.log("[paheImage] display ui image", url.slice(0, 80))
            setUiImage(result.image)
          } else if (result.kind === "file") {
            console.log("[paheImage] display file", result.path)
            setFilePath(result.path)
          }
        })
        .catch(function (err) {
          if (!cancelled) console.log("[paheImage] error", String(err))
        })

      return function () {
        cancelled = true
      }
    },
    [rawUrl, url, needsAuth, props.animeSession]
  )

  return (
    <Image
      image={uiImage || undefined}
      filePath={!uiImage && filePath ? filePath : undefined}
      imageUrl={!uiImage && !filePath ? url : undefined}
      aspectRatio={props.aspectRatio}
      frame={props.frame}
      resizable={props.resizable}
      padding={props.padding}
    />
  )
}
