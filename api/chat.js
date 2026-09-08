export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const keys = [1, 2, 3, 4]
    .map((n) => process.env[`CEREBRAS_API_KEY_${n}`])
    .filter(Boolean);

  if (!keys.length) {
    return res.status(500).json({ error: 'No Cerebras API keys are configured on Vercel.' });
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return res.status(400).json({ error: 'Messages are required.' });

  const model = process.env.CEREBRAS_MODEL || 'llama3.1-8b';
  const system = {
    role: 'system',
    content:
      'You are NOVA, a helpful AI workspace assistant. Be concise but useful. You understand that NOVA is an AI workspace where the user stays centered while the workspace and objects move around them. Help with learning, documents, research, writing, creation, coding, analysis, and planning. Do not claim to have performed actions that you cannot actually perform.'
  };

  let lastError = 'Cerebras request failed.';

  for (const apiKey of keys) {
    try {
      const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [system, ...messages.slice(-20)],
          temperature: 0.7,
          max_tokens: 1200
        })
      });

      const data = await response.json();
      if (response.ok) {
        return res.status(200).json({
          message: data.choices?.[0]?.message?.content || 'I did not receive a response.',
          model
        });
      }
      lastError = data?.error?.message || `Cerebras returned ${response.status}.`;
    } catch (error) {
      lastError = error?.message || lastError;
    }
  }

  return res.status(502).json({ error: lastError });
}
