-- A thread's preview: its address at the provider and its token, by the id of its address
-- here (keyed by the thread and that address). One per thread, one thread per address at
-- the provider. The nonce changes with each new route and ends the cookies and grants made
-- for the one before. `routes` (an id per address at the provider, shared by every thread
-- previewing there) is no longer read; it goes in a later migration.
CREATE TABLE previews (
  id TEXT PRIMARY KEY,
  thread TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL,
  nonce TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
