import { useEffect, useRef, useState } from "react";
export function MicrophonePreview({ deviceId }: { deviceId: string }) {
  const [level, setLevel] = useState(0),
    [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const streamRef = useRef<MediaStream | null>(null),
    timerRef = useRef<ReturnType<typeof setInterval> | null>(null),
    contextRef = useRef<AudioContext | null>(null),
    urlRef = useRef("");
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
      void contextRef.current?.close();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );
  async function preview() {
    setBusy(true);
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      });
      streamRef.current = stream;
      const context = new AudioContext(),
        analyser = context.createAnalyser();
      contextRef.current = context;
      context.createMediaStreamSource(stream).connect(analyser);
      const values = new Uint8Array(analyser.fftSize);
      timerRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(values);
        const rms = Math.sqrt(
          values.reduce((n, v) => n + ((v - 128) / 128) ** 2, 0) /
            values.length,
        );
        setLevel(Math.min(1, rms * 8));
      }, 100);
      const recorder = new MediaRecorder(stream),
        chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      const ended = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start();
      await new Promise((r) => setTimeout(r, 3000));
      if (recorder.state !== "inactive") recorder.stop();
      await ended;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(
        new Blob(chunks, { type: recorder.mimeType }),
      );
      setUrl(urlRef.current);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
      await contextRef.current?.close();
      contextRef.current = null;
      setBusy(false);
      setLevel(0);
    }
  }
  return (
    <div className="wb-mic-preview">
      <button disabled={busy || !deviceId} onClick={() => void preview()}>
        {busy ? "Speak for three seconds…" : "Test microphone"}
      </button>
      <meter aria-label="Microphone level" min="0" max="1" value={level} />
      {url && <audio controls src={url} />}
      <small>
        {error ||
          "Listen to the sample before starting. This preview stays in memory."}
      </small>
    </div>
  );
}
