# dsh-factory-store

Service Definition for durable Factory state and cross-process coordination.

Providers commit one synchronous document mutation in a transaction, optionally guarded by the caller's observed revision. Agent observations are replace-by-owner presence rows with heartbeat expiry. The scheduler lease is authoritative: only the process returned by `acquireLeader()` may dispatch new work.
