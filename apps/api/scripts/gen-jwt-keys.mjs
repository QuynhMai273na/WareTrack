// In ra cặp khóa ES256 ở dạng một dòng (\n) để dán vào biến môi trường JWT_PRIVATE_KEY / JWT_PUBLIC_KEY trên Render.
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const oneLine = (pem) => pem.trim().replace(/\n/g, '\\n');
console.log(`JWT_PRIVATE_KEY=${oneLine(privateKey)}`);
console.log(`JWT_PUBLIC_KEY=${oneLine(publicKey)}`);
