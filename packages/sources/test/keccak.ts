/**
 * Keccak-256 as Ethereum uses it (original Keccak padding, not NIST SHA3-256), so tests can check selectors and
 * storage slot constants against their source strings. Lanes as BigInt: slow, fine for a few short inputs.
 * After the Keccak team's CompactFIPS202 reference.
 */
const MASK = (1n << 64n) - 1n;
const rol = (a: bigint, n: number) => ((a << BigInt(n % 64)) | (a >> BigInt((64 - (n % 64)) % 64))) & MASK;

function keccakF1600(lanes: bigint[][]): void {
  let r = 1;
  for (let round = 0; round < 24; round++) {
    // θ
    const c = [0, 1, 2, 3, 4].map(x => lanes[x][0] ^ lanes[x][1] ^ lanes[x][2] ^ lanes[x][3] ^ lanes[x][4]);
    const d = [0, 1, 2, 3, 4].map(x => c[(x + 4) % 5] ^ rol(c[(x + 1) % 5], 1));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) lanes[x][y] ^= d[x];
    // ρ and π
    let x = 1, y = 0;
    let current = lanes[x][y];
    for (let t = 0; t < 24; t++) {
      [x, y] = [y, (2 * x + 3 * y) % 5];
      const next = lanes[x][y];
      lanes[x][y] = rol(current, ((t + 1) * (t + 2)) / 2);
      current = next;
    }
    // χ
    for (let yy = 0; yy < 5; yy++) {
      const t = [0, 1, 2, 3, 4].map(xx => lanes[xx][yy]);
      for (let xx = 0; xx < 5; xx++) lanes[xx][yy] = t[xx] ^ (~t[(xx + 1) % 5] & MASK & t[(xx + 2) % 5]);
    }
    // ι
    for (let j = 0; j < 7; j++) {
      r = ((r << 1) ^ ((r >> 7) * 0x71)) % 256;
      if (r & 2) lanes[0][0] ^= 1n << BigInt((1 << j) - 1);
    }
  }
}

function permute(state: Uint8Array): void {
  const lanes = [0, 1, 2, 3, 4].map(x =>
    [0, 1, 2, 3, 4].map(y => {
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(state[8 * (x + 5 * y) + i]);
      return v;
    }),
  );
  keccakF1600(lanes);
  for (let x = 0; x < 5; x++) {
    for (let y = 0; y < 5; y++) {
      let v = lanes[x][y];
      for (let i = 0; i < 8; i++) {
        state[8 * (x + 5 * y) + i] = Number(v & 0xffn);
        v >>= 8n;
      }
    }
  }
}

/** keccak256 of a UTF-8 string, lowercase hex without 0x */
export function keccak256(text: string): string {
  const input = Buffer.from(text, 'utf8');
  const rate = 136;
  const state = new Uint8Array(200);
  let offset = 0;
  let block = 0;
  while (offset < input.length) {
    block = Math.min(input.length - offset, rate);
    for (let i = 0; i < block; i++) state[i] ^= input[offset + i];
    offset += block;
    if (block === rate) {
      permute(state);
      block = 0;
    }
  }
  state[block] ^= 0x01;
  state[rate - 1] ^= 0x80;
  permute(state);
  return Buffer.from(state.subarray(0, 32)).toString('hex');
}

/** 4-byte function selector, lowercase hex without 0x */
export const selector = (signature: string) => keccak256(signature).slice(0, 8);
