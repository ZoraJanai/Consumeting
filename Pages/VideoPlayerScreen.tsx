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

function VideoPlayerScreen({ url, headers, title }: BuiltInPlayerOptions) {
  const dismiss = Navigation.useDismiss()
  const player = useMemo(() => new AVPlayer(), [])
  const ref = useMemo(
    () => ({ interval: null as any, hideTimer: null as any, scrubbing: false }),
    []
  )

  const [isPlaying, setIsPlaying] = useState(false)
  const [buffering, setBuffering] = useState(true)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [locked, setLocked] = useState(false)
  const [aspectFill, setAspectFill] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

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
    let disposed = false

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
      if (disposed) return
      setDuration(player.duration || 0)
      setBuffering(false)
      player.play()
      setIsPlaying(true)
    }
    player.onTimeControlStatusChanged = (status: any) => {
      if (disposed) return
      setBuffering(status === TimeControlStatus.waitingToPlayAtSpecifiedRate)
      setIsPlaying(status === TimeControlStatus.playing)
    }
    player.onError = (message: string) => {
      if (disposed) return
      setErrorMsg(message || "Playback failed")
      setBuffering(false)
    }
    player.onEnded = () => {
      if (disposed) return
      setIsPlaying(false)
      revealControls()
    }

    ;(async () => {
      try {
        await ensureHlsProxy()
        if (disposed) return
        const source = proxiedPlaylistUrl(url, headers || {})
        if (!player.setSource(source)) {
          setErrorMsg("Could not load source")
          setBuffering(false)
        }
      } catch (e) {
        if (!disposed) {
          setErrorMsg(String(e))
          setBuffering(false)
        }
      }
    })()

    ref.interval = setInterval(() => {
      if (ref.scrubbing) return
      setCurrent(player.currentTime || 0)
      const d = player.duration || 0
      setDuration(prev => (d && Math.abs(prev - d) > 0.5 ? d : prev))
    }, 500)

    scheduleHide()

    return () => {
      disposed = true
      if (ref.interval) clearInterval(ref.interval)
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
export function presentBuiltInPlayer(opts: BuiltInPlayerOptions) {
  Navigation.present({
    element: <VideoPlayerScreen url={opts.url} headers={opts.headers} title={opts.title} />,
    modalPresentationStyle: "fullScreen",
  })
}
