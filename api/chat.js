export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Cerebras models. The first model is preferred; the second is a fallback.
  const models = ['qwen-3-32b', 'gpt-oss-120b'];

  const keys = [1, 2, 3, 4]
    .map((n) => process.env[`CEREBRAS_API_KEY_${n}`])
    .filter((key) => typeof key === 'string' && key.trim().length > 0)
    .map((key) => key.trim());

  if (!keys.length) {
    return res.status(500).json({
      error: 'No Cerebras API keys are configured in this Vercel deployment.',
      hint: 'Add CEREBRAS_API_KEY_1 (and optionally _2, _3, _4) in Vercel Project Settings → Environment Variables, then redeploy.'
    });
  }

  let body = req.body || {};
  // Vercel normally parses JSON, but safely handle a string body too.
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ error: 'Invalid JSON request body.' });
    }
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const workspace = typeof body.workspace === 'string' ? body.workspace : 'Core';
  const context = typeof body.context === 'string' ? body.context.slice(0, 30000) : '';

  if (!messages.length) {
    return res.status(400).json({ error: 'Messages are required.' });
  }

  const system = {
    role: 'system',
    content: `You are NOVA — Your AI Workspace. Answer the user's actual question directly, clearly and helpfully. You can help with school, science, math, technology, coding, writing, planning, brainstorming and everyday questions. Current workspace: ${workspace}. The user stays centered while NOVA moves the workspace around them. Never pretend a tool or integration exists when it is not connected. ${context ? `User supplied file context:\n${context}` : ''}`
  };

  const failures = [];

  // Try every configured key. A rate limit or usage-limit response moves
  // immediately to the next key. Authentication errors skip the bad key.
  for (let k = 0; k < keys.length; k++) {
    const apiKey = keys[k];

    for (const model of models) {
      try {
        const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [system, ...messages.slice(-30)],
            temperature: 0.7,
            max_tokens: 1200
          })
        });

        const raw = await response.text();
        let data = {};
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          // Keep the raw response for diagnostics below.
        }

        if (response.ok) {
          const answer = data?.choices?.[0]?.message?.content;
          if (answer && String(answer).trim()) {
            return res.status(200).json({
              message: String(answer),
              model,
              provider: 'Cerebras',
              keySlot: k + 1
            });
          }

          failures.push(`Key ${k + 1} / ${model}: Cerebras returned HTTP ${response.status} but no message content.`);
          continue;
        }

        const detail = data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
        failures.push(`Key ${k + 1} / ${model}: HTTP ${response.status} — ${detail}`);

        // Authentication/permission errors mean this key is unusable, so
        // don't waste another model request on it.
        if (response.status === 401 || response.status === 403) break;

        // 429 normally means rate/usage limiting. Move directly to the next key.
        if (response.status === 429) break;
      } catch (error) {
        failures.push(`Key ${k + 1} / ${model}: ${error?.message || 'network error'}`);
      }
    }
  }

  return res.status(502).json({
    error: 'NOVA could not get a response from the Cerebras API.',
    details: failures,
    configuredKeys: keys.length,
    modelsTried: models
  });
}
