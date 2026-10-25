const { ipcRenderer } = require("electron");
let screenStream,
  micStream,
  screenVideo,
  encodeCanvas,
  nativeCanvas,
  encodedStream;
let baseNow = 0,
  baseUs = 0,
  recordingId = null,
  settings = null,
  active = false,
  timer,
  frameTimer,
  healthTimer;
let group = [],
  groups = new Set(),
  sequence = { screen: 0, microphone: 0 },
  lastStill = "",
  stillBusy = false,
  forceMarker = false,
  rotationTask = null;
let sourceConfig;
let syntheticTimer,
  syntheticAudio,
  clockTimer,
  uncertaintyUs = 100000,
  clockSamples = [];
async function calibrate() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const before = performance.now(),
      r = await invoke("clock", {}),
      after = performance.now();
    samples.push({
      mid: (before + after) / 2,
      atUs: r.atUs,
      rttUs: (after - before) * 1000,
    });
  }
  const best = samples.sort((a, b) => a.rttUs - b.rttUs)[0];
  if (
    clockSamples.length &&
    Math.abs(best.atUs - (baseUs + (best.mid - baseNow) * 1000)) > 250000
  )
    throw new Error("Capture clock discontinuity; recording requires review.");
  baseNow = best.mid;
  baseUs = best.atUs;
  uncertaintyUs = Math.ceil(best.rttUs / 2) + 100000;
  clockSamples = samples;
}
const sessionUs = () =>
  Math.round(baseUs + (performance.now() - baseNow) * 1000);
const chunkChannel = new MessageChannel(),
  chunkPort = chunkChannel.port1,
  chunkCalls = new Map();
chunkPort.onmessage = (event) => {
  const reply = event.data,
    call = chunkCalls.get(reply.id);
  if (!call) return;
  chunkCalls.delete(reply.id);
  clearTimeout(call.timer);
  reply.ok ? call.resolve(reply.value) : call.reject(new Error(reply.error));
};
chunkPort.onclose = () => {
  for (const call of chunkCalls.values()) {
    clearTimeout(call.timer);
    call.reject(new Error("Capture writer channel closed."));
  }
  chunkCalls.clear();
};
chunkPort.start();
const invoke = (method, payload) =>
  method !== "chunk"
    ? ipcRenderer.invoke("webinar:capture-data", { method, payload })
    : new Promise((resolve, reject) => {
        const id = crypto.randomUUID(),
          timer = setTimeout(() => {
            chunkCalls.delete(id);
            reject(new Error("Capture writer acknowledgment timed out."));
          }, 30000);
        // Bounded copying passed runtime qualification; transferred ArrayBuffers did not preserve the envelope.
        chunkCalls.set(id, { resolve, reject, timer });
        chunkPort.postMessage({ id, payload });
      });
