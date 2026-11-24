// Adapted from the shadcn/ui Radix Select. See site/THIRD_PARTY_NOTICES.md.
import * as Select from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'

export function FormSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled,
  id
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  id?: string
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <Select.Root
      disabled={disabled}
      value={options.some((entry) => entry.value === value) ? 'item:' + value : ''}
      onValueChange={(value) => {
        const option = options.find((entry) => 'item:' + entry.value === value)
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
              <Select.Item key={option.value} value={'item:' + option.value} className="dashboard-select-option">
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

const clockOptions = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const value = String(i).padStart(2, '0')
    return { value, label: value }
  })
const hours = clockOptions(24)
const minutes = clockOptions(60)

export function TimeField({
  label,
  value,
  onChange,
  disabled
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const [hour, minute] = value.split(':')
  return (
    <div className="dashboard-time" role="group" aria-label={label}>
      <FormSelect
        label={label + ' hour'}
        value={hour ?? ''}
        options={hours}
        disabled={disabled}
        onChange={(next) => onChange(next + ':' + (minute || '00'))}
      />
      <span aria-hidden="true">:</span>
      <FormSelect
        label={label + ' minute'}
        value={minute ?? ''}
        options={minutes}
        disabled={disabled}
        onChange={(next) => onChange((hour || '00') + ':' + next)}
      />
    </div>
  )
}
