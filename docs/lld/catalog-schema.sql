-- LLD 0.1 reference schema for application catalog; never put source text here.
-- Copyright (c) 2026 nDimensions.AI and CharanTheAiGuy. MIT.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE project_registry (
  id TEXT PRIMARY KEY, directory_name TEXT NOT NULL UNIQUE,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('Active','Deleting','Deleted')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  budget_microusd INTEGER NOT NULL CHECK(budget_microusd >= 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE provider_requests (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project_registry(id),
  project_generation INTEGER NOT NULL, job_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
  model_id TEXT NOT NULL, rate_card_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('Prepared','Dispatched','Succeeded','Failed','Unknown','Cancelled')),
  accounting TEXT NOT NULL CHECK(accounting IN ('Reserved','Unknown','Settled')),
  reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd >= 0),
  charged_microusd INTEGER CHECK(charged_microusd >= 0),
  provider_request_id TEXT, usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(project_id, job_id, attempt),
  CHECK((accounting = 'Settled') = (charged_microusd IS NOT NULL))
);
CREATE INDEX requests_budget ON provider_requests(project_id, accounting);
CREATE TABLE remote_objects (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES provider_requests(id),
  credential_ref TEXT NOT NULL, provider_profile_hash TEXT NOT NULL,
  remote_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('Active','DeletePending','Deleted','Expired','Uncertain')),
  expires_at TEXT, next_attempt_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT, UNIQUE(provider_profile_hash, remote_id)
);
CREATE TABLE deletion_tasks (
  project_id TEXT PRIMARY KEY REFERENCES project_registry(id),
  local_state TEXT NOT NULL CHECK(local_state IN ('Pending','Stopped','Removed','Failed')),
  remote_state TEXT NOT NULL CHECK(remote_state IN ('Pending','Complete','Uncertain')),
  updated_at TEXT NOT NULL
);
-- Budget admission, lifecycle fencing, and request preparation share BEGIN IMMEDIATE.
-- Keep this catalog after removing a project directory so remote deletion and
-- unresolved charges remain visible. Prune settled metadata by an explicit policy.
