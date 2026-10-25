import { useEffect, useState } from "react";
import { WEBINAR_AI } from "../../common/webinar/provider-profile";
import { call } from "./api";

export function ProviderConnection({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<{
    configured: boolean;
    keySaved: boolean;
    checkedAt?: string;
  }>({ configured: false, keySaved: false });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void call("provider.status")
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      await call("provider.configure", {
        ...(key.trim() ? { key: key.trim() } : {}),
      });
      setKey("");
      onConnected();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wb-overlay">
      <form
        className="wb-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-connection-title"
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <h2 id="ai-connection-title">Connect your AI account</h2>
        <p>
          Use your Google AI Studio key to turn reviewed screenshots and
          narration into a webinar script.
        </p>
        <div className="wb-ai-model">
          <small>SELECTED BY nDimensions.AI</small>
          <strong>{WEBINAR_AI.displayName}</strong>
          <p>The app manages the model, settings and cost estimates for you.</p>
        </div>
        {status.configured && (
          <p className="wb-notice">
            Gemini is connected
            {status.checkedAt
              ? ` · checked ${new Date(status.checkedAt).toLocaleDateString()}`
              : ""}
            .
          </p>
        )}
        {!status.configured && status.keySaved && (
          <p>
            Your saved API key will be kept. Connect once to check it with the
            app’s supported model.
          </p>
        )}
        <label>
          Google AI Studio API key
          <input
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            required={!status.keySaved}
            minLength={10}
            maxLength={1000}
            disabled={busy || loading}
            value={key}
            placeholder={
              status.keySaved
                ? "Leave blank to use your saved key"
                : "Paste your API key"
            }
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="wb-text-button"
          disabled={busy}
          onClick={() => {
            void call("provider.openKeyPage").catch((error) =>
              setError(error.message),
            );
          }}
        >
          Get an API key from Google AI Studio ↗
        </button>
        <p>
          Your key is encrypted on this computer. The app checks account access
          with Google; your recordings stay local.
        </p>
        {error && (
          <div className="wb-alert" role="alert">
            {error}
          </div>
        )}
        {busy && (
          <p role="status">Checking your key and Google account access…</p>
        )}
        <div className="wb-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="wb-primary" disabled={busy || loading}>
            {busy
              ? "Checking connection…"
              : status.configured && !key
                ? "Recheck connection"
                : "Connect and test"}
          </button>
        </div>
      </form>
    </div>
  );
}
