import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@monotykamary/cordis'
import z from '@monotykamary/schemastery'
import {
  emptyFactoryDocument, parseFactoryAgentObservation, parseFactoryDocument, validateTaskGraph,
  type FactoryAgentObservation, type FactoryDocument, type FactoryLeaderObservation, type FactoryProcessId,
} from 'dsh-factory-protocol'
import { FACTORY_STORE_NO_CHANGE, FactoryStore, type FactoryStoreLeaseGuard, type FactoryStoreMutation, type FactoryStoreRead } from 'dsh-factory-store'

const SCHEMA_VERSION = 1

/** Raised when a Remote mutation used a stale snapshot revision. */
export class FactoryRevisionConflictError extends Error {
  /** Current revision a caller must refresh before retrying. */
  readonly currentRevision: number
  constructor(expected: number, current: number) {
    super(`Factory revision conflict: expected ${expected}, current ${current}`)
    this.name = 'FactoryRevisionConflictError'
    this.currentRevision = current
  }
}

/** Raised when dispatch no longer owns the live scheduler lease. */
export class FactoryLeaderLeaseError extends Error {
  constructor() {
    super('Factory scheduler lease is not owned by this process')
    this.name = 'FactoryLeaderLeaseError'
  }
}

/** SQLite provider configuration. */
export interface Config {
  /** Database file, or `:memory:` in tests. */
  path: string
}

/** Runtime validation for SQLite provider configuration. */
export const Config: z<Config> = z.object({
  path: z.string().required().description('SQLite database path'),
})

interface StateRow { revision: number; document: string }
interface PresenceRow { payload: string }
interface LeaderRow { process_id: string; expires_at: string }

/** Transactional SQLite implementation of the Factory store. */
export class SqliteFactoryStore extends FactoryStore {
  private readonly database: DatabaseSync
  private closed = false

  /**
   * Open and migrate the configured database.
   * @param ctx - Cordis context receiving `factoryStore`.
   * @param config - SQLite file configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const path = config.path === ':memory:' ? config.path : resolve(config.path)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
    ctx.effect(() => () => {
      if (this.closed) return
      this.closed = true
      this.database.close()
    })
  }

  /** @inheritdoc */
  read(): Promise<FactoryStoreRead> {
    this.assertOpen()
    return Promise.resolve(this.readCurrent())
  }

