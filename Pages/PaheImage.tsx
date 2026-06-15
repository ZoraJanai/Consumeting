import { Image, Text, useEffect, useState } from "scripting"
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

/** Poster / CDN image with animepahe session headers (Image imageUrl cannot send cookies). */
export function PaheImage(props: PaheImageProps) {
  const rawUrl = props.url
  const url = normalizePaheUrl(rawUrl)
  const needsAuth =
    !!url &&
    url.indexOf("http") === 0 &&
    url.toLowerCase().indexOf("anilist.co") < 0 &&
    url.toLowerCase().indexOf("ibb.co") < 0
  const [uiImage, setUiImage] = useState<any>(null)
  const [filePath, setFilePath] = useState("")

  useEffect(
    function () {
      let cancelled = false
      setUiImage(null)
      setFilePath("")

      console.log(
        "[paheImage] component raw=" +
          String(rawUrl) +
          " normalized=" +
          String(url) +
          " needsAuth=" +
          String(needsAuth) +
          " session=" +
          String(props.animeSession || "")
      )

      if (!url) {
        console.log("[paheImage] component skip: empty url")
        return
      }

      if (!needsAuth) {
        console.log("[paheImage] component using plain imageUrl (not pahe-protected)")
        return
      }

      paheFetchImage(url, { animeSession: props.animeSession })
        .then(function (result) {
          if (cancelled) {
            console.log("[paheImage] component cancelled", url.slice(0, 80))
            return
          }
          if (!result) {
            console.log("[paheImage] component fetch returned null", url.slice(0, 80))
            return
          }
          if (result.kind === "ui") {
            console.log("[paheImage] component got ui image", url.slice(0, 80))
            setUiImage(result.image)
          }
          if (result.kind === "file") {
            console.log("[paheImage] component got file path", result.path)
            setFilePath(result.path)
          }
        })
        .catch(function (err) {
          if (!cancelled) {
            console.log("[paheImage] component fetch error", String(err))
          }
        })

      return function () {
        cancelled = true
      }
    },
    [rawUrl, url, needsAuth, props.animeSession]
  )

  if (!needsAuth) {
    return (
      <Image
        imageUrl={url}
        aspectRatio={props.aspectRatio}
        frame={props.frame}
        resizable={props.resizable}
        padding={props.padding}
      />
    )
  }

  if (uiImage) {
    return (
      <Image
        image={uiImage}
        aspectRatio={props.aspectRatio}
        frame={props.frame}
        resizable={props.resizable}
        padding={props.padding}
      />
    )
  }

  if (filePath) {
    return (
      <Image
        filePath={filePath}
        aspectRatio={props.aspectRatio}
        frame={props.frame}
        resizable={props.resizable}
        padding={props.padding}
      />
    )
  }

  return (
    <Image
      aspectRatio={props.aspectRatio}
      frame={props.frame}
      resizable={props.resizable}
      padding={props.padding}
      placeholder={<Text foregroundStyle="secondaryLabel"> </Text>}
    />
  )
}
