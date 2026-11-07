// Real keys, made once per test file: loading the config signs with the ASC key, and a Play poll signs its token request.
import { generateKeyPairSync } from 'node:crypto';

const pkcs8 = { type: 'pkcs8', format: 'pem' } as const;
export const ascKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export(pkcs8) as string;
export const serviceAccount = {
  client_email: 'poller@acme.iam',
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export(pkcs8) as string,
};
