import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../config/env';

export interface JwtKeys {
  privateKey: string;
  publicKey: string;
}

/**
 * Khóa ES256 cho access token (mục 19.1).
 * Production: lấy từ biến môi trường (secret của Render). Dev: tự sinh và lưu vào apps/api/.keys (gitignored).
 */
export function loadJwtKeys(): JwtKeys {
  const environment = env();
  if (environment.JWT_PRIVATE_KEY && environment.JWT_PUBLIC_KEY) {
    return { privateKey: environment.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'), publicKey: environment.JWT_PUBLIC_KEY.replace(/\\n/g, '\n') };
  }
  if (environment.NODE_ENV === 'production') {
    throw new Error('JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required in production');
  }
  const dir = join(process.cwd(), '.keys');
  const privPath = join(dir, 'jwt-es256-private.pem');
  const pubPath = join(dir, 'jwt-es256-public.pem');
  if (!existsSync(privPath) || !existsSync(pubPath)) {
    mkdirSync(dir, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    writeFileSync(privPath, privateKey, { mode: 0o600 });
    writeFileSync(pubPath, publicKey);
  }
  return { privateKey: readFileSync(privPath, 'utf8'), publicKey: readFileSync(pubPath, 'utf8') };
}
