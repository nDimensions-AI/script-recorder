import { useState } from "react";
import { call, envelope } from "./api";
export function ProjectSettings({
  snapshot,
  onClose,
  onSaved,
}: {
  snapshot: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [context, setContext] = useState(snapshot.context),
    [presenters, setPresenters] = useState<any[]>(
      snapshot.presenters.map((p: any) => ({
        id: p.id,
        name: p.name,
        wordsPerMinute: p.words_per_minute,
        active: true,
      })),
    ),
    [budget, setBudget] = useState(snapshot.budgetMicrousd / 1e6),
    [glossary, setGlossary] = useState(
      snapshot.context.glossary
        .map((g: any) => g.term + " = " + g.explanation)
        .join("\n"),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const mutate = async (method: string, payload: any) => {
        const current = await call("project.snapshot", {
          projectId: snapshot.projectId,
        });
        return call(method, envelope(current, payload));
      };
      await mutate("project.update", {
        ...context,
        glossary: glossary.trim()
          ? glossary
              .trim()
              .split("\n")
              .map((line: string) => {
                const split = line.indexOf("=");
                return {
                  term: (split < 0 ? line : line.slice(0, split)).trim(),
                  explanation: split < 0 ? "" : line.slice(split + 1).trim(),
                };
              })
          : [],
      });
      await mutate("presenters.save", { presenters });
      await mutate("project.budget", {
        budgetMicrousd: Math.round(budget * 1e6),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wb-overlay">
      <form
        className="wb-modal"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2>Webinar and presenter settings</h2>
        {error && <p role="alert">{error}</p>}
        <label>
          Title
          <input
            required
            value={context.title}
            onChange={(e) => setContext({ ...context, title: e.target.value })}
          />
        </label>
        <label>
          Audience
          <input
            value={context.audience}
            onChange={(e) =>
              setContext({ ...context, audience: e.target.value })
            }
          />
        </label>
        <label>
          Objective
          <textarea
            value={context.objective}
            onChange={(e) =>
              setContext({ ...context, objective: e.target.value })
            }
          />
        </label>
        <label>
          Target minutes
          <input
            type="number"
            min="1"
            max="240"
            value={context.targetDurationSeconds / 60}
            onChange={(e) =>
              setContext({
                ...context,
                targetDurationSeconds: Math.round(Number(e.target.value) * 60),
              })
            }
          />
        </label>
        <label>
          Glossary, one term = explanation per line
          <textarea
            value={glossary}
            onChange={(e) => setGlossary(e.target.value)}
          />
        </label>
        <h3>Presenters and speaking pace</h3>
        {presenters.map((p, i) => (
          <div className="wb-grid" key={p.id ?? i}>
            <label>
              Name
              <input
                required
                value={p.name}
                onChange={(e) =>
                  setPresenters((v) =>
                    v.map((x, j) =>
                      j === i ? { ...x, name: e.target.value } : x,
                    ),
                  )
                }
              />
            </label>
            <label>
              Words per minute
              <input
                type="number"
                min="60"
                max="250"
                value={p.wordsPerMinute}
                onChange={(e) =>
                  setPresenters((v) =>
                    v.map((x, j) =>
                      j === i
                        ? { ...x, wordsPerMinute: Number(e.target.value) }
                        : x,
                    ),
                  )
                }
              />
            </label>
            <button
              type="button"
              onClick={() => setPresenters((v) => v.filter((_, j) => j !== i))}
            >
              Remove presenter
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={presenters.length >= 20}
          onClick={() =>
            setPresenters((v) => [
              ...v,
              {
                id: null,
                name: "New presenter",
                wordsPerMinute: 130,
                active: true,
              },
            ])
          }
        >
          Add presenter
        </button>
        <label>
          AI budget in USD
          <input
            type="number"
            min="0"
            step="0.1"
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
          />
        </label>
        <p>
          Context changes require fresh evidence approval. Presenter changes
          create a new script revision.
        </p>
        <div className="wb-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="wb-primary" disabled={busy}>
            Save settings
          </button>
        </div>
      </form>
    </div>
  );
}
