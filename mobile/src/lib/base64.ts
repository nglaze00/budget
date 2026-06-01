// Pure-JS base64 (no Node Buffer, which doesn't exist in React Native / Hermes).
// Used by SimpleFIN: setup tokens are base64-encoded claim URLs, and access URLs
// carry inline Basic-Auth credentials we must re-encode into an Authorization header.

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(input: string): string {
  // Encode as UTF-8 first so multi-byte chars survive.
  const bytes = utf8Bytes(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += CHARS[(triple >> 18) & 0x3f];
    out += CHARS[(triple >> 12) & 0x3f];
    out += i + 1 < bytes.length ? CHARS[(triple >> 6) & 0x3f] : "=";
    out += i + 2 < bytes.length ? CHARS[triple & 0x3f] : "=";
  }
  return out;
}

export function base64Decode(input: string): string {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const e0 = CHARS.indexOf(clean[i]);
    const e1 = CHARS.indexOf(clean[i + 1]);
    const e2 = clean[i + 2] === "=" || clean[i + 2] === undefined ? -1 : CHARS.indexOf(clean[i + 2]);
    const e3 = clean[i + 3] === "=" || clean[i + 3] === undefined ? -1 : CHARS.indexOf(clean[i + 3]);
    const b0 = (e0 << 2) | (e1 >> 4);
    bytes.push(b0 & 0xff);
    if (e2 >= 0) {
      const b1 = ((e1 & 0xf) << 4) | (e2 >> 2);
      bytes.push(b1 & 0xff);
    }
    if (e3 >= 0) {
      const b2 = ((e2 & 0x3) << 6) | e3;
      bytes.push(b2 & 0xff);
    }
  }
  return utf8Decode(bytes);
}

function utf8Bytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // surrogate pair
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return bytes;
}

function utf8Decode(bytes: number[]): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b >= 0xc0 && b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b >= 0xe0 && b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      const off = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff));
    }
  }
  return out;
}
