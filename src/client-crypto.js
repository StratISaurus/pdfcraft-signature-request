// Browser-compatible WebCrypto. Never send the returned key to the relay.
export const PROTOCOL = 'pdfcraft-relay-experimental-v1';
const aad = new TextEncoder().encode(PROTOCOL);
const encode = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));

export async function encryptBytes(bytes) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, bytes);
  return {
    key: encode(new Uint8Array(await crypto.subtle.exportKey('raw', key))),
    payload: { protocol: PROTOCOL, nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) },
  };
}

export async function decryptBytes(payload, encodedKey) {
  if (payload.protocol !== PROTOCOL) throw new Error('Unsupported protocol');
  const key = await crypto.subtle.importKey('raw', decode(encodedKey), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(payload.nonce), additionalData: aad, tagLength: 128 }, key, decode(payload.ciphertext)));
}
