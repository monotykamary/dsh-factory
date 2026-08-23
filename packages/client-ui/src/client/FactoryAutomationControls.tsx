import { Clock3 } from '@monotykamary/dsh-client-ui-primitives'
import {
  DEFAULT_FACTORY_RECURRING_SCHEDULE, factoryRecurringLabel,
  type FactoryAutomationSpec, type FactoryRecurringSchedule, type FactoryTaskAutomation,
} from 'dsh-factory-protocol'
import { FactorySelectMenu, type FactorySelectOption } from './FactorySelectMenu.tsx'
import css from './FactoryApp.module.css'

export type FactoryAutomationMode = 'immediate' | 'manual' | 'schedule' | 'recurring' | `delay-${number}`

/** Standard task-timing choices for prompt composers. */
export const FACTORY_AUTOMATION_OPTIONS: readonly FactorySelectOption[] = [
  { id: 'immediate', label: 'After prerequisites', icon: <Clock3 size={13} /> },
  { id: 'manual', label: 'Manual start', icon: <Clock3 size={13} /> },
  { id: 'delay-5', label: 'Wait 5 minutes', icon: <Clock3 size={13} /> },
  { id: 'delay-30', label: 'Wait 30 minutes', icon: <Clock3 size={13} /> },
  { id: 'delay-60', label: 'Wait 1 hour', icon: <Clock3 size={13} /> },
  { id: 'schedule', label: 'Run once at a date and time', icon: <Clock3 size={13} /> },
  { id: 'recurring', label: 'Recurring schedule', icon: <Clock3 size={13} /> },
]

const RECURRING_FREQUENCIES: readonly FactorySelectOption[] = [
  { id: 'hourly', label: 'Every hour' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'cron', label: 'Custom cron' },
]

