export * from './types.ts'
export * from './graph.ts'
export * from './schema.ts'
export * from './schedule.ts'

import type { FactoryDocument } from './types.ts'

/** Create the only currently accepted durable document format. */
export function emptyFactoryDocument(): FactoryDocument {
  return { formatVersion: 0, nextTaskNumber: 1, projects: [], tasks: [], flows: [], runs: [], activities: [], metadataGenerations: [] }
}
