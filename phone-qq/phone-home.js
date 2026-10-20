import { realpathSync } from 'node:fs';
import path from 'node:path';

// Android filesDir may use /data/user/0 while DSH session cwd uses its
// /data/data real path. Scope both shared skill providers to that same home.
export function canonicalPhoneHome(env = process.env) {
  return realpathSync(env.DSH_HOME ?? path.join(env.HOME, '.dsh'));
}
