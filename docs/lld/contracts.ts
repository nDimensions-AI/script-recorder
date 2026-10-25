/** LLD 0.1 reference contracts, not production code or runtime validators.
 * Copyright (c) 2026 nDimensions.AI and CharanTheAiGuy. MIT.
 * Implement strict Zod schemas with the limits in low-level-design.md.
 */
export type Id = string; // Main-generated UUID, lowercase canonical form.
export type Hash = string; // Lowercase SHA-256 hex, exactly 64 characters.
export type Us = number; // Nonnegative safe integer microseconds.
export type IsoUtc = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Envelope<T> {
  protocolVersion: 1;
  requestId: Id;
  projectId: Id;
  expectedStateVersion: number;
  payload: T;
}
export type ErrorCode =
  | 'VALIDATION' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'BUSY'
  | 'CAPTURE_SOURCE_LOST' | 'AUDIO_MISSING' | 'STORAGE_FULL'
  | 'DECODE_FAILED' | 'CLOCK_UNCERTAIN' | 'MODEL_MISSING'
  | 'EVIDENCE_STALE' | 'POLICY_DENIED' | 'BUDGET_EXCEEDED'
  | 'PROVIDER_AUTH' | 'PROVIDER_RATE_LIMIT' | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_UNKNOWN' | 'OUTPUT_INVALID' | 'EXPORT_FAILED'
  | 'CANCELLED' | 'INTERNAL';
export type Result<T> =
  | { ok: true; requestId: Id; stateVersion: number; value: T }
  | { ok: false; requestId: Id; code: ErrorCode; retryable: boolean;
      message: string; correlationId: Id; currentStateVersion?: number };
export interface ProjectContext {
  title: string; audience: string; objective: string; targetDurationSeconds: number;
  narrator: string; language: 'en'; glossary: { term: string; explanation: string }[];
}
export interface CaptureProfile {
  width: number; height: number; fps: number; videoBitsPerSecond: number;
  audioBitsPerSecond: number; segmentTargetSeconds: number; nativeStills: boolean;
}
export type CaptureState = 'Idle' | 'Preflight' | 'Recording' | 'Paused'
  | 'Finalizing' | 'Captured' | 'Incomplete';
export interface CaptureSnapshot {
  recordingId: Id | null; state: CaptureState; transition: null | 'start' | 'pause' | 'resume' | 'stop';
  sessionUs: Us; screenHealthy: boolean; microphoneHealthy: boolean;
  sealedThroughUs: { screen: Us; microphone: Us }; gaps: SourceInterval[];
}
export interface SourceInterval { recordingId: Id; startUs: Us; endUs: Us }
export interface ClockMap {
  id: Id; recordingId: Id; track: 'screen' | 'microphone'; epoch: number;
  sessionAnchorUs: Us; mediaAnchorUs: Us; scale: number; uncertaintyUs: Us;
}
export type WriterMessage =
  | { kind: 'open'; captureEpoch: number; segmentId: Id; track: 'screen' | 'microphone'; mime: string }
  | { kind: 'chunk'; captureEpoch: number; segmentId: Id; sequence: number; bytes: Uint8Array }
  | { kind: 'close'; captureEpoch: number; segmentId: Id; lastSequence: number; clockMap: ClockMap }
  | { kind: 'abort'; captureEpoch: number; segmentId: Id; reason: ErrorCode };
export type WriterReply =
  | { kind: 'ack'; segmentId: Id; throughSequence: number; availableCreditBytes: number }
  | { kind: 'sealed'; segmentId: Id; assetId: Id; hash: Hash; byteLength: number; durationUs: Us }
  | { kind: 'error'; segmentId: Id; code: ErrorCode };
