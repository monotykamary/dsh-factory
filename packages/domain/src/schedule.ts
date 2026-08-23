import { Cron } from 'croner'
import { factoryRecurringCron, type FactoryRecurringSchedule } from 'dsh-factory-protocol'

const CRON_ALIAS = /^@(annually|yearly|monthly|weekly|daily|midnight|hourly)$/u

/**
 * Validate a recurring schedule and return its normalized detached value.
 * @param schedule - Friendly schedule or raw cron input.
 * @returns A normalized schedule safe for durable storage.
 */
export function normalizeFactoryRecurringSchedule(schedule: FactoryRecurringSchedule): FactoryRecurringSchedule {
  const integer = (value: number, minimum: number, maximum: number, field: string): number => {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Factory recurring ${field} must be an integer from ${String(minimum)} to ${String(maximum)}`)
    return value
  }
  let normalized: FactoryRecurringSchedule
  switch (schedule.kind) {
    case 'hourly': normalized = { kind: 'hourly', minute: integer(schedule.minute, 0, 59, 'minute') }; break
    case 'daily': normalized = { kind: 'daily', hour: integer(schedule.hour, 0, 23, 'hour'), minute: integer(schedule.minute, 0, 59, 'minute') }; break
    case 'weekdays': normalized = { kind: 'weekdays', hour: integer(schedule.hour, 0, 23, 'hour'), minute: integer(schedule.minute, 0, 59, 'minute') }; break
    case 'weekly': {
      const weekdays = [...new Set(schedule.weekdays.map(day => integer(day, 0, 6, 'weekday')))].toSorted((left, right) => left - right)
      if (weekdays.length === 0) throw new Error('Factory recurring weekly schedule requires at least one weekday')
      normalized = { kind: 'weekly', weekdays, hour: integer(schedule.hour, 0, 23, 'hour'), minute: integer(schedule.minute, 0, 59, 'minute') }
      break
    }
    case 'monthly': normalized = { kind: 'monthly', dayOfMonth: integer(schedule.dayOfMonth, 1, 31, 'day of month'), hour: integer(schedule.hour, 0, 23, 'hour'), minute: integer(schedule.minute, 0, 59, 'minute') }; break
    case 'cron': {
      const expression = schedule.expression.trim().replaceAll(/\s+/gu, ' ')
      if (expression.length === 0 || expression.length > 256 || (!CRON_ALIAS.test(expression) && expression.split(' ').length !== 5)) throw new Error('Factory cron must be a supported alias or five fields')
      normalized = { kind: 'cron', expression }
      break
    }
    default: return assertNever(schedule)
  }
  nextFactoryRecurringRun(normalized, new Date())
  return normalized
}

/**
 * Return the next local-time occurrence strictly after a reference instant.
 * @param schedule - Validated recurring schedule.
 * @param after - Exclusive lower bound for the occurrence.
 * @returns The next occurrence as an ISO timestamp.
 */
export function nextFactoryRecurringRun(schedule: FactoryRecurringSchedule, after: Date): string {
  let next: Date | null
  try { next = new Cron(factoryRecurringCron(schedule), { paused: true }).nextRun(after) }
  catch (error) { throw new Error(`Factory recurring schedule is invalid: ${error instanceof Error ? error.message : String(error)}`) }
  if (next === null) throw new Error('Factory recurring schedule has no future occurrence')
  return next.toISOString()
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Factory recurring schedule ${JSON.stringify(value)}`)
}
