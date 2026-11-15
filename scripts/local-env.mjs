import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (!existsSync('.env')) {
 const password=randomBytes(24).toString('hex');
 writeFileSync('.env',`ORVYN_DB_PASSWORD=${password}\nDATABASE_URL=postgres://orvyn:${password}@127.0.0.1:5432/orvyn\nORVYN_ORIGIN=http://localhost:3000\n`,{mode:0o600,flag:'wx'});
 console.log('Created ignored .env with random local database credential');
}