export interface Rect { x: number; y: number; width: number; height: number }
export interface RedactionPlan {
  crop: Rect; masks: Rect[]; fill: '#000000'; transformVersion: string;
}
export interface ApprovedImage {
  evidenceId: Id; derivativeId: Id; hash: Hash; mime: 'image/png' | 'image/jpeg';
  width: number; height: number; byteLength: number; source: SourceInterval;
}
export interface ApprovedText {
  textId: Id; hash: Hash; text: string;
  kind: 'transcript' | 'editor' | 'context' | 'glossary' | 'terminal' | 'model_derived';
  source: SourceInterval | null; spanId: Id | null;
  lineage: { manifestHashes: Hash[]; providerRequestIds: Id[] };
}
export interface UploadManifest {
  // Hash canonical manifest content excluding the hash field itself.
  // A root manifest has null parent/root hashes; descendants pin both ancestors.
  schemaVersion: 1; id: Id; projectId: Id; sourceVersion: number; policyVersion: number;
  providerProfileHash: Hash; images: ApprovedImage[]; texts: ApprovedText[];
  allowedStages: ('extract' | 'compose')[];
  parentManifestHash: Hash | null; approvalRootHash: Hash | null;
  approvedBy: string; approvedAt: IsoUtc; hash: Hash;
}
export interface EvidencePacket {
  schemaVersion: 1; packetId: Id; manifestHash: Hash;
  coreInterval: SourceInterval; contextInterval: SourceInterval;
  imageIds: Id[]; textIds: Id[]; // Image IDs are derivative IDs; approved subsets only.
}
export interface EvidenceRef {
  // Image IDs resolve to approved derivatives; transcript IDs to approved text IDs.
  kind: 'image' | 'transcript' | 'terminal' | 'user'; id: Id;
  source: SourceInterval | null;
}
export interface Claim {
  id: Id; text: string; provenance: 'observed' | 'narrated' | 'user_supplied' | 'editorial';
  refs: EvidenceRef[];
}
export interface StepProposal {
  localId: string; title: string; source: SourceInterval;
  action: Claim; outcome: Claim | null; explanation: Claim[];
  imageIds: Id[]; takeGroupHint: string | null;
  flags: { code: string; reason: string; refs: EvidenceRef[] }[];
}
export interface ExtractionOutput {
  schemaVersion: 1; packetId: Id; steps: StepProposal[];
  unresolved: { reason: string; refs: EvidenceRef[] }[];
  // Suggestions only; coordinator must prepare and approve a new manifest.
  evidenceRequests: { interval: SourceInterval; reason: string }[];
}
export interface ScriptBlock {
  id: Id; kind: 'say' | 'do' | 'show' | 'producer' | 'handoff';
  text: string; provenance: Claim['provenance']; refs: EvidenceRef[];
  stepRefs: { id: Id; version: number }[]; imageDerivativeIds: Id[];
  timingGroup: Id; timingMode: 'serial' | 'overlap';
  durationSeconds: number | null; requiresTechnicalVerification: boolean;
}
export interface ScriptSection {
  id: Id; title: string; presenterId: Id | null;
  assignment: 'suggested' | 'confirmed' | 'unassigned';
  blocks: ScriptBlock[]; handoffToPresenterId: Id | null;
}
export interface ScriptDocument {
  schemaVersion: 1; projectId: Id; title: string;
  context: ProjectContext;
  presenters: { id: Id; name: string; wordsPerMinute: number }[];
  sections: ScriptSection[];
}
export interface RevisionSnapshot {
  id: Id; parentId: Id | null; baseId: Id | null; contentHash: Hash;
  sourceVersion: number; policyVersion: number; document: ScriptDocument;
  metadata: { predecessors: Record<Id, Id[]>; author: string };
}
export type JobStage = 'inspect' | 'transcribe' | 'scenes' | 'prepareEvidence'
  | 'extractSteps' | 'reconcile' | 'compose' | 'validate' | 'export';
export type JobState = 'Queued' | 'Running' | 'WaitingForNetwork' | 'WaitingForReview'
  | 'Succeeded' | 'Failed' | 'Cancelled' | 'Superseded';
