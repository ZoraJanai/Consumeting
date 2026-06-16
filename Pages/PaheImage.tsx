import { Image, RoundedRectangle, useEffect, useState } from "scripting"
import {
  isLocalPosterPath,
  needsPosterAuthFetch,
  normalizePaheUrl,
  paheFetchImage,
} from "../scripts/animepaheClient"

type PosterAspectRatio = {
  contentMode: "fit" | "fill"
  value: number
}

type PaheImageProps = {
  url: string
  /** Sets Referer to /anime/{session} — matches browser poster requests. */
  animeSession?: string
  aspectRatio?: PosterAspectRatio
  frame?: Record<string, any>
  resizable?: boolean
  padding?: number
}

/**
 * Animepahe posters need Cloudflare cookies + Referer via fetch() — plain imageUrl cannot send them.
 * Anilist and other hosts use direct imageUrl.
 */
export function PaheImage(props: PaheImageProps) {
  const url = normalizePaheUrl(props.url)
  const needsAuth = needsPosterAuthFetch(url)
  const [displayUrl, setDisplayUrl] = useState("")
  const [filePath, setFilePath] = useState(isLocalPosterPath(url) ? url : "")
  const [uiImage, setUiImage] = useState<any>(null)

  const layout = {
    aspectRatio: props.aspectRatio,
    frame: props.frame,
    resizable: props.resizable,
    padding: props.padding,
  }

  useEffect(
    function () {
      if (!url) {
        setDisplayUrl("")
        setFilePath("")
        setUiImage(null)
        return
      }

      if (isLocalPosterPath(url)) {
        setFilePath(url)
        setDisplayUrl("")
        setUiImage(null)
        return
      }

      if (url.indexOf("data:image") === 0) {
        setDisplayUrl(url)
        setFilePath("")
        setUiImage(null)
        return
      }

      if (!needsAuth) {
        setDisplayUrl(url)
        setFilePath("")
        setUiImage(null)
        return
      }

      let cancelled = false
      setDisplayUrl("")
      setFilePath("")
      setUiImage(null)

      paheFetchImage(url, { animeSession: props.animeSession })
        .then(function (result) {
          if (cancelled || !result) return
          if (result.kind === "dataUrl") setDisplayUrl(result.url)
          if (result.kind === "file") setFilePath(result.path)
          if (result.kind === "ui") setUiImage(result.image)
        })
        .catch(function (err) {
          if (!cancelled) console.log("[paheImage] error", String(err))
        })

      return function () {
        cancelled = true
      }
    },
    [url, needsAuth, props.animeSession]
  )

  if (uiImage) {
    return <Image image={uiImage} {...layout} />
  }
  if (filePath) {
    return <Image filePath={filePath} {...layout} />
  }
  if (displayUrl) {
    return <Image imageUrl={displayUrl} {...layout} />
  }
  if (!needsAuth && url) {
    return <Image imageUrl={url} {...layout} />
  }
  return <RoundedRectangle fill="tertiarySystemFill" cornerRadius={8} {...layout} />
}
