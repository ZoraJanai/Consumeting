// NumberInputSheet.tsx
import {
  Button, HStack, RoundedRectangle, Spacer, Text, TextField,
  VStack, ZStack, useState, useEffect
} from "scripting"
import { chosenAnime } from "./Cache"

export function NumberInputSheet({
  onPicked,
  onClose,
  title = "Episode number?",
  initial = "",
  total
}: {
  onPicked: (n: number) => void
  onClose: () => void
  title?: string
  initial?: string
  total: string
}) {
  const [value, setValue] = useState(initial)

  // If `initial` changes between presentations, reflect it in the field
  useEffect(() => {
    setValue(initial)
  }, [initial])

  const commit = () => {
    const n = Number(value)
    if (Number.isFinite(n)) {
      onPicked(n)
      setValue("")     // 🔑 reset before closing
      onClose()
    }
  }

  const cancel = () => {
    setValue("")       // 🔑 reset on cancel as well
    onClose()
  }

  const textFieldTitle = "of ".concat(total)
  // to .. of {total}
  // from .. of {total}
  // from {n1} to .. of {total}
  return (
    <VStack
      spacing={16}
      presentationDragIndicator="visible"
      presentationDetents={[200]}   // compact height
      padding={16}
    >
      <Text font={20} fontWeight="semibold">{title}</Text>

      <ZStack frame={{ height: 64 }} clipped>
        <RoundedRectangle fill="tertiarySystemBackground" cornerRadius={28} />
        <TextField
          title={textFieldTitle}
          value={value}
          onChanged={setValue}
          keyboardType="numberPad"
          multilineTextAlignment="center"
          font={36}
          fontWeight="bold"
          autofocus
          onSubmit={commit}
          onDisappear={cancel}
        />
      </ZStack>

      <HStack>
  {/* Cancel pill */}
  <Button action={cancel}>
    <ZStack frame={{ height: 44 }} clipped>
      <RoundedRectangle fill="secondarySystemFill" cornerRadius={24} />
      <Text foregroundStyle="white">Cancel</Text>
    </ZStack>
  </Button>

  <Spacer />

  {/* Done pill */}
  <Button action={commit}>
    <ZStack frame={{ height: 44 }} clipped>
      <RoundedRectangle fill="systemBlue" cornerRadius={24} />
      <Text foregroundStyle="white">Done</Text>
    </ZStack>
  </Button>
</HStack>
    </VStack>
  )
}