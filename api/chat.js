export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Groq only — all AI chat/vision requests use GPT-OSS-120B.
  const apiKeys = [
    process.env.GROQ_API_KEY_1?.trim(),
    process.env.GROQ_API_KEY_2?.trim(),
    process.env.GROQ_API_KEY_3?.trim()
  ].filter(Boolean);

  const model = 'openai/gpt-oss-120b';

  if (!apiKeys.length) {
    return res.status(500).json({
      error: 'No Groq API keys are configured.',
      hint: 'Add GROQ_API_KEY_1, GROQ_API_KEY_2, and GROQ_API_KEY_3 in Vercel Environment Variables, then redeploy.'
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
  const context = typeof body.context === 'string' ? body.context.slice(0, 60000) : '';

  if (!incomingMessages.length) {
    return res.status(400).json({ error: 'Messages are required.' });
  }

  const hasImage = incomingMessages.some((message) =>
    Array.isArray(message?.content) &&
    message.content.some((part) => part?.type === 'image_url' && part?.image_url?.url)
  );

  const systemMessage = {
    role: 'system',
    content: `You are NOVA — Your AI Workspace. Answer the user's actual question directly, clearly and helpfully. You can help with school, science, math, technology, coding, writing, planning, brainstorming, documents, images and everyday questions. Current workspace: ${workspace}. Never pretend a tool or integration exists when it is not connected.

When an image is attached, use the image input to analyze what is visible and answer the user's question about it. If the user asks to transform or edit the image, describe the requested transformation accurately, but do not claim that a new image was rendered unless a real image-generation tool is connected. When documents are supplied as extracted text, use that text as the source and say when something is not present in the supplied document.${context ? `

User supplied document/file context:
${context}` : ''}`
  };

  const messages = incomingMessages
    .filter((message) => {
      if (!message || typeof message !== 'object') return false;
      if (!['user', 'assistant', 'system'].includes(message.role)) return false;
      return typeof message.content === 'string' || Array.isArray(message.content);
    })
    .slice(-30);

  if (!messages.length) {
    return res.status(400).json({ error: 'No valid chat messages were provided.' });
  }

  let lastError = null;

  // Rotate through the three Groq keys. A rate-limit/auth failure moves to the next key.
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];

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

      if (response.ok) {
        const answer = data?.choices?.[0]?.message?.content;
        if (typeof answer === 'string' && answer.trim()) {
          return res.status(200).json({
            message: answer,
            model,
            provider: 'Groq',
            keySlot: i + 1,
            vision: hasImage
          });
        }
        lastError = `Groq key ${i + 1} returned no message content.`;
        continue;
      }

      const detail = data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
      lastError = `Groq key ${i + 1}: HTTP ${response.status} — ${detail}`;

      if (response.status !== 401 && response.status !== 403 && response.status !== 429) {
        break;
      }
    } catch (error) {
      lastError = `Groq key ${i + 1}: ${error?.message || 'Network error'}`;
    }
  }

  return res.status(502).json({
    error: hasImage
      ? 'NOVA could not analyze the image with Groq GPT-OSS-120B.'
      : 'NOVA could not get a response from Groq GPT-OSS-120B.',
    details: lastError || 'All configured Groq keys failed.',
    provider: 'Groq',
    model,
    keysTried: apiKeys.length
  });
}
