/**
 * AWS Signature Version 4 request signing on WebCrypto (`crypto.subtle`), used
 * for Amazon Bedrock instead of the AWS SDK. Follows the algorithm in
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 * and the AWS SDK v3 `SignatureV4` defaults for non-S3 services:
 *  - the canonical URI is the request path URI-encoded AGAIN (so a model id
 *    `...-v1:0` sent as `...-v1%3A0` is signed as `...-v1%253A0`);
 *  - `x-amz-content-sha256` is added and signed.
 *
 * WebCrypto exists only in secure contexts (https, http://localhost, file:).
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** For temporary (STS / SSO) credentials; sent as `x-amz-security-token`. */
  sessionToken?: string;
}

export interface SignRequestInput {
  method: string;
  /** Absolute URL; its path must already be percent-encoded as it is sent. */
  url: string;
  /** Headers to send and sign (any case). Do not include `host`. */
  headers?: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Signing time; defaults to now. */
  date?: Date;
  /** Add and sign `x-amz-content-sha256` (AWS SDK default). Default true. */
  signContentSha256?: boolean;
  /** URI-encode the path once more for the canonical URI (all services but S3). Default true. */
  doubleEncodePath?: boolean;
}

export interface SignedRequest {
  /**
   * Headers to pass to `fetch`: the input headers plus `authorization`,
   * `x-amz-date` and, when applicable, `x-amz-content-sha256` and
   * `x-amz-security-token`. `host` is signed but not returned: browsers set it.
   */
  headers: Record<string, string>;
  /** Intermediate values, handy for tests and debugging. */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

const encoder = new TextEncoder();

function utf8(s: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(s) as Uint8Array<ArrayBuffer>;
}

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error(
      "WebCrypto (crypto.subtle) is unavailable: open the report over https, http://localhost or as a local file to use Amazon Bedrock.",
    );
  }
  return c.subtle;
}

export function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(data: string): Promise<string> {
  return toHex(await subtle().digest("SHA-256", utf8(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const k = await subtle().importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return subtle().sign("HMAC", k, utf8(data));
}

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request"). */
export async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(utf8("AWS4" + secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ is escaped. */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** `20150830T123600Z` */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function canonicalUri(pathname: string, doubleEncode: boolean): string {
  if (!pathname) return "/";
  if (!doubleEncode) return pathname;
  return pathname
    .split("/")
    .map((segment) => uriEncode(segment))
    .join("/");
}

function canonicalQuery(search: string): string {
  if (!search || search === "?") return "";
  const pairs = search
    .replace(/^\?/, "")
    .split("&")
    .filter((p) => p.length > 0)
    .map((p) => {
      const eq = p.indexOf("=");
      const rawKey = eq < 0 ? p : p.slice(0, eq);
      const rawValue = eq < 0 ? "" : p.slice(eq + 1);
      const decode = (v: string) => decodeURIComponent(v.replace(/\+/g, " "));
      return [uriEncode(decode(rawKey)), uriEncode(decode(rawValue))] as const;
    });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function normalizeHeaderValue(v: string): string {
  return v.trim().replace(/\s+/g, " ");
}

export async function signRequest(input: SignRequestInput): Promise<SignedRequest> {
  const url = new URL(input.url);
  const body = input.body ?? "";
  const date = input.date ?? new Date();
  const xAmzDate = amzDate(date);
  const dateStamp = xAmzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);

  const sendHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (name.toLowerCase() === "host") continue;
    sendHeaders[name.toLowerCase()] = value;
  }
  sendHeaders["x-amz-date"] = xAmzDate;
  if (input.signContentSha256 !== false) sendHeaders["x-amz-content-sha256"] = payloadHash;
  if (input.credentials.sessionToken) sendHeaders["x-amz-security-token"] = input.credentials.sessionToken;

  const toSign: Record<string, string> = { ...sendHeaders, host: url.host };
  const names = Object.keys(toSign).sort();
  const canonicalHeaders = names.map((n) => `${n}:${normalizeHeaderValue(toSign[n])}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(url.pathname, input.doubleEncodePath !== false),
    canonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", xAmzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const key = await deriveSigningKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service);
  const signature = toHex(await hmac(key, stringToSign));

  sendHeaders["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers: sendHeaders, canonicalRequest, stringToSign, signature };
}
