import type { FactoryRecurringSchedule } from './types.ts'

/** Default recurring schedule used by task composers. */
export const DEFAULT_FACTORY_RECURRING_SCHEDULE: FactoryRecurringSchedule = { kind: 'weekdays', hour: 9, minute: 0 }

/** Compile one friendly recurring schedule to a five-field local-time cron expression. @param schedule - Structured schedule. @returns Cron expression. */
export function factoryRecurringCron(schedule: FactoryRecurringSchedule): string {
  switch (schedule.kind) {
    case 'hourly': return `${String(schedule.minute)} * * * *`
    case 'daily': return `${String(schedule.minute)} ${String(schedule.hour)} * * *`
    case 'weekdays': return `${String(schedule.minute)} ${String(schedule.hour)} * * 1-5`
    case 'weekly': return `${String(schedule.minute)} ${String(schedule.hour)} * * ${[...new Set(schedule.weekdays)].toSorted((left, right) => left - right).join(',')}`
    case 'monthly': return `${String(schedule.minute)} ${String(schedule.hour)} ${String(schedule.dayOfMonth)} * *`
    case 'cron': return schedule.expression.trim()
    default: return assertNever(schedule)
  }
}

/** Format one recurring schedule for task rows, cards, and Triage. @param schedule - Structured schedule. @returns User-facing cadence. */
export function factoryRecurringLabel(schedule: FactoryRecurringSchedule): string {
  const time = 'hour' in schedule ? new Date(2000, 0, 1, schedule.hour, schedule.minute).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : undefined
  switch (schedule.kind) {
    case 'hourly': return schedule.minute === 0 ? 'Every hour' : `Hourly at :${String(schedule.minute).padStart(2, '0')}`
    case 'daily': return `Daily at ${time}`
    case 'weekdays': return `Weekdays at ${time}`
    case 'weekly': return `${schedule.weekdays.map(day => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ')} at ${time}`
    case 'monthly': return `Monthly on day ${String(schedule.dayOfMonth)} at ${time}`
    case 'cron': return `Cron: ${schedule.expression.trim()}`
    default: return assertNever(schedule)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Factory recurring schedule ${JSON.stringify(value)}`)
}
