/** Byte helpers for wallet messages and signatures (no dependencies; browser and Node). */

const HEX = '0123456789abcdef';

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

/** personal_sign's message parameter: the UTF-8 bytes of the message as 0x-hex (EIP-1193 wallets all accept it). */
export const hexUtf8 = (message: string) => '0x' + toHex(utf8(message));

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58 (Bitcoin alphabet), for Solana public keys handed over as bytes. */
export function toBase58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** Only data: images (what EIP-6963 and the Wallet Standard require) are ever put in an <img>. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml)(?:;[a-z0-9=._+-]+)*(?:;base64)?,/i;
export function safeIcon(icon: unknown): string | null {
  return typeof icon === 'string' && icon.length <= 200_000 && DATA_IMAGE.test(icon) ? icon : null;
}

export const RE_EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const RE_SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
