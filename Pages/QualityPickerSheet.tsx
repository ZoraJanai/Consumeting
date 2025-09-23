// Pages/QualityPickerSheet.tsx
import {
  Button, Divider, HStack, RoundedRectangle, Spacer, Text, VStack, ZStack,
  useMemo, useState
} from "scripting"

const DEFAULT_ORDER = [
  "-1080p BD","-1080p","-816p chi","-720p","-default","-auto","-480p","-360p"
]

function sortQualitiesBestFirst(tags: string[], order = DEFAULT_ORDER) {
  const idx = new Map(order.map((q, i) => [q.toLowerCase(), i]))
  return [...new Set(tags)].sort((a, b) => {
    const ia = idx.get(a.toLowerCase())
    const ib = idx.get(b.toLowerCase())
    const ca = ia ?? 999 + a.length
    const cb = ib ?? 999 + b.length
    return ca - cb || a.localeCompare(b)
  })
}

export function QualityPickerSheet({
  title = "Which quality?",
  options,
  order = DEFAULT_ORDER,
  onPicked,
  onClose
}: {
  title?: string
  options: string[]
  order?: string[]
  onPicked: (tag: string) => void
  onClose: () => void
}) {
  const rows = useMemo(() => sortQualitiesBestFirst(options ?? [], order), [options, order])

  // layout constants
  const ROW_H = 52
  const DIV_H = 1
  const PADDING_TOP = 16
  const PADDING_BOTTOM = 12
  const VSTACK_SPACING = 12
  const TITLE_H = 24
  const GAP_BEFORE_CANCEL = 8
  const CANCEL_H = 52
  const SAFE_BOTTOM = 24

  const visible = Math.min(rows.length, 6)
  const listHeight = visible * ROW_H + Math.max(0, visible - 1) * DIV_H

  const detent =
    PADDING_TOP +
    TITLE_H +
    VSTACK_SPACING +
    listHeight +
    GAP_BEFORE_CANCEL +
    CANCEL_H +
    PADDING_BOTTOM +
    SAFE_BOTTOM

  // tap highlight flash (stronger + a bit longer)
  const [flashIndex, setFlashIndex] = useState<number | null>(null)
  const flash = (i: number) => {
    setFlashIndex(i)
    setTimeout(() => setFlashIndex(prev => (prev === i ? null : prev)), 160)
  }

  return (
    <VStack
      spacing={12}
      presentationDragIndicator="visible"
      presentationDetents={[detent]}
      padding={{ top: PADDING_TOP, leading: 16, trailing: 16, bottom: PADDING_BOTTOM }}
    >
      <Text
        font={20}
        fontWeight="semibold"
        lineLimit={1}
        truncationMode="tail"
        multilineTextAlignment="center"
        foregroundStyle="white"
        frame={{ maxWidth: "infinity", height: TITLE_H }}
      >
        {title}
      </Text>

      {/* ONE rounded container for the list */}
      <ZStack clipped frame={{ height: listHeight }}>
        <RoundedRectangle fill="tertiarySystemBackground" cornerRadius={18} />

        <VStack spacing={0} clipped>
          {rows.slice(0, visible).map((q, i) => {
            const isLast = i === visible - 1
            return (
              <ZStack key={q} frame={{ height: ROW_H }} clipped>
                {/* tap flash overlay */}
                {flashIndex === i ? (
                  <RoundedRectangle fill="systemFill" cornerRadius={0} />
                ) : null}

                {/* content */}
                <HStack
                  alignment="center"
                  padding={{ leading: 18, trailing: 18 }}
                  frame={{ maxWidth: "infinity", height: ROW_H, alignment: "leading" }}
                >
                  <Text
                    font={17}
                    fontWeight="medium"
                    lineLimit={1}
                    truncationMode="tail"
                    foregroundStyle="white"
                  >
                    {q.replace(/^\-/, "")}
                  </Text>
                  <Spacer />
                </HStack>

                {/* divider pinned to BOTTOM so it never crosses text */}
                {!isLast ? (
                  <VStack spacing={0} frame={{ height: ROW_H }}>
                    <Spacer />
                    <Divider />
                  </VStack>
                ) : null}

                {/* full-row hit target (keeps text styling) */}
                <Button
                  action={() => {
                    flash(i)
                    onPicked(q)
                    onClose()
                  }}
                >
                  <RoundedRectangle fill="clear" cornerRadius={0} />
                </Button>
              </ZStack>
            )
          })}
        </VStack>
      </ZStack>

      {/* gap + cancel */}
      <VStack frame={{ height: GAP_BEFORE_CANCEL }} />
      <ZStack frame={{ height: CANCEL_H }} clipped>
        <RoundedRectangle fill="tertiarySystemBackground" cornerRadius={18} />
        <HStack alignment="center" frame={{ maxWidth: "infinity", height: CANCEL_H }}>
          <Text font={17} fontWeight="semibold" foregroundStyle="white">Cancel</Text>
        </HStack>
        <Button action={onClose}>
          <RoundedRectangle fill="clear" cornerRadius={18} />
        </Button>
      </ZStack>
    </VStack>
  )
}