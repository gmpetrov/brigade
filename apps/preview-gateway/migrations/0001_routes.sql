-- A preview's address at the provider and its token, by the id of its address here.
CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  token TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
