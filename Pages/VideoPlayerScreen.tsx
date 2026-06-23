// Built-in video player with an OutPlayer-style UI.
//
// Plays through the local HLS proxy (scripts/localProxy.ts) so kwik's
// Referer-gated streams work without an external proxy and without handing off
// to nPlayer/OutPlayer.

import {
  VideoPlayer,
  VStack,
  HStack,
  ZStack,
  Spacer,
  Text,
  Image,
  Button,
  Slider,
  Rectangle,
  ProgressView,
  Navigation,
  useState,
  useEffect,
  useMemo,
} from "scripting"
import { ensureHlsProxy, proxiedPlaylistUrl } from "../scripts/localProxy"

export type BuiltInPlayerOptions = {
  url: string
  headers?: Record<string, string>
  title?: string
}

const SKIP_SECONDS = 10
const AUTO_HIDE_MS = 4000
const POLL_MS = 500

function two(n: number): string {
  return (n < 10 ? "0" : "") + String(n)
}

function formatTime(t: number): string {
  if (!isFinite(t) || t < 0) t = 0
  const total = Math.floor(t)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return h > 0 ? h + ":" + two(m) + ":" + two(s) : m + ":" + two(s)
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

function VideoPlayerScreen({ src, title }: { src: string; title?: string }) {
  const dismiss = Navigation.useDismiss()

  const [isPlaying, setIsPlaying] = useState(false)
  const [buffering, setBuffering] = useState(true)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [locked, setLocked] = useState(false)
  const [aspectFill, setAspectFill] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(src ? null : "No video source")

  const ref = useMemo(
    () => ({ timer: null as any, hideTimer: null as any, scrubbing: false, disposed: false }),
    []
  )

  // Create the player and point it at the (already proxied) source synchronously
  // so VideoPlayer always has a valid player at first render.
  const player = useMemo(() => {
    const p = new AVPlayer()
    if (src) p.setSource(src)
    return p
  }, [])

  function clearHideTimer() {
    if (ref.hideTimer) {
      clearTimeout(ref.hideTimer)
      ref.hideTimer = null
    }
  }

  function scheduleHide() {
    clearHideTimer()
    ref.hideTimer = setTimeout(() => {
      if (!ref.scrubbing) setControlsVisible(false)
    }, AUTO_HIDE_MS)
  }

  function revealControls() {
    setControlsVisible(true)
    scheduleHide()
  }

  function toggleControls() {
    if (locked) return
    if (controlsVisible) {
      clearHideTimer()
      setControlsVisible(false)
    } else {
      revealControls()
    }
  }

  function togglePlay() {
    if (isPlaying) {
      player.pause()
      setIsPlaying(false)
    } else {
      player.play()
      setIsPlaying(true)
    }
    revealControls()
  }

  function seekBy(delta: number) {
    const target = clamp((player.currentTime || 0) + delta, 0, duration || 0)
    player.currentTime = target
    setCurrent(target)
    revealControls()
  }

  function onScrubChanged(value: number) {
    ref.scrubbing = true
    clearHideTimer()
    setCurrent(value)
  }

  function onScrubEditing(editing: boolean) {
    if (editing) {
      ref.scrubbing = true
      clearHideTimer()
    } else {
      player.currentTime = current
      ref.scrubbing = false
      scheduleHide()
    }
  }

  function closePlayer() {
    try {
      player.pause()
    } catch {
      /* ignore */
    }
    dismiss()
  }

  useEffect(() => {
    ref.disposed = false

    try {
      SharedAudioSession.setActive(true)
      SharedAudioSession.setCategory("playback", ["mixWithOthers"])
    } catch {
      /* ignore */
    }
    try {
      Device.setWakeLockEnabled(true)
    } catch {
      /* ignore */
    }

    player.onReadyToPlay = () => {
      if (ref.disposed) return
      setDuration(player.duration || 0)
      setBuffering(false)
      player.play()
      setIsPlaying(true)
    }
    player.onTimeControlStatusChanged = (status: any) => {
      if (ref.disposed) return
      setBuffering(status === TimeControlStatus.waitingToPlayAtSpecifiedRate)
      setIsPlaying(status === TimeControlStatus.playing)
    }
    player.onError = (message: string) => {
      if (ref.disposed) return
      setErrorMsg(message || "Playback failed")
      setBuffering(false)
    }
    player.onEnded = () => {
      if (ref.disposed) return
      setIsPlaying(false)
      revealControls()
    }

    // Scripting has no setInterval — self-reschedule a setTimeout instead.
    const poll = () => {
      if (ref.disposed) return
      if (!ref.scrubbing) {
        setCurrent(player.currentTime || 0)
        const d = player.duration || 0
        setDuration(prev => (d && Math.abs(prev - d) > 0.5 ? d : prev))
      }
      ref.timer = setTimeout(poll, POLL_MS)
    }
    ref.timer = setTimeout(poll, POLL_MS)

    scheduleHide()

    return () => {
      ref.disposed = true
      if (ref.timer) clearTimeout(ref.timer)
      clearHideTimer()
      try {
        Device.setWakeLockEnabled(false)
      } catch {
        /* ignore */
      }
      try {
        player.pause()
      } catch {
        /* ignore */
      }
      try {
        player.dispose()
      } catch {
        /* ignore */
      }
    }
  }, [])

  const sliderMax = Math.max(duration, 1)
  const sliderValue = clamp(current, 0, sliderMax)
  const remaining = Math.max(0, (duration || 0) - current)

  return (
    <ZStack
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      background="black"
      ignoresSafeArea
      persistentSystemOverlays="hidden"
    >
      <VideoPlayer
        player={player}
        videoGravity={aspectFill ? "resizeAspectFill" : "resizeAspect"}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      />

      {/* Tap target to toggle controls (always present, nearly invisible). */}
      <Rectangle
        fill="black"
        opacity={0.001}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        onTapGesture={toggleControls}
      />

      {/* Dimming scrim shown with controls. */}
      {controlsVisible && !locked ? (
        <Rectangle
          fill="black"
          opacity={0.4}
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          onTapGesture={toggleControls}
        />
      ) : null}

      {/* Buffering indicator. */}
      {buffering && !errorMsg ? (
        <ProgressView progressViewStyle="circular" tint="white" />
      ) : null}

      {/* Main controls. */}
      {controlsVisible && !locked ? (
        <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          {/* Top bar */}
          <HStack
            alignment="center"
            spacing={18}
            padding={{ leading: 18, trailing: 18, top: 14 }}
            frame={{ maxWidth: "infinity" }}
          >
            <Button buttonStyle="plain" action={closePlayer}>
              <Image systemName="chevron.down" font={22} foregroundStyle="white" />
            </Button>
            <Text
              font={16}
              fontWeight="semibold"
              foregroundStyle="white"
              lineLimit={1}
              truncationMode="tail"
              frame={{ maxWidth: "infinity" }}
              multilineTextAlignment="center"
            >
              {title || ""}
            </Text>
            <Button buttonStyle="plain" action={() => { setAspectFill(v => !v); revealControls() }}>
              <Image
                systemName={aspectFill ? "rectangle.compress.vertical" : "rectangle.expand.vertical"}
                font={20}
                foregroundStyle="white"
              />
            </Button>
            <Button buttonStyle="plain" action={() => { setLocked(true); setControlsVisible(false); clearHideTimer() }}>
              <Image systemName="lock.open" font={20} foregroundStyle="white" />
            </Button>
          </HStack>

          <Spacer />

          {/* Center transport */}
          <HStack alignment="center" spacing={56}>
            <Button buttonStyle="plain" action={() => seekBy(-SKIP_SECONDS)}>
              <Image systemName="gobackward.10" font={34} foregroundStyle="white" />
            </Button>
            <Button buttonStyle="plain" action={togglePlay}>
              <Image
                systemName={isPlaying ? "pause.fill" : "play.fill"}
                font={52}
                foregroundStyle="white"
              />
            </Button>
            <Button buttonStyle="plain" action={() => seekBy(SKIP_SECONDS)}>
              <Image systemName="goforward.10" font={34} foregroundStyle="white" />
            </Button>
          </HStack>

          <Spacer />

          {/* Bottom scrubber */}
          <VStack
            spacing={2}
            padding={{ leading: 18, trailing: 18, bottom: 18 }}
            frame={{ maxWidth: "infinity" }}
          >
            <Slider
              min={0}
              max={sliderMax}
              value={sliderValue}
              onChanged={onScrubChanged}
              onEditingChanged={onScrubEditing}
              tint="white"
            />
            <HStack frame={{ maxWidth: "infinity" }}>
              <Text font={13} foregroundStyle="white">
                {formatTime(current)}
              </Text>
              <Spacer />
              <Text font={13} foregroundStyle="white">
                {"-" + formatTime(remaining)}
              </Text>
            </HStack>
          </VStack>
        </VStack>
      ) : null}

      {/* Locked state: only an unlock affordance. */}
      {locked ? (
        <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <HStack padding={{ leading: 18, top: 14 }} frame={{ maxWidth: "infinity" }}>
            <Button
              buttonStyle="plain"
              action={() => { setLocked(false); revealControls() }}
            >
              <Image systemName="lock.fill" font={22} foregroundStyle="white" />
            </Button>
            <Spacer />
          </HStack>
          <Spacer />
        </VStack>
      ) : null}

      {/* Error overlay. */}
      {errorMsg ? (
        <VStack alignment="center" spacing={16} padding={24}>
          <Image systemName="exclamationmark.triangle.fill" font={40} foregroundStyle="orange" />
          <Text font={15} foregroundStyle="white" multilineTextAlignment="center">
            {errorMsg}
          </Text>
          <Button buttonStyle="borderedProminent" action={closePlayer}>
            <Text foregroundStyle="white">Close</Text>
          </Button>
        </VStack>
      ) : null}
    </ZStack>
  )
}

/** Present the built-in OutPlayer-style player full screen. */
export async function presentBuiltInPlayer(opts: BuiltInPlayerOptions) {
  let src = ""
  try {
    await ensureHlsProxy()
    src = proxiedPlaylistUrl(opts.url, opts.headers || {})
  } catch (e) {
    console.error("[VideoPlayerScreen] proxy failed:", String(e))
  }

  Navigation.present({
    element: <VideoPlayerScreen src={src} title={opts.title} />,
    modalPresentationStyle: "fullScreen",
  })
}
