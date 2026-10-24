// Retries an async operation on transient network/DB errors (DNS drops, resets, Neon idle disconnects)
// with exponential backoff: 2s, 4s, 8s, ... up to ~2 minutes in total by default.
const TRANSIENT = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|Connection terminated|terminating connection|timeout|5\d\d /i;

async function retry(fn, { tries = 7, base = 2000, label = 'operation' } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      const msg = String(e?.cause?.code || e?.code || '') + ' ' + String(e?.message || e);
      if (attempt >= tries || !TRANSIENT.test(msg)) throw e;
      const wait = base * 2 ** (attempt - 1);
      console.error(`\n(retry) ${label} failed (${msg.trim().slice(0, 80)}); retry ${attempt}/${tries - 1} in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
module.exports = { retry };
