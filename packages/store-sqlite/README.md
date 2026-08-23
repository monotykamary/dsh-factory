# dsh-factory-store-sqlite

SQLite provider for `dsh-factory-store`.

The document and revision update under `BEGIN IMMEDIATE`; stale revisions fail without executing a mutation. Graph and durable JSON validation happen before commit. Process-owned Agent presence is replaced atomically and expired on reads. A separate lease row elects one dispatch leader across multiple DSH processes sharing the database. Schema version `1` rejects newer files instead of guessing compatibility.
