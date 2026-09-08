export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Cerebras production model currently used by NOVA.
  const model = 'gpt-oss-120b';

  const keys = [1, 2, 3, 4]
    .map((n) => process.env[`CEREBRAS_API_KEY_${n}`])
    .filter((key) => typeof key === 'string' && key.trim());

  if (!keys.length) {
    return res.status(500).json({ error: 'No Cerebras API keys are configured for this deployment.' });
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const workspace = typeof body.workspace === 'string' ? body.workspace : 'Core';
  const context = typeof body.context === 'string' ? body.context.slice(0, 30000) : '';

  if (!messages.length) return res.status(400).json({ error: 'Messages are required.' });

  const system = {
    role: 'system',
    content: `You are NOVA — Your AI Workspace. Answer the user's actual question directly and helpfully. You can help with school, science, math, technology, writing, coding, planning, brainstorming and everyday questions. Current workspace: ${workspace}. The user stays centered while NOVA moves the workspace around them. Do not claim to have tools, web access, file generation, execution, or integrations that are not actually connected. ${context ? `User supplied context:\n${context}` : ''}`
  };

  const failures = [];

  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i].trim();
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
      try { data = raw ? JSON.parse(raw) : {}; } catch {}

      if (response.ok) {
        const answer = data?.choices?.[0]?.message?.content;
        if (answer) return res.status(200).json({ message: answer, model, provider: 'Cerebras' });
        failures.push(`Key ${i + 1}: Cerebras returned no answer.`);
        continue;
      }

      const detail = data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
      failures.push(`Key ${i + 1}: HTTP ${response.status} — ${detail}`);
    } catch (error) {
      failures.push(`Key ${i + 1}: ${error?.message || 'network error'}`);
    }
  }

  return res.status(502).json({
    error: `Cerebras failed after trying ${keys.length} configured key(s).`,
    details: failures,
    model
  });
}