function fatal(error) {
  ipcRenderer.send("webinar:capture-fault", String(error?.message || error));
}
function sendBlob(segment, blob) {
  if (segment.pendingBytes + blob.size > 16 * 1024 * 1024)
    return Promise.reject(new Error("Capture writer cannot keep up."));
  segment.pendingBytes += blob.size;
  segment.chain = segment.chain.then(async () => {
    const data = new Uint8Array(await blob.arrayBuffer());
    for (let offset = 0; offset < data.length; offset += 1024 * 1024)
      await invoke("chunk", {
        segmentId: segment.id,
        sequence: segment.chunk++,
        bytes: data.slice(offset, offset + 1024 * 1024),
      });
    segment.pendingBytes -= data.length;
  });
  return segment.chain;
}
function mime(track) {
  const values =
    track === "screen"
      ? ["video/webm;codecs=vp8", "video/webm"]
      : ["audio/webm;codecs=opus", "audio/webm"];
  const value = values.find((v) => MediaRecorder.isTypeSupported(v));
  if (!value) throw new Error("WebM capture is unavailable.");
  return value;
}
async function openSegment(track, stream) {
  const id = crypto.randomUUID(),
    type = mime(track),
    start = sessionUs();
  await invoke("open", {
    recordingId,
    segmentId: id,
    track,
    startUs: start,
    sequence: sequence[track]++,
    uncertaintyUs,
    clockSamples,
  });
  const recorder = new MediaRecorder(stream, {
    mimeType: type,
    ...(track === "screen"
      ? { videoBitsPerSecond: settings.videoBitsPerSecond }
      : { audioBitsPerSecond: settings.audioBitsPerSecond }),
  });
  const segment = {
    stopUs: null,
    id,
    recorder,
    chunk: 0,
    pendingBytes: 0,
    chain: Promise.resolve(),
    type,
    track,
  };
  recorder.ondataavailable = (e) => {
    if (e.data.size) sendBlob(segment, e.data).catch(fatal);
  };
  recorder.onerror = (e) =>
    fatal(e.error || new Error("Media recording failed"));
  segment.finished = new Promise((resolve, reject) => {
    segment.resolve = resolve;
    segment.reject = reject;
  });
  recorder.onstop = () => {
    segment.chain
      .then(() =>
        invoke("seal", {
          segmentId: id,
          endUs: segment.stopUs ?? sessionUs(),
          mime: type,
        }),
      )
      .then(segment.resolve, segment.reject);
  };
  recorder.start(1000);
  return segment;
}
async function startGroup() {
  const g = await Promise.all([
    openSegment("screen", encodedStream),
    openSegment("microphone", micStream),
  ]);
  groups.add(g);
  return g;
}
async function stopGroup(g) {
  for (const s of g)
    if (s.recorder.state !== "inactive") {
      s.stopUs = sessionUs();
      s.recorder.stop();
    }
  await Promise.all(g.map((s) => s.finished));
  groups.delete(g);
}
async function rotate() {
  if (!active) return;
  try {
    if (groups.size > 1)
      throw new Error("Previous segment did not seal before rotation.");
    const previous = group;
    group = await startGroup();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await Promise.race([
      stopGroup(previous),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Segment sealing timed out")), 10000),
      ),
    ]);
  } catch (e) {
    fatal(e);
  }
}
async function still() {
  if (!active || stillBusy) return;
  stillBusy = true;
  try {
    const w = screenVideo.videoWidth,
      h = screenVideo.videoHeight;
    if (!w || !h) return;
    nativeCanvas.width = w;
    nativeCanvas.height = h;
    nativeCanvas.getContext("2d").drawImage(screenVideo, 0, 0, w, h);
    const tiny = new OffscreenCanvas(32, 18),
      ctx = tiny.getContext("2d");
    ctx.drawImage(nativeCanvas, 0, 0, 32, 18);
    const raw = ctx.getImageData(0, 0, 32, 18).data;
    let signature = "";
    for (let i = 0; i < raw.length; i += 16)
      signature += String.fromCharCode(Math.round(raw[i] / 16));
    const marker = forceMarker;
    forceMarker = false;
    if (signature === lastStill && !marker && sessionUs() % 5000000 > 1000000)
      return;
    lastStill = signature;
    const capturedAt = sessionUs();
    const blob = await nativeCanvas.convertToBlob({ type: "image/png" });
    await invoke("frame", {
      recordingId,
      atUs: capturedAt,
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: w,
      height: h,
      source: marker ? "marker" : "scene",
    });
  } finally {
    stillBusy = false;
  }
}
async function start(p) {
  sourceConfig = p;
  settings = p.profile;
  recordingId = p.recordingId;
  baseNow = performance.now();
  baseUs = p.atUs;
  await calibrate();
  clockTimer = setInterval(() => void calibrate().catch(fatal), 10000);
  if (p.synthetic) {
    const pattern = document.createElement("canvas");
    pattern.width = 1280;
    pattern.height = 720;
    const ctx = pattern.getContext("2d");
    let count = 0;
    const draw = () => {
      ctx.fillStyle = count % 2 ? "#172f3b" : "#274d5b";
      ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = "#fff";
      ctx.font = "48px monospace";
      ctx.fillText("nDimensions.AI capture test", 60, 130);
      ctx.fillText("Frame " + count++ + " · const answer = 42;", 60, 260);
      ctx.fillText("test@example.com", 60, 390);
    };
    draw();
    syntheticTimer = setInterval(draw, 500);
    screenStream = pattern.captureStream(settings.fps);
    syntheticAudio = new AudioContext();
    const oscillator = syntheticAudio.createOscillator(),
      gain = syntheticAudio.createGain(),
      destination = syntheticAudio.createMediaStreamDestination();
    gain.gain.value = 0.03;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    micStream = destination.stream;
  } else {
    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: p.sourceId,
          maxFrameRate: settings.fps,
        },
      },
    });
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: p.microphoneId ? { exact: p.microphoneId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
      },
      video: false,
    });
  }
  for (const stream of [screenStream, micStream])
    for (const track of stream.getTracks())
      track.onended = () =>
        fatal(new Error("Capture source was disconnected."));
  screenVideo = document.createElement("video");
  screenVideo.muted = true;
  screenVideo.srcObject = screenStream;
  await screenVideo.play();
  encodeCanvas = document.createElement("canvas");
  const ratio = Math.min(
    settings.width / screenVideo.videoWidth,
    settings.height / screenVideo.videoHeight,
    1,
  );
  encodeCanvas.width = Math.round(screenVideo.videoWidth * ratio);
  encodeCanvas.height = Math.round(screenVideo.videoHeight * ratio);
  const draw = () =>
    encodeCanvas
      .getContext("2d")
      .drawImage(screenVideo, 0, 0, encodeCanvas.width, encodeCanvas.height);
  draw();
  frameTimer = setInterval(draw, 1000 / settings.fps);
  encodedStream = encodeCanvas.captureStream(settings.fps);
  nativeCanvas = new OffscreenCanvas(
    screenVideo.videoWidth,
    screenVideo.videoHeight,
  );
  active = true;
  group = await startGroup();
  timer = setInterval(() => {
    if (!rotationTask)
      rotationTask = rotate().finally(() => {
        rotationTask = null;
      });
  }, settings.segmentTargetSeconds * 1000);
  healthTimer = setInterval(() => {
    ipcRenderer.send("webinar:capture-health", { atUs: sessionUs() });
    void still().catch(fatal);
  }, 1000);
  await still();
  return { width: screenVideo.videoWidth, height: screenVideo.videoHeight };
}
async function pause() {
  const atUs = sessionUs();
  active = false;
  clearInterval(timer);
  clearInterval(healthTimer);
  clearInterval(frameTimer);
  clearInterval(clockTimer);
  clearInterval(syntheticTimer);
  await rotationTask;
  for (const g of [...groups]) await stopGroup(g);
  for (const stream of [screenStream, micStream, encodedStream])
    stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
  if (syntheticAudio && syntheticAudio.state !== "closed")
    await syntheticAudio.close();
  return { atUs };
}
async function stop() {
  return pause();
}
ipcRenderer.on("webinar:capture-control", async (_event, request) => {
  try {
    let value;
    if (request.method === "start") value = await start(request.payload);
    else if (request.method === "pause") value = await pause();
    else if (request.method === "resume") {
      value = await start({ ...sourceConfig, atUs: request.payload.atUs });
    } else if (request.method === "marker") {
      forceMarker = true;
      await still();
      value = { atUs: sessionUs() };
    } else if (request.method === "stop") value = await stop();
    else throw new Error("Unsupported capture command");
    ipcRenderer.send("webinar:capture-result", {
      id: request.id,
      ok: true,
      value,
    });
  } catch (e) {
    ipcRenderer.send("webinar:capture-result", {
      id: request.id,
      ok: false,
      error: String(e.message || e),
    });
  }
});
if (
  location.protocol === "file:" &&
  location.pathname.endsWith("/capture.html")
) {
  ipcRenderer.postMessage("webinar:capture-port", null, [chunkChannel.port2]);
  ipcRenderer.send("webinar:capture-ready");
}
