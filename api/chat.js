export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // TEST MODE: Groq only. Cerebras code/env vars are intentionally left alone for now.
  const apiKey = process.env.GROQ_API_KEY_1;
  const model = 'openai/gpt-oss-120b';

  if (!apiKey || !apiKey.trim()) {
    return res.status(500).json({
      error: 'No Groq API key is configured.',
      hint: 'Add GROQ_API_KEY_1 in Vercel Project Settings → Environment Variables, then redeploy.'
    });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
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

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify({
        model,
        messages: [system, ...messages.slice(-30)],
        temperature: 1,
        max_completion_tokens: 2048,
        top_p: 1,
        reasoning_effort: 'medium',
        stream: false
      })
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {}

    if (!response.ok) {
      const detail = data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
      return res.status(502).json({
        error: 'NOVA could not get a response from Groq.',
        details: `Groq HTTP ${response.status} — ${detail}`,
        provider: 'Groq',
        model
      });
    }

    const answer = data?.choices?.[0]?.message?.content;
    if (!answer || !String(answer).trim()) {
      return res.status(502).json({
        error: 'Groq returned no message content.',
        provider: 'Groq',
        model
      });
    }

    return res.status(200).json({
      message: String(answer),
      model,
      provider: 'Groq',
      keySlot: 1
    });
  } catch (error) {
    return res.status(502).json({
      error: 'NOVA could not reach Groq.',
      details: error?.message || 'Network error',
      provider: 'Groq',
      model
    });
  }
}
