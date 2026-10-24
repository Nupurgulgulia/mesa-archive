// Gemini client for the app (question generation, grading, role-play buyers).
// GEMINI_API_KEY / GEMINI_MODEL in .env.local. Set GEMINI_ENDPOINT=vertex for Vertex AI express keys.
import { loadEnv } from './env';

loadEnv();

export type Turn = { role: 'user' | 'model'; text: string };

export function llmConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}
export const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.8-flash';

function url(model: string) {
  return (process.env.GEMINI_ENDPOINT || '').toLowerCase() === 'vertex'
    ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export async function generate(opts: {
  system?: string;
  prompt?: string;
  turns?: Turn[];
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  if (!process.env.GEMINI_API_KEY) throw new Error('AI is not configured (GEMINI_API_KEY missing in .env.local).');
  // Merge consecutive turns from the same side (the API expects alternating roles).
  const merged: Turn[] = [];
  for (const t of opts.turns ?? [{ role: 'user' as const, text: opts.prompt ?? '' }]) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.text += '\n\n' + t.text;
    else merged.push({ ...t });
  }
  const contents = merged.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
  const body = {
    contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxTokens ?? 8192,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    },
    ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
  };
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url(MODEL()), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY! },
        body: JSON.stringify(body),
      });
      const t = await r.text();
      if (!r.ok) {
        let msg = t;
        try { const j = JSON.parse(t); msg = `${j.error?.status} ${j.error?.message}`; } catch {}
        lastErr = new Error(`Gemini ${r.status}: ${msg.slice(0, 300)}`);
        if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 2000 * attempt)); continue; }
        throw lastErr;
      }
      const j = JSON.parse(t);
      const text: string = (j.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || '').join('');
      if (!text) throw new Error('Gemini returned no text (' + (j.candidates?.[0]?.finishReason || 'blocked') + ')');
      return text;
    } catch (e) {
      lastErr = e as Error;
      if (!/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/.test(String(lastErr.message))) throw lastErr;
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
  throw lastErr ?? new Error('Gemini request failed');
}

export async function generateJSON<T>(opts: Parameters<typeof generate>[0]): Promise<T> {
  const text = await generate({ ...opts, json: true });
  try {
    return JSON.parse(text) as T;
  } catch {
    // occasionally wrapped in a code fence
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as T;
  }
}
