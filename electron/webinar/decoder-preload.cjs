const { ipcRenderer } = require("electron");
ipcRenderer.on("webinar:decode", async (_event, p) => {
  try {
    const bytes = p.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 128 * 1024 * 1024)
      throw new Error("Invalid segment size");
    if (p.track === "microphone") {
      const context = new AudioContext({ sampleRate: 16000 });
      try {
        const decoded = await context.decodeAudioData(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
        );
        if (decoded.duration > 45)
          throw new Error("Audio segment exceeds the decode limit");
        const samples = new Float32Array(decoded.length);
        for (let c = 0; c < decoded.numberOfChannels; c++) {
          const channel = decoded.getChannelData(c);
          for (let i = 0; i < samples.length; i++)
            samples[i] += channel[i] / decoded.numberOfChannels;
        }
        ipcRenderer.send("webinar:decoded", {
          id: p.id,
          ok: true,
          value: {
            durationUs: Math.round(decoded.duration * 1e6),
            samples: p.samples ? samples : undefined,
          },
        });
      } finally {
        await context.close();
      }
    } else {
      const video = document.createElement("video");
      video.muted = true;
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "video/webm" }),
      );
      try {
        video.src = url;
        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = () =>
            reject(new Error("Video segment is not decodable"));
        });
        if (!Number.isFinite(video.duration)) {
          video.currentTime = 1e9;
          await new Promise((resolve, reject) => {
            video.ontimeupdate = resolve;
            video.onerror = () =>
              reject(new Error("Cannot find segment duration"));
          });
        }
        let duration = video.duration;
        if (!Number.isFinite(duration)) duration = video.currentTime;
        if (!Number.isFinite(duration) || duration <= 0 || duration > 45)
          throw new Error("Invalid video duration");
        let frame = {};
        if (p.frameAtUs !== undefined) {
          if (
            !Number.isSafeInteger(p.frameAtUs) ||
            p.frameAtUs < 0 ||
            p.frameAtUs >= duration * 1e6
          )
            throw new Error("Frame is outside the segment");
          await new Promise((resolve, reject) => {
            video.onseeked = resolve;
            video.onerror = () => reject(new Error("Frame seek failed"));
            video.currentTime = p.frameAtUs / 1e6;
          });
          const canvas = new OffscreenCanvas(
            video.videoWidth,
            video.videoHeight,
          );
          canvas.getContext("2d").drawImage(video, 0, 0);
          frame = {
            bytes: new Uint8Array(
              await (
                await canvas.convertToBlob({ type: "image/png" })
              ).arrayBuffer(),
            ),
            width: video.videoWidth,
            height: video.videoHeight,
            seekTimeUs: Math.round(video.currentTime * 1e6),
          };
        }
        ipcRenderer.send("webinar:decoded", {
          id: p.id,
          ok: true,
          value: { durationUs: Math.round(duration * 1e6), ...frame },
        });
      } finally {
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
      }
    }
  } catch (e) {
    ipcRenderer.send("webinar:decoded", {
      id: p.id,
      ok: false,
      error: String(e.message || e),
    });
  }
});
ipcRenderer.send("webinar:decoder-ready");
