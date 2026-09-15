import http from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:8010";

/**
 * File upload goes through this handler instead of the /api rewrite: rewrites copy the request body
 * into memory and silently cut it at 10 MB. Here the body is piped to the API with backpressure.
 */
export async function PUT(req: Request, ctx: RouteContext<"/api/jobs/[id]/file">) {
  const { id } = await ctx.params;
  const headers: Record<string, string> = {};
  for (const name of ["cookie", "content-type", "content-length"]) {
    const v = req.headers.get(name);
    if (v) headers[name] = v;
  }

  return new Promise<Response>((resolve) => {
    const body = req.body ? Readable.fromWeb(req.body as NodeReadableStream<Uint8Array>) : null;
    const upstream = http.request(
      new URL(`/api/jobs/${encodeURIComponent(id)}/file`, API_URL),
      { method: "PUT", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          body?.destroy();
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 502,
              headers: { "content-type": res.headers["content-type"] ?? "application/json" },
            }),
          );
        });
      },
    );
    upstream.on("error", () => {
      body?.destroy();
      resolve(Response.json({ error: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองอัปโหลดใหม่อีกครั้ง" }, { status: 502 }));
    });
    // Browser cancelled or disconnected: abort the API request so it drops the partial file.
    req.signal.addEventListener("abort", () => upstream.destroy());
    if (body) {
      body.on("error", () => upstream.destroy());
      body.pipe(upstream);
    } else {
      upstream.end();
    }
  });
}
