// 서버가 대신 써야 해서 해시로 둘 수 없는 비밀값(사람마다의 Jira 토큰)을 암호화해 저장한다(ADR-0009).
// 키는 TEVRO_SECRET_KEY(32바이트를 base64 또는 hex로). 키를 잃으면 저장한 값을 되살릴 수 없고, 각자 다시 등록해야 한다.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
  /** 키를 알아볼 수 있게 남기는 짧은 지문(키 자체는 아님). 키가 바뀌었는지 알리는 데 쓴다 */
  readonly fingerprint: string;
}

/** 키 문자열을 읽는다. 없거나 32바이트가 아니면 null과 이유. */
export function readSecretKey(value: string | undefined): { key: Buffer } | { error: string } {
  if (!value) return { error: 'TEVRO_SECRET_KEY가 없습니다.' };
  const text = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) return { error: 'TEVRO_SECRET_KEY는 32바이트(예: openssl rand -base64 32)여야 합니다.' };
  return { key };
}

/** AES-256-GCM. 저장 형식: v1.<nonce>.<암호문+태그>(base64url) */
export function createSecretBox(key: Buffer): SecretBox {
  return {
    fingerprint: createHash('sha256').update(key).digest('hex').slice(0, 12),
    seal(plain) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      return `v1.${nonce.toString('base64url')}.${body.toString('base64url')}`;
    },
    open(sealed) {
      const [version, nonce, body] = sealed.split('.');
      if (version !== 'v1' || !nonce || !body) throw new Error('알 수 없는 암호문 형식');
      const data = Buffer.from(body, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
      decipher.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
    },
  };
}
