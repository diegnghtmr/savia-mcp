import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { parseHttpUrl, responseText } from "./http-policy.js";

type Environment = Readonly<Record<string, string | undefined>>;
const headerSchema = z.object({ alg: z.enum(["ES256", "RS256"]), kid: z.string().min(1).max(128) });
const claimsSchema = z.object({ iss: z.string(), aud: z.union([z.string(), z.tuple([z.string()])]),
  sub: z.uuid(), mcp_grant_id: z.uuid(), exp: z.number(), nbf: z.number().optional() });
const keySetSchema = z.object({ keys: z.array(z.object({ kid: z.string().optional(), kty: z.string(),
  use: z.string().optional(), alg: z.string().optional(), key_ops: z.array(z.string()).optional(),
  crv: z.string().optional(), x: z.string().optional(), y: z.string().optional(),
  n: z.string().optional(), e: z.string().optional() })).max(64) });
type KeySet = z.infer<typeof keySetSchema>["keys"];
type Header = z.infer<typeof headerSchema>;
const MAX_TOKEN_CHARS = 8192;
const CACHE_MS = 60_000;

function decode(segment: string): Buffer {
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) throw Error("Invalid encoding.");
  return bytes;
}

function jsonSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(segment)));
}

function signingKey(keys: KeySet, { alg, kid }: Header): KeyObject | null {
  const matches = keys.filter(key => key.kid === kid);
  const key = matches[0];
  if (matches.length !== 1 || !key || (key.use !== undefined && key.use !== "sig") ||
      (key.alg !== undefined && key.alg !== alg) || (key.key_ops && !key.key_ops.includes("verify"))) return null;
  if (alg === "ES256" && key.kty === "EC" && key.crv === "P-256" && key.x && key.y)
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: key.x, y: key.y }, format: "jwk" });
  if (alg === "RS256" && key.kty === "RSA" && key.n && key.e) {
    const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) return publicKey;
  }
  return null;
}

async function retrieveKeys(url: URL): Promise<KeySet> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });
  if (!response.ok) { await response.body?.cancel(); throw Error("Invalid key set."); }
  const body = await responseText(response, 65_536);
  if (body === null) throw Error("Invalid key set.");
  return keySetSchema.parse(JSON.parse(body)).keys;
}

export function createRemoteAuth(env: Environment) {
  const resource = parseHttpUrl(env.SAVIA_MCP_PROPOSAL_AUDIENCE);
  const issuer = parseHttpUrl(env.JWT_ISSUER);
  const upstream = parseHttpUrl(env.SAVIA_API_URL);
  // The backend's annotated /v1 routes must be on the canonical resource origin, not an arbitrary base path.
  if (!resource || resource.href !== env.SAVIA_MCP_PROPOSAL_AUDIENCE || /[?#]/u.test(resource.href) ||
      resource.pathname.startsWith("/.well-known/") || !issuer || issuer.href !== env.JWT_ISSUER ||
      /[?#]/u.test(issuer.href) || upstream?.href !== `${resource.origin}/`)
    throw Error("Invalid Savia remote MCP configuration.");
  const audience = resource.href, issuerId = issuer.href;
  const jwks = new URL(issuer);
  jwks.pathname = issuer.pathname.replace(/\/$/u, "") + "/.well-known/jwks.json";
  let cached: { keys: KeySet; until: number } | undefined;
  let refresh: Promise<KeySet> | undefined;
  function keys(): Promise<KeySet> {
    if (cached && Date.now() < cached.until) return Promise.resolve(cached.keys);
    refresh ??= retrieveKeys(jwks)
      .then(value => { cached = { keys: value, until: Date.now() + CACHE_MS }; return value; },
        () => { cached = { keys: [], until: Date.now() + 5000 }; return []; })
      .finally(() => { refresh = undefined; });
    return refresh;
  }
  async function verifyBearer(authorization: string | undefined): Promise<string | null> {
    if (!authorization || authorization.length > MAX_TOKEN_CHARS) return null;
    const match = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/iu.exec(authorization);
    const [, encodedHeader, encodedClaims, encodedSignature] = match ?? [];
    if (!encodedHeader || !encodedClaims || !encodedSignature) return null;
    try {
      const rawHeader = jsonSegment(encodedHeader);
      const header = headerSchema.parse(rawHeader);
      // Do not implement JOSE extensions or discover keys from token-supplied URLs.
      if (Object.hasOwn(rawHeader as object, "crit") || Object.hasOwn(rawHeader as object, "b64")) return null;
      const claims = claimsSchema.parse(jsonSegment(encodedClaims));
      const current = () => Date.now() / 1000;
      if (claims.iss !== issuerId || (typeof claims.aud === "string" ? claims.aud : claims.aud[0]) !== audience ||
          claims.exp <= current() || (claims.nbf !== undefined && claims.nbf > current())) return null;
      const key = signingKey(await keys(), header);
      if (!key || !verify("sha256", Buffer.from(`${encodedHeader}.${encodedClaims}`),
        header.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key, decode(encodedSignature)) ||
        claims.exp <= current()) return null;
      return `${encodedHeader}.${encodedClaims}.${encodedSignature}`;
    } catch { return null; }
  }
  return { resource, issuer, upstream, verifyBearer };
}
