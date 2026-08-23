import { Bot } from '@monotykamary/dsh-client-ui-primitives'
import type { FactoryModelChoice } from './factory-client.ts'
import { FactorySelectMenu } from './FactorySelectMenu.tsx'

/** Concrete provider/model selector that always presents the effective model name. */
export function FactoryModelSelect({ value, choices, ariaLabel, onChange }: {
  value: string
  choices: readonly FactoryModelChoice[]
  ariaLabel: string
  onChange: (model: string) => void
}) {
  const items = [
    ...choices.map(choice => ({ id: choice.id, label: choice.label, icon: <Bot size={12} /> })),
    ...(choices.some(choice => choice.id === value) ? [] : [{ id: value, label: value, icon: <Bot size={12} /> }]),
  ]
  return (
    <FactorySelectMenu
      value={value}
      items={items}
      placeholder="Select model"
      ariaLabel={ariaLabel}
      onSelect={onChange}
    />
  )
}
