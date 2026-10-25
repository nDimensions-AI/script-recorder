import type { UploadManifest } from "../../common/webinar/types";
declare global {
  interface Window {
    webinar: {
      invoke(
        method: string,
        payload: unknown,
      ): Promise<{ ok: boolean; value?: any; error?: string; code?: string }>;
      onChanged(listener: () => void): () => void;
    };
  }
}
export async function call<T = any>(
  method: string,
  payload: unknown = {},
): Promise<T> {
  const r = await window.webinar.invoke(method, payload);
  if (!r.ok)
    throw Object.assign(new Error(r.error ?? "Operation failed"), {
      code: r.code,
    });
  return r.value;
}
export function envelope(snapshot: any, payload: unknown) {
  return {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    projectId: snapshot.projectId,
    expectedStateVersion: snapshot.stateVersion,
    payload,
  };
}
export type Preview = UploadManifest;