  /** @inheritdoc */
  mutate(expectedRevision: number | undefined, mutation: FactoryStoreMutation, lease?: FactoryStoreLeaseGuard): Promise<FactoryStoreRead> {
    this.assertOpen()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (lease !== undefined) {
        const leader = this.database.prepare('SELECT process_id, expires_at FROM factory_scheduler_leader WHERE singleton = 1').get() as unknown as LeaderRow | undefined
        if (leader === undefined || leader.process_id !== lease.processId || leader.expires_at <= lease.now) throw new FactoryLeaderLeaseError()
      }
      const current = this.readCurrent()
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new FactoryRevisionConflictError(expectedRevision, current.revision)
      }
      const draft = structuredClone(current.document)
      if (mutation(draft) === FACTORY_STORE_NO_CHANGE) {
        this.database.exec('ROLLBACK')
        return Promise.resolve(current)
      }
      const issues = validateTaskGraph(draft)
      if (issues.length > 0) throw new Error(`Factory graph rejected: ${issues.map(issue => issue.message).join('; ')}`)
      const document = parseFactoryDocument(draft)
      const revision = current.revision + 1
      this.database.prepare('UPDATE factory_state SET revision = ?, document = ? WHERE singleton = 1').run(revision, JSON.stringify(document))
      this.database.exec('COMMIT')
      this.ctx.parallel('factory-store/committed', revision)
      return Promise.resolve({ revision, document: structuredClone(document) })
    } catch (error) {
      this.database.exec('ROLLBACK')
      return Promise.reject(error)
    }
  }

  /** @inheritdoc */
  replaceAgentObservations(processId: FactoryProcessId, observations: readonly FactoryAgentObservation[]): Promise<void> {
    this.assertOpen()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('DELETE FROM factory_agent_presence WHERE process_id = ?').run(processId)
      const insert = this.database.prepare('INSERT INTO factory_agent_presence (process_id, agent_id, heartbeat_at, payload) VALUES (?, ?, ?, ?)')
      for (const observation of observations) {
        const parsed = parseFactoryAgentObservation(observation)
        if (parsed.processId !== processId) throw new Error('Factory presence owner does not match observation processId')
        insert.run(processId, parsed.agentId, parsed.heartbeatAt, JSON.stringify(parsed))
      }
      this.database.exec('COMMIT')
      return Promise.resolve()
    } catch (error) {
      this.database.exec('ROLLBACK')
      return Promise.reject(error)
    }
  }

  /** @inheritdoc */
  readAgentObservations(freshAfter: string): Promise<FactoryAgentObservation[]> {
    this.assertOpen()
    this.database.prepare('DELETE FROM factory_agent_presence WHERE heartbeat_at < ?').run(freshAfter)
    const rows = this.database.prepare('SELECT payload FROM factory_agent_presence ORDER BY process_id, agent_id').all() as unknown as PresenceRow[]
    return Promise.resolve(rows.map(row => parseFactoryAgentObservation(JSON.parse(row.payload))))
  }

  /** @inheritdoc */
  acquireLeader(processId: FactoryProcessId, now: string, expiresAt: string): Promise<FactoryLeaderObservation> {
    this.assertOpen()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.database.prepare('SELECT process_id, expires_at FROM factory_scheduler_leader WHERE singleton = 1').get() as unknown as LeaderRow | undefined
      if (row === undefined || row.expires_at <= now || row.process_id === processId) {
        this.database.prepare(`INSERT INTO factory_scheduler_leader (singleton, process_id, expires_at) VALUES (1, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET process_id = excluded.process_id, expires_at = excluded.expires_at`).run(processId, expiresAt)
        this.database.exec('COMMIT')
        return Promise.resolve({ processId, expiresAt })
      }
      this.database.exec('COMMIT')
      return Promise.resolve({ processId: row.process_id as FactoryProcessId, expiresAt: row.expires_at })
    } catch (error) {
      this.database.exec('ROLLBACK')
      return Promise.reject(error)
    }
  }

  /** @inheritdoc */
  readLeader(now: string): Promise<FactoryLeaderObservation | undefined> {
    this.assertOpen()
    const row = this.database.prepare('SELECT process_id, expires_at FROM factory_scheduler_leader WHERE singleton = 1 AND expires_at > ?').get(now) as unknown as LeaderRow | undefined
    return Promise.resolve(row === undefined ? undefined : { processId: row.process_id as FactoryProcessId, expiresAt: row.expires_at })
  }

  /** @inheritdoc */
  releaseLeader(processId: FactoryProcessId): Promise<void> {
    this.assertOpen()
    this.database.prepare('DELETE FROM factory_scheduler_leader WHERE singleton = 1 AND process_id = ?').run(processId)
    return Promise.resolve()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Factory SQLite store is closed')
  }

  private readCurrent(): FactoryStoreRead {
    const row = this.database.prepare('SELECT revision, document FROM factory_state WHERE singleton = 1').get() as unknown as StateRow | undefined
    if (row === undefined) throw new Error('Factory SQLite state row is missing')
    return { revision: Number(row.revision), document: structuredClone(parseFactoryDocument(JSON.parse(row.document))) }
  }

  private migrate(): void {
    const version = Number((this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > SCHEMA_VERSION) throw new Error(`Factory SQLite schema ${version} is newer than supported ${SCHEMA_VERSION}`)
    if (version === 0) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE factory_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL, document TEXT NOT NULL);
        CREATE TABLE factory_agent_presence (process_id TEXT NOT NULL, agent_id TEXT NOT NULL, heartbeat_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (process_id, agent_id));
        CREATE INDEX factory_agent_presence_heartbeat ON factory_agent_presence (heartbeat_at);
        CREATE TABLE factory_scheduler_leader (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), process_id TEXT NOT NULL, expires_at TEXT NOT NULL);
      `)
      this.database.prepare('INSERT INTO factory_state (singleton, revision, document) VALUES (1, 0, ?)').run(JSON.stringify(emptyFactoryDocument()))
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`)
    }
  }
}

export const name = 'factory-store-sqlite'
export default SqliteFactoryStore
