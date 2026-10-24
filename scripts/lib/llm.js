// Gemini client (Google AI Studio API key). Used by scripts and the app for question generation
// and grading. Reads GEMINI_API_KEY / GEMINI_MODEL from .env.local. Never logs the key.
require('./env');
const { retry } = require('./retry');

// Default: Gemini API (generativelanguage.googleapis.com), which accepts both "AIza..." and "AQ." keys.
// Set GEMINI_ENDPOINT=vertex to use Vertex AI express mode instead (needs the Vertex API enabled).
const isVertex = () => (process.env.GEMINI_ENDPOINT || '').toLowerCase() === 'vertex';
const urlFor = (model) => isVertex()
  ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`
  : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

async function generate({ system, prompt, json = false, model = process.env.GEMINI_MODEL || 'gemini-3.8-flash', temperature = 0.4, maxTokens = 8192 }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing in .env.local');
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };
  return retry(async () => {
    const r = await fetch(urlFor(model), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    if (!r.ok) {
      let msg = t;
      try { const j = JSON.parse(t); msg = `${j.error?.status} ${j.error?.message}`; } catch {}
      const e = new Error(`Gemini ${r.status}: ${msg.slice(0, 300)}`);
      if (r.status === 429 || r.status >= 500) e.message += ' timeout'; // let retry() treat as transient
      throw e;
    }
    const j = JSON.parse(t);
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new Error('Gemini returned no text: ' + JSON.stringify(j.promptFeedback || j.candidates?.[0]?.finishReason || {}));
    return json ? JSON.parse(text) : text;
  }, { label: 'gemini', tries: 5 });
}

module.exports = { generate };