/** Convert a persisted ISO schedule to a datetime-local input value. */
export function automationScheduleValue(automation?: FactoryAutomationSpec | FactoryTaskAutomation): string {
  if (automation?.trigger.kind !== 'schedule') return ''
  const date = new Date(automation.trigger.at)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/** Return a detached recurring schedule for composer state. */
export function automationRecurringValue(automation?: FactoryAutomationSpec | FactoryTaskAutomation): FactoryRecurringSchedule {
  return automation?.trigger.kind === 'recurring'
    ? structuredClone(automation.trigger.schedule)
    : structuredClone(DEFAULT_FACTORY_RECURRING_SCHEDULE)
}

/** Convert durable timing into one editor mode. */
export function automationMode(automation?: FactoryAutomationSpec | FactoryTaskAutomation): FactoryAutomationMode {
  if (automation === undefined) return 'immediate'
  if (automation.trigger.kind === 'manual') return 'manual'
  if (automation.trigger.kind === 'schedule') return 'schedule'
  if (automation.trigger.kind === 'recurring') return 'recurring'
  return `delay-${String(automation.trigger.delayMinutes)}` as `delay-${number}`
}

/** Convert editor timing state to a durable automation specification. */
export function automationSpec(mode: FactoryAutomationMode, scheduleAt: string, recurring: FactoryRecurringSchedule): FactoryAutomationSpec | undefined {
  if (mode === 'immediate') return undefined
  if (mode === 'manual') return { trigger: { kind: 'manual' }, enabled: true }
  if (mode === 'schedule') {
    if (scheduleAt === '') throw new Error('Choose a date and time for this automation')
    return { trigger: { kind: 'schedule', at: new Date(scheduleAt).toISOString() }, enabled: true }
  }
  if (mode === 'recurring') return { trigger: { kind: 'recurring', schedule: structuredClone(recurring) }, enabled: true }
  const delayMinutes = Number(mode.slice('delay-'.length))
  return { trigger: { kind: 'delay', delayMinutes }, enabled: true }
}

/** User-facing summary for durable task timing. */
export function automationSummary(automation?: FactoryAutomationSpec | FactoryTaskAutomation): string {
  if (automation === undefined) return 'After prerequisites'
  const label = automation.trigger.kind === 'manual'
    ? 'Manual start'
    : automation.trigger.kind === 'delay'
      ? `Wait ${String(automation.trigger.delayMinutes)} min`
      : automation.trigger.kind === 'schedule'
        ? `Once ${new Date(automation.trigger.at).toLocaleString()}`
        : factoryRecurringLabel(automation.trigger.schedule)
  if (automation.enabled === false) return `${label} · paused`
  return 'nextRunAt' in automation && automation.nextRunAt !== undefined && automation.trigger.kind === 'recurring'
    ? `${label} · next ${new Date(automation.nextRunAt).toLocaleString()}`
    : label
}

/** DSH Menu-backed timing selector for a prompt composer settings row. */
export function AutomationSelect({ value, onChange }: { value: FactoryAutomationMode; onChange: (value: FactoryAutomationMode) => void }) {
  const items = FACTORY_AUTOMATION_OPTIONS.some(option => option.id === value)
    ? FACTORY_AUTOMATION_OPTIONS
    : [...FACTORY_AUTOMATION_OPTIONS, { id: value, label: `Wait ${value.slice('delay-'.length)} minutes`, icon: <Clock3 size={13} /> }]
  return <FactorySelectMenu value={value} items={items} placeholder="Timing" ariaLabel="Automation timing" onSelect={id => { onChange(id as FactoryAutomationMode) }} />
}

/** Friendly hour/date controls with a raw five-field cron escape hatch. */
export function RecurringScheduleEditor({ value, onChange }: { value: FactoryRecurringSchedule; onChange: (value: FactoryRecurringSchedule) => void }) {
  const time = 'hour' in value ? `${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}` : '09:00'
  const setTime = (next: string): void => {
    const [hourText, minuteText] = next.split(':')
    const hour = Number(hourText); const minute = Number(minuteText)
    if (!('hour' in value) || !Number.isInteger(hour) || !Number.isInteger(minute)) return
    onChange({ ...value, hour, minute })
  }
  const selectFrequency = (kind: string): void => {
    const [hourText, minuteText] = time.split(':')
    const hour = Number(hourText); const minute = Number(minuteText)
    switch (kind) {
      case 'hourly': onChange({ kind: 'hourly', minute }); break
      case 'daily': onChange({ kind: 'daily', hour, minute }); break
      case 'weekdays': onChange({ kind: 'weekdays', hour, minute }); break
      case 'weekly': onChange({ kind: 'weekly', weekdays: [new Date().getDay()], hour, minute }); break
      case 'monthly': onChange({ kind: 'monthly', dayOfMonth: new Date().getDate(), hour, minute }); break
      case 'cron': onChange({ kind: 'cron', expression: '0 9 * * 1-5' }); break
    }
  }
  const date = value.kind === 'weekly'
    ? dateForWeekday(value.weekdays[0] ?? 1)
    : value.kind === 'monthly' ? dateForDayOfMonth(value.dayOfMonth) : ''
  return (
    <div className={css.recurringEditor} data-testid="factory-recurring-editor">
      <div className={css.recurringFrequency}>
        <span>Cadence</span>
        <FactorySelectMenu value={value.kind} items={RECURRING_FREQUENCIES} placeholder="Frequency" ariaLabel="Schedule frequency" onSelect={selectFrequency} />
      </div>
      {value.kind === 'hourly' ? (
        <label><span>Minute past hour</span><input type="number" min={0} max={59} value={value.minute} onChange={event => { onChange({ ...value, minute: Number(event.target.value) }) }} /></label>
      ) : value.kind === 'cron' ? (
        <label className={css.recurringWide}><span>Cron expression</span><input aria-label="Cron expression" value={value.expression} onChange={event => { onChange({ kind: 'cron', expression: event.target.value }) }} placeholder="0 9 * * 1-5" /><small>minute hour day month weekday · host local time</small></label>
      ) : (
        <div className={css.recurringInputs}>
          {(value.kind === 'weekly' || value.kind === 'monthly') ? <label><span>{value.kind === 'weekly' ? 'Day of week' : 'Day of month'}</span><input type="date" value={date} onChange={event => {
            const selected = new Date(`${event.target.value}T12:00:00`)
            if (Number.isNaN(selected.getTime())) return
            if (value.kind === 'weekly') onChange({ ...value, weekdays: [selected.getDay()] })
            else onChange({ ...value, dayOfMonth: selected.getDate() })
          }} /></label> : null}
          <label><span>Time</span><input type="time" value={time} onChange={event => { setTime(event.target.value) }} /></label>
        </div>
      )}
    </div>
  )
}

function localDateValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function dateForWeekday(weekday: number): string {
  const date = new Date(); date.setDate(date.getDate() + ((weekday - date.getDay() + 7) % 7))
  return localDateValue(date)
}

function dateForDayOfMonth(day: number): string {
  const date = new Date(); date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()))
  return localDateValue(date)
}
