export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // TEST MODE: Groq only, using exactly one key.
  // Cerebras environment variables/code are intentionally untouched.
  const apiKey = process.env.GROQ_API_KEY_1?.trim();
  const model = 'openai/gpt-oss-120b';

  if (!apiKey) {
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

  const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
  const workspace = typeof body.workspace === 'string' ? body.workspace : 'Core';
  const context = typeof body.context === 'string' ? body.context.slice(0, 30000) : '';

  if (!incomingMessages.length) {
    return res.status(400).json({ error: 'Messages are required.' });
  }

  const systemMessage = {
    role: 'system',
    content: `You are NOVA — Your AI Workspace. Answer the user's actual question directly, clearly and helpfully. You can help with school, science, math, technology, coding, writing, planning, brainstorming and everyday questions. Current workspace: ${workspace}. Never pretend a tool or integration exists when it is not connected.${context ? `\n\nUser supplied file context:\n${context}` : ''}`
  };

  // Keep only valid chat messages so malformed frontend data cannot break the request.
  const messages = incomingMessages
    .filter((message) => {
      return message &&
        typeof message === 'object' &&
        (message.role === 'user' || message.role === 'assistant' || message.role === 'system') &&
        typeof message.content === 'string';
    })
    .slice(-30);

  if (!messages.length) {
    return res.status(400).json({ error: 'No valid chat messages were provided.' });
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [systemMessage, ...messages],
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
    } catch {
      data = {};
    }

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

    if (typeof answer !== 'string' || !answer.trim()) {
      return res.status(502).json({
        error: 'Groq returned no message content.',
        details: 'The Groq request succeeded, but no assistant text was returned.',
        provider: 'Groq',
        model
      });
    }

    return res.status(200).json({
      message: answer,
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
