import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { ticketInput } from './security.mjs';

// KMS emits ASN.1 DER; ES256 on the wire requires the fixed-width R || S form.
export function derToP1363(value) {
  const der = Buffer.from(value), numbers = [];
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error('invalid KMS signature');
  let at = 2;
  for (let i = 0; i < 2; i++) {
    if (der[at++] !== 0x02) throw new Error('invalid KMS signature');
    const length = der[at++];
    if (!length || length > 33 || at + length > der.length || (der[at] & 0x80)) throw new Error('invalid KMS signature');
    let integer = der.subarray(at, at + length); at += length;
    if (integer.length === 33) { if (integer[0] !== 0) throw new Error('invalid KMS signature'); integer = integer.subarray(1); }
    numbers.push(Buffer.concat([Buffer.alloc(32 - integer.length), integer]));
  }
  if (at !== der.length) throw new Error('invalid KMS signature');
  return Buffer.concat(numbers);
}
export function kmsSigner(keyId, client = new KMSClient({ maxAttempts: 3 })) {
  return async (claims, seconds) => {
    const input = ticketInput(claims, seconds);
    const result = await client.send(new SignCommand({ KeyId: keyId, Message: Buffer.from(input), MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' }));
    return `${input}.${derToP1363(result.Signature).toString('base64url')}`;
  };
}
