// Server-side only (imported by server components, route handlers and tsx scripts).
import { Pool, type QueryResultRow } from 'pg';
import { loadEnv } from './env';

loadEnv();

// One pool per server process (survives Next.js hot reloads in dev).
const g = globalThis as unknown as { __mesaPool?: Pool };
export const pool =
  g.__mesaPool ??
  new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30_000 });
g.__mesaPool = pool;
// Neon closes idle connections; never let that crash the server.
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

export const PROFILE = process.env.MESA_PROFILE || 'nupur';

export async function q<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await pool.query<T>(text, params)).rows;
    } catch (e) {
      const msg = String((e as Error).message);
      // Her connection drops intermittently (DNS failures lasting tens of seconds): back off 2,4,8,16,30s.
      if (attempt < 6 && /ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|Connection terminated|EAI_AGAIN|terminating connection/.test(msg)) {
        await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** (attempt - 1))));
        continue;
      }
      throw e;
    }
  }
}

export async function one<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}
