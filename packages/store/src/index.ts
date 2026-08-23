import type { Context } from '@monotykamary/cordis'
import { Service } from '@monotykamary/cordis'
import type {
  FactoryAgentObservation, FactoryDocument, FactoryLeaderObservation, FactoryProcessId,
} from 'dsh-factory-protocol'

/** Durable document plus its compare-and-set revision. */
export interface FactoryStoreRead {
  revision: number
  document: FactoryDocument
}

/** Sentinel returned when an inspected transaction has no durable edit to commit. */
export const FACTORY_STORE_NO_CHANGE: unique symbol = Symbol('factory-store-no-change')

/** Synchronous mutation executed inside one provider transaction. */
export type FactoryStoreMutation = (draft: FactoryDocument) => void | typeof FACTORY_STORE_NO_CHANGE

/** Optional scheduler-lease precondition checked inside the write transaction. */
export interface FactoryStoreLeaseGuard {
  processId: FactoryProcessId
  now: string
}

/** Persistence and cross-process coordination required by Factory consumers. */
export abstract class FactoryStore extends Service {
  /** Cordis service key. */
  static readonly service = 'factoryStore'

  /**
   * Register the service instance.
   * @param ctx - Cordis context receiving the store.
   */
  constructor(ctx: Context) {
    super(ctx, 'factoryStore')
  }

  /** Read an immutable document snapshot. @returns current revision and document. */
  abstract read(): Promise<FactoryStoreRead>

  /**
   * Commit one mutation atomically.
   * @param expectedRevision - Optional revision that must still be current.
   * @param mutation - Synchronous in-transaction document edit.
   * @param lease - Optional live scheduler lease required by dispatch mutations.
   * @returns committed revision and immutable document.
   */
  abstract mutate(expectedRevision: number | undefined, mutation: FactoryStoreMutation, lease?: FactoryStoreLeaseGuard): Promise<FactoryStoreRead>

  /**
   * Replace one process's complete Agent presence set.
   * @param processId - Publishing process.
   * @param observations - Current live Agents owned by the process.
   */
  abstract replaceAgentObservations(processId: FactoryProcessId, observations: readonly FactoryAgentObservation[]): Promise<void>

  /**
   * Read live Agent observations and delete expired rows.
   * @param freshAfter - Oldest accepted heartbeat timestamp.
   * @returns currently live observations.
   */
  abstract readAgentObservations(freshAfter: string): Promise<FactoryAgentObservation[]>

  /**
   * Acquire or renew the scheduler lease.
   * @param processId - Candidate leader.
   * @param now - Current timestamp.
   * @param expiresAt - New lease deadline.
   * @returns authoritative leader; only a matching process may dispatch.
   */
  abstract acquireLeader(processId: FactoryProcessId, now: string, expiresAt: string): Promise<FactoryLeaderObservation>

  /** Read the unexpired scheduler leader. @param now - Current timestamp. @returns current leader, if any. */
  abstract readLeader(now: string): Promise<FactoryLeaderObservation | undefined>

  /** Release a lease only if owned by the caller. @param processId - Current process. */
  abstract releaseLeader(processId: FactoryProcessId): Promise<void>
}

export default FactoryStore

declare module '@monotykamary/cordis' {
  interface Context {
    factoryStore: FactoryStore
  }
  interface Events {
    /** @mode parallel @param revision Newly committed durable revision. */
    'factory-store/committed'(revision: number): void
  }
}