export interface JobInput {
  schemaVersion: 1; projectId: Id; generation: number; stage: JobStage;
  inputHashes: Hash[]; sourceVersion: number | null; policyVersion: number | null;
  // Null when the stage does not consume edited source or upload policy.
  modelProfileHash: Hash | null; promptVersion: string | null;
  baseRevisionId: Id | null; configHash: Hash;
}
export interface ProviderProfile {
  id: Id; provider: 'gemini'; modelId: string; endpointProfile: string;
  maxImages: number; maxRequestBytes: number; maxInputTokens: number;
  maxOutputTokens: number; supportsSchema: boolean;
  timeoutMs: number; rateCardId: string; credentialRef: Id;
}
export interface GenerationRequest {
  requestId: Id; manifest: UploadManifest; packet: EvidencePacket;
  task: 'extract' | 'compose'; promptVersion: string; responseSchemaVersion: number;
  maximumOutputTokens: number;
}
export interface GenerationResponse {
  requestId: Id; providerRequestId: string | null; modelId: string;
  output: unknown; finishReason: string;
  usage: { inputTokens: number | null; outputTokens: number | null;
           otherBillableUnits: Record<string, number> };
}
export interface ModelAdapter {
  capabilities(): ProviderProfile;
  generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationResponse>;
  deleteRemoteObject(remoteId: string, signal: AbortSignal): Promise<'deleted' | 'not_found'>;
}
// Images are hydrated by the privileged gateway from manifest-approved derivatives.
// Production adapters must not accept renderer-supplied paths or raw recording bytes.
export interface WebinarCommands {
  'project.update': { input: ProjectContext; output: { projectId: Id } };
  'capture.start': { input: { sourceToken: Id; microphoneToken: Id; profile: CaptureProfile }; output: CaptureSnapshot };
  'capture.pause': { input: { recordingId: Id }; output: CaptureSnapshot };
  'capture.resume': { input: { recordingId: Id; sourceToken: Id; microphoneToken: Id }; output: CaptureSnapshot };
  'capture.stop': { input: { recordingId: Id }; output: CaptureSnapshot };
  'marker.add': { input: { recordingId: Id; kind: 'moment' | 'section' | 'retake' | 'exclude'; label: string }; output: { id: Id; atUs: Us } };
  'transcript.correct': { input: { spanId: Id; text: string }; output: { editId: Id; sourceVersion: number } };
  'evidence.derive': { input: { evidenceId: Id; plan: RedactionPlan }; output: { jobId: Id } };
  'manifest.approve': { input: { candidateHash: Hash }; output: { manifestId: Id; hash: Hash } };
  'manifest.revoke': { input: { manifestId: Id; reason: string }; output: { revoked: true } };
  'jobs.run': { input: { stage: JobStage; inputRevisionId: Id | null }; output: { jobId: Id } };
  'jobs.retry': { input: { jobId: Id; acceptUncertainCharge: boolean }; output: { jobId: Id } };
  'jobs.cancel': { input: { jobId: Id }; output: { state: JobState } };
  'presenters.save': { input: { presenters: { id: Id | null; name: string; wordsPerMinute: number; active: boolean }[] }; output: { presenterIds: Id[] } };
  'take.select': { input: { groupId: Id; expectedGroupVersion: number; stepId: Id; stepVersion: number }; output: { groupVersion: number; proposedRevisionId: Id } };
  'review.resolve': { input: { revisionId: Id; flagId: Id; decision: 'corrected' | 'verified' | 'excluded' | 'acknowledged'; reason: string; refs: EvidenceRef[] }; output: { decisionId: Id } };
  'script.save': { input: { baseRevisionId: Id; document: ScriptDocument }; output: RevisionSnapshot };
  'script.merge': { input: { baseRevisionId: Id; proposedRevisionId: Id; resolvedDocument: ScriptDocument }; output: RevisionSnapshot };
  'script.approve': { input: { revisionId: Id; dependencyHash: Hash }; output: { approvalId: Id } };
  'export.word': { input: { revisionId: Id; mode: 'draft' | 'ready'; templateId: string }; output: { exportId: Id; jobId: Id } };
  'project.delete': { input: { confirmProjectId: Id }; output: { deletionTaskId: Id } };
}
export interface ProjectSnapshot {
  projectId: Id; stateVersion: number; sourceVersion: number; policyVersion: number;
  lastEventSequence: number; context: ProjectContext; head: RevisionSnapshot | null;
  capture: CaptureSnapshot;
  jobs: { id: Id; stage: JobStage; state: JobState }[];
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface ProjectQuery<T> { projectId: Id; payload: T }
export interface WebinarQueries {
  'project.snapshot': { input: Record<string, never>; output: ProjectSnapshot };
  'transcript.list': { input: { recordingId: Id; cursor: string | null; limit: number }; output: Page<{ spanId: Id; source: SourceInterval; originalText: string; currentText: string }> };
  'evidence.list': { input: { recordingId: Id; cursor: string | null; limit: number }; output: Page<{ evidenceId: Id; atUs: Us; width: number; height: number }> };
  'evidence.inspect': { input: { evidenceId: Id; representation: 'raw' | 'approved'; derivativeId: Id | null }; output: { capabilityUrl: string; expiresAt: IsoUtc; width: number; height: number } };
  'revision.get': { input: { revisionId: Id }; output: RevisionSnapshot };
  'events.since': { input: { afterSequence: number; limit: number }; output: Page<ProjectEvent> };
}
export interface AppEnvelope<T> { protocolVersion: 1; requestId: Id; payload: T }
export interface AppCommands {
  'project.create': { input: { context: ProjectContext; budgetMicrousd: number }; output: { projectId: Id } };
  'project.list': { input: { cursor: string | null; limit: number }; output: Page<{ id: Id; title: string; lifecycle: 'Active' | 'Deleting' | 'Deleted' }> };
  'project.open': { input: { projectId: Id }; output: ProjectSnapshot };
  'sources.list': { input: Record<string, never>; output: { screens: { token: Id; label: string }[]; microphones: { token: Id; label: string }[] } };
  // Key entry is sensitive transient IPC from the dedicated trusted settings view.
  // Never persist plaintext in operation receipts or event payloads.
  'provider.configure': { input: { key?: string }; output: { configured: boolean; displayName: string; checkedAt: IsoUtc } };
}
export type CommandName = keyof WebinarCommands;
export interface ProjectEvent {
  projectId: Id; sequence: number; stateVersion: number;
  kind: 'capture.changed' | 'job.changed' | 'revision.created' | 'review.changed' | 'project.deleted';
  payload: Json;
}
