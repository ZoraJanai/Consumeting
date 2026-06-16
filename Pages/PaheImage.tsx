import { Image, useEffect, useState } from "scripting"
import { isLocalPosterPath, normalizePaheUrl, paheFetchImage } from "../scripts/animepaheClient"

type PaheImageProps = {
  url: string
  animeSession?: string
  aspectRatio?: { contentMode: string; value: number }
  frame?: Record<string, any>
  resizable?: boolean
  padding?: number
}

function isRemotePahePoster(url: string): boolean {
  if (!url || url.indexOf("http") !== 0) return false
  const lower = url.toLowerCase()
  return lower.indexOf("anilist.co") < 0 && lower.indexOf("ibb.co") < 0
}

export function PaheImage(props: PaheImageProps) {
  const rawUrl = props.url
  const url = normalizePaheUrl(rawUrl)
  const isLocal = isLocalPosterPath(url)
  const needsFetch = isRemotePahePoster(url)
  const [uiImage, setUiImage] = useState<any>(null)
  const [filePath, setFilePath] = useState(isLocal ? url : "")

  useEffect(
    function () {
      let cancelled = false
      setUiImage(null)
      setFilePath(isLocal ? url : "")

      if (!url) return

      if (isLocal) {
        console.log("[paheImage] local file", url)
        return
      }

      if (!needsFetch) {
        console.log("[paheImage] direct url", url.slice(0, 80))
        return
      }

      console.log("[paheImage] fetch", url.slice(0, 80), "session=" + String(props.animeSession || ""))

      paheFetchImage(url, { animeSession: props.animeSession })
        .then(function (result) {
          if (cancelled || !result) return
          if (result.kind === "ui") {
            setUiImage(result.image)
          } else if (result.kind === "file") {
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
    [rawUrl, url, isLocal, needsFetch, props.animeSession]
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
