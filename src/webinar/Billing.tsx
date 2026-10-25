import { useEffect, useState } from "react";
import { call } from "./api";

export function Billing({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [charge, setCharge] = useState(""),
    [note, setNote] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = () =>
    call("billing.list")
      .then(setRows)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <div className="wb-overlay">
      <section className="wb-modal">
        <h2>AI request accounting</h2>
        <p>
          Uncertain requests retain their budget reservation, including after
          project deletion. Check your provider's billing records before
          entering a confirmed charge.
        </p>
        {error && <p role="alert">{error}</p>}
        {rows.length === 0 && <p>No AI requests have been dispatched.</p>}
        {rows.map((r) => (
          <div className="wb-recording" key={r.id}>
            <div>
              <strong>{r.accounting}</strong>
              <small>
                Request {r.id} · project {r.lifecycle}
              </small>
              <p>
                {r.accounting === "Settled" ? "Charged" : "Reserved"}: $
                {((r.charged_microusd ?? r.reserved_microusd) / 1e6).toFixed(6)}
              </p>
            </div>
            {r.accounting === "Unknown" && (
              <button
                onClick={() => {
                  setSelected(r);
                  setCharge("");
                  setNote("");
                }}
              >
                Reconcile charge
              </button>
            )}
          </div>
        ))}
        {selected && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              void call("billing.reconcile", {
                projectId: selected.project_id,
                requestId: selected.id,
                chargedMicrousd: Math.round(Number(charge) * 1e6),
                note,
              })
                .then(async () => {
                  setSelected(null);
                  await refresh();
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <h3>Confirm request {selected.id}</h3>
            <label>
              Confirmed charge in USD
              <input
                required
                type="number"
                min="0"
                step="0.000001"
                value={charge}
                onChange={(e) => setCharge(e.target.value)}
              />
            </label>
            <label>
              Billing evidence and reference
              <textarea
                required
                minLength={10}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <p>
              This records a billing decision; it does not recover a lost AI
              response.
            </p>
            <button disabled={busy}>Save reconciliation</button>
          </form>
        )}
        <button onClick={onClose}>Close accounting</button>
      </section>
    </div>
  );
}
