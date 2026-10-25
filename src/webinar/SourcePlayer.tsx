import { useEffect, useRef, useState } from "react";
import { call } from "./api";

// Media elements hold only the current independently decodable segment.
export function SourcePlayer({
  projectId,
  recordingId,
  atUs = 0,
  onClose,
}: {
  projectId: string;
  recordingId: string;
  atUs?: number;
  onClose: () => void;
}) {
  const [timeline, setTimeline] = useState<any>(null),
    [position, setPosition] = useState(atUs),
    [playing, setPlaying] = useState(false),
    [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null),
    audio = useRef<HTMLAudioElement>(null),
    request = useRef(0),
    playingRef = useRef(false),
    positionRef = useRef(atUs);
  const loaded = useRef<Record<string, string>>({}),
    segments = useRef<any[]>([]);
  playingRef.current = playing;
  positionRef.current = position;
  useEffect(() => {
    let valid = true;
    void call("source.timeline", { projectId, recordingId })
      .then((t) => {
        if (valid) {
          segments.current = t.segments;
          setTimeline(t);
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      valid = false;
      request.current++;
    };
  }, [projectId, recordingId]);
  async function seek(us: number, play = playingRef.current) {
    const token = ++request.current;
    setPosition(us);
    await Promise.all(
      ["screen", "microphone"].map(async (track) => {
        const element = track === "screen" ? video.current : audio.current;
        if (!element) return;
        const segment = segments.current.find(
          (s) => s.track === track && s.start_us <= us && s.end_us > us,
        );
        element.pause();
        if (!segment) {
          element.removeAttribute("src");
          loaded.current[track] = "";
          return;
        }
        if (loaded.current[track] !== segment.id) {
          const r = await call("asset.url", {
            projectId,
            assetId: segment.asset_id,
          });
          if (token !== request.current) return;
          element.src = r.url;
          loaded.current[track] = segment.id;
          await new Promise<void>((resolve, reject) => {
            element.onloadedmetadata = () => resolve();
            element.onerror = () =>
              reject(new Error("Source segment could not be decoded."));
          });
        }
        if (token !== request.current) return;
        element.currentTime =
          (segment.media_anchor_us +
            (us - segment.session_anchor_us) / segment.scale) /
          1e6;
        if (play) await element.play();
      }),
    ).catch((e) => {
      setPlaying(false);
      setError(e.message);
    });
  }
  useEffect(() => {
    if (timeline) void seek(atUs, false);
  }, [timeline]);
  useEffect(() => {
    if (!playing) return;
    const anchor = performance.now(),
      start = positionRef.current;
    const timer = setInterval(() => {
      const us = start + (performance.now() - anchor) * 1000,
        end = Math.max(0, ...segments.current.map((s) => s.end_us));
      if (us >= end) {
        setPlaying(false);
        void seek(end, false);
        return;
      }
      setPosition(us);
      for (const track of ["screen", "microphone"]) {
        const segment = segments.current.find(
            (s) => s.track === track && s.start_us <= us && s.end_us > us,
          ),
          element = track === "screen" ? video.current : audio.current;
        if (segment?.id !== (loaded.current[track] || undefined)) {
          void seek(us, true);
          break;
        }
        if (segment && element) {
          const media =
            (segment.media_anchor_us +
              (us - segment.session_anchor_us) / segment.scale) /
            1e6;
          if (Math.abs(element.currentTime - media) > 0.1)
            element.currentTime = media;
        }
      }
    }, 100);
    return () => clearInterval(timer);
  }, [playing]);
  const missing = ["screen", "microphone"].filter(
    (track) =>
      !timeline?.segments.some(
        (s: any) =>
          s.track === track && s.start_us <= position && s.end_us > position,
      ),
  );
  return (
    <div className="wb-overlay">
      <section className="wb-modal wb-wide">
        <h2>Local source recording</h2>
        <p>
          Raw source stays on this computer. Time: {(position / 1e6).toFixed(1)}{" "}
          seconds.
        </p>
        {error && <p role="alert">{error}</p>}
        <video
          ref={video}
          muted
          style={{ width: "100%", maxHeight: 480, background: "#111" }}
        />
        <audio ref={audio} />
        {missing.length > 0 && (
          <p>Gap or pause: {missing.join(" and ")} unavailable at this time.</p>
        )}
        <input
          aria-label="Recording position"
          type="range"
          min="0"
          max={Math.max(
            1,
            ...(timeline?.segments ?? []).map((s: any) => s.end_us),
          )}
          step="100000"
          value={position}
          onChange={(e) => {
            setPlaying(false);
            void seek(Number(e.target.value), false);
          }}
        />
        <div className="wb-actions">
          <button
            onClick={() => {
              const next = !playing;
              setPlaying(next);
              void seek(position, next);
            }}
          >
            {playing ? "Pause playback" : "Play source"}
          </button>
          <button
            onClick={() => {
              const next = timeline?.segments.find(
                (s: any) => s.start_us > position,
              );
              if (next) {
                setPlaying(false);
                void seek(next.start_us, false);
              }
            }}
          >
            Next segment
          </button>
          <button
            disabled={playing || missing.includes("screen")}
            onClick={() =>
              void call("source.probe", {
                projectId,
                recordingId,
                atUs: Math.round(position),
              })
                .then(() =>
                  setError(
                    "Frame added to local evidence. Review and redact it before sharing.",
                  ),
                )
                .catch((e) => setError(e.message))
            }
          >
            Add this frame to evidence
          </button>
          <button onClick={onClose}>Close source</button>
        </div>
        <small>
          Recording {recordingId}. Segment boundaries and missing tracks remain
          visible.
        </small>
      </section>
    </div>
  );
}
