export function parseHttpUrl(value: string | undefined): URL | null {
  const url = URL.parse(value ?? "");
  if (!url || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname;
  const loopback = host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(host);
  return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url : null;
}

export async function responseText(response: Response, maxBytes = 1_048_576): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > maxBytes) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
  } finally { reader.releaseLock(); }
}
