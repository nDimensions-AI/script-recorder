import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";

export function assetResponse(
  filename: string,
  mime: string,
  expectedLength: number,
  method: string,
  range: string | null,
  origin: string,
) {
  const size = statSync(filename).size,
    headers = new Headers({
      "Content-Type": mime,
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": origin,
      "X-Content-Type-Options": "nosniff",
    });
  if (size !== expectedLength)
    return new Response("Asset changed", { status: 409, headers });
  let start = 0,
    end = size - 1,
    status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    const reject = () =>
      new Response(null, {
        status: 416,
        headers: new Headers({
          ...Object.fromEntries(headers),
          "Content-Range": `bytes */${size}`,
        }),
      });
    if (!m || (!m[1] && !m[2]) || !size) return reject();
    if (!m[1]) {
      const suffix = Number(m[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return reject();
      start = Math.max(0, size - suffix);
    } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= size
    )
      return reject();
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  return new Response(
    method === "HEAD" || !size
      ? null
      : (Readable.toWeb(
          createReadStream(filename, { start, end }),
        ) as ReadableStream),
    { status, headers },
  );
}
