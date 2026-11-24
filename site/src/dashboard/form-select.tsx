// Adapted from the shadcn/ui Radix Select. See site/THIRD_PARTY_NOTICES.md.
import * as Select from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'

export function FormSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder,
  id
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  id?: string
  placeholder?: string
}) {
  return (
    <Select.Root
      value={value}
      onValueChange={(value) => {
        const option = options.find((entry) => entry.value === value)
        if (option) onChange(option.value)
      }}
    >
      <Select.Trigger className="dashboard-select" aria-label={label} id={id}>
        <Select.Value placeholder={placeholder} />
        <Select.Icon asChild>
          <ChevronDown size={16} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="dashboard-select-menu" position="popper" sideOffset={5} align="start">
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item key={option.value} value={option.value} className="dashboard-select-option">
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check size={15} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
