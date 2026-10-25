import { randomBytes } from 'node:crypto';

// Crockford base32(I, L, O, U 제외)를 소문자로 쓴다(ADR-0005).
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** 타입 접두사 + ULID(시각 48비트 10자 + 무작위 80비트 16자). 예: tsk_01k7m3e5q2w9r4t6y8v0x2z4pe */
export function newId(prefix: 'prj' | 'tsk'): string {
  let time = Date.now();
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = ALPHABET[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  let randomPart = '';
  for (const byte of randomBytes(16)) randomPart += ALPHABET[byte % 32];
  return `${prefix}_${timePart}${randomPart}`;
}
