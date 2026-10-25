-- LLD 0.1 reference schema, not an installed application migration.
-- Copyright (c) 2026 nDimensions.AI and CharanTheAiGuy. MIT.
-- One database per project. Coordinator owns all writes through StoreWorker.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE project (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
  source_version INTEGER NOT NULL DEFAULT 0 CHECK(source_version >= 0),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version >= 1),
  head_revision_id TEXT REFERENCES script_revisions(id) DEFERRABLE INITIALLY DEFERRED,
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE presenters (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  words_per_minute INTEGER NOT NULL DEFAULT 130 CHECK(words_per_minute BETWEEN 60 AND 250),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE recordings (
  id TEXT PRIMARY KEY, narrator TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('Preflight','Recording','Paused','Finalizing','Captured','Incomplete')),
  capture_epoch INTEGER NOT NULL CHECK(capture_epoch >= 1),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  started_at TEXT NOT NULL, stopped_at TEXT,
  duration_us INTEGER CHECK(duration_us >= 0),
  CHECK((state IN ('Captured','Incomplete')) = (stopped_at IS NOT NULL))
);
-- Atomic metadata catalog for sealed files only. Relative paths are generated internally.
CREATE TABLE assets (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  kind TEXT NOT NULL CHECK(kind IN ('video','audio','frame','image_derivative','text_derivative','job_output','export')),
  relative_path TEXT NOT NULL UNIQUE, mime TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  width INTEGER CHECK(width > 0), height INTEGER CHECK(height > 0),
  parent_asset_id TEXT REFERENCES assets(id), created_at TEXT NOT NULL,
  UNIQUE(id, sha256)
);
CREATE TABLE clock_maps (
  id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id),
  source TEXT NOT NULL CHECK(source IN ('screen','microphone')),
  epoch INTEGER NOT NULL, session_anchor_us INTEGER NOT NULL CHECK(session_anchor_us >= 0),
  media_anchor_us INTEGER NOT NULL CHECK(media_anchor_us >= 0),
  scale REAL NOT NULL CHECK(scale > 0), uncertainty_us INTEGER NOT NULL CHECK(uncertainty_us >= 0),
  samples_json TEXT NOT NULL CHECK(json_valid(samples_json)), created_at TEXT NOT NULL
);
CREATE TABLE segments (
  id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id),
  track TEXT NOT NULL CHECK(track IN ('screen','microphone')),
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  asset_id TEXT NOT NULL REFERENCES assets(id), clock_map_id TEXT NOT NULL REFERENCES clock_maps(id),
  start_us INTEGER NOT NULL CHECK(start_us >= 0), end_us INTEGER NOT NULL,
  media_in_us INTEGER NOT NULL CHECK(media_in_us >= 0), media_out_us INTEGER NOT NULL,
  decode_report_json TEXT NOT NULL CHECK(json_valid(decode_report_json)),
  CHECK(end_us > start_us), CHECK(media_out_us > media_in_us),
  UNIQUE(recording_id, track, sequence)
);
CREATE INDEX segments_timeline ON segments(recording_id, track, start_us);
CREATE TABLE intervals (
  id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id),
  kind TEXT NOT NULL CHECK(kind IN ('pause','gap','active')),
  track TEXT NOT NULL CHECK(track IN ('both','screen','microphone')),
  start_us INTEGER NOT NULL CHECK(start_us >= 0), end_us INTEGER,
  reason TEXT NOT NULL, CHECK(end_us IS NULL OR end_us >= start_us)
);
CREATE TABLE markers (
  id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id),
  at_us INTEGER NOT NULL CHECK(at_us >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('moment','section','retake','exclude')),
  label TEXT NOT NULL
);
CREATE TABLE transcript_spans (
  id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id),
  start_us INTEGER NOT NULL CHECK(start_us >= 0), end_us INTEGER NOT NULL,
  original_text TEXT NOT NULL, model_id TEXT NOT NULL, source_hash TEXT NOT NULL,
  flags_json TEXT NOT NULL CHECK(json_valid(flags_json)), CHECK(end_us > start_us)
);
CREATE TABLE transcript_edits (
  id TEXT PRIMARY KEY, span_id TEXT NOT NULL REFERENCES transcript_spans(id),
  version INTEGER NOT NULL CHECK(version >= 1), text TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(span_id, version)
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id),
  raw_asset_id TEXT NOT NULL REFERENCES assets(id),
  at_us INTEGER NOT NULL CHECK(at_us >= 0),
  source TEXT NOT NULL CHECK(source IN ('event','scene','marker','probe','legacy')),
  quality_json TEXT NOT NULL CHECK(json_valid(quality_json))
);
CREATE TABLE derivatives (
  id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL REFERENCES evidence(id),
  asset_id TEXT NOT NULL REFERENCES assets(id), policy_version INTEGER NOT NULL,
  crop_json TEXT NOT NULL CHECK(json_valid(crop_json)),
  masks_json TEXT NOT NULL CHECK(json_valid(masks_json)),
  transform_version TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE text_derivatives (
  id TEXT PRIMARY KEY, span_id TEXT REFERENCES transcript_spans(id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('transcript','editor','context','glossary','terminal','model_derived')),
  source_version INTEGER NOT NULL,
  text TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  redactions_json TEXT NOT NULL CHECK(json_valid(redactions_json)),
  lineage_json TEXT NOT NULL CHECK(json_valid(lineage_json)), policy_version INTEGER NOT NULL,
  CHECK(source_kind <> 'transcript' OR span_id IS NOT NULL)
);
CREATE TABLE upload_manifests (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256) = 64),
  source_version INTEGER NOT NULL, policy_version INTEGER NOT NULL,
  provider_profile_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE manifest_images (
  manifest_id TEXT NOT NULL REFERENCES upload_manifests(id),
  derivative_id TEXT NOT NULL REFERENCES derivatives(id), PRIMARY KEY(manifest_id, derivative_id)
);
CREATE TABLE manifest_texts (
  manifest_id TEXT NOT NULL REFERENCES upload_manifests(id),
  text_id TEXT NOT NULL REFERENCES text_derivatives(id), PRIMARY KEY(manifest_id, text_id)
);
CREATE TABLE steps (
  id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY(id, version)
);
CREATE TABLE take_groups (
  id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1),
  members_json TEXT NOT NULL CHECK(json_valid(members_json)),
  selected_step_id TEXT, selected_step_version INTEGER,
  FOREIGN KEY(selected_step_id, selected_step_version) REFERENCES steps(id, version),
  PRIMARY KEY(id, version)
);
CREATE TABLE script_revisions (
  id TEXT PRIMARY KEY, parent_id TEXT REFERENCES script_revisions(id),
  base_id TEXT REFERENCES script_revisions(id),
  origin TEXT NOT NULL CHECK(origin IN ('generated','user','merge','import')),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  document_json TEXT NOT NULL CHECK(json_valid(document_json)),
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  source_version INTEGER NOT NULL, policy_version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1), created_at TEXT NOT NULL
);
CREATE TRIGGER revisions_are_immutable BEFORE UPDATE ON script_revisions
BEGIN SELECT RAISE(ABORT, 'Create a new script revision'); END;
CREATE TABLE review_flags (
  id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES script_revisions(id),
  subject_id TEXT NOT NULL, code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warning','blocking')),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json))
);
CREATE TABLE review_decisions (
  id TEXT PRIMARY KEY, flag_id TEXT NOT NULL REFERENCES review_flags(id),
  decision TEXT NOT NULL CHECK(decision IN ('corrected','verified','excluded','acknowledged')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES script_revisions(id),
  dependency_hash TEXT NOT NULL, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE exports (
  id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES script_revisions(id),
  approval_id TEXT REFERENCES approvals(id), template_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('Preparing','Rendered','Published','Failed','Superseded')),
  asset_id TEXT REFERENCES assets(id), destination_token TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, job_key TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  state TEXT NOT NULL CHECK(state IN ('Queued','Running','WaitingForNetwork','WaitingForReview','Succeeded','Failed','Cancelled','Superseded')),
  generation INTEGER NOT NULL CHECK(generation >= 0),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  lease_token TEXT, lease_owner TEXT, lease_until TEXT, not_before TEXT,
  output_asset_id TEXT REFERENCES assets(id), error_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(state <> 'Running' OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX runnable_jobs ON jobs(state, not_before);
CREATE TABLE job_dependencies (
  job_id TEXT NOT NULL REFERENCES jobs(id), depends_on TEXT NOT NULL REFERENCES jobs(id),
  PRIMARY KEY(job_id, depends_on), CHECK(job_id <> depends_on)
);
CREATE TABLE operations (
  request_id TEXT PRIMARY KEY, method TEXT NOT NULL, payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)), committed_at TEXT NOT NULL
);
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
  state_version INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL
);
-- Cross-row rules (nonoverlapping trimmed segments, reference validity, DAG acyclicity,
-- pinned revisions, immutable evidence, manifest eligibility) are coordinator invariants.
-- Run foreign_key_check and integrity_check before accepting an imported database.
