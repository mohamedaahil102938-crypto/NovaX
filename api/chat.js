export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-2.5-flash';

  if (!apiKey || !apiKey.trim()) {
    return res.status(500).json({
      error: 'Gemini is not configured. Add GEMINI_API_KEY to the Vercel Project Environment Variables, then redeploy.'
    });
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const workspace = typeof body.workspace === 'string' ? body.workspace : 'Core';
  const context = typeof body.context === 'string' ? body.context.slice(0, 30000) : '';

  if (!messages.length) return res.status(400).json({ error: 'Messages are required.' });

  const system = `You are NOVA — Your AI Workspace. Answer the user's actual question directly, accurately, and naturally. Help with school, science, math, technology, writing, coding, planning, brainstorming, and everyday questions. Current workspace: ${workspace}. The user stays centered while NOVA moves the workspace around them. Do not claim to have tools, web access, file generation, execution, or integrations that are not actually connected. ${context ? `User supplied context:\n${context}` : ''}`;

  const contents = messages.slice(-30).map((m) => ({
    role: m?.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m?.content ?? '') }]
  })).filter((m) => m.parts[0].text.trim());

  if (!contents.length) return res.status(400).json({ error: 'No usable message content was provided.' });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey.trim())}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048
          }
        })
      }
    );

    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {}

    if (!response.ok) {
      const detail = data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
      return res.status(502).json({
        error: `Gemini returned HTTP ${response.status}: ${detail}`,
        provider: 'Gemini',
        model
      });
    }

    const answer = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || '')
      .join('')
      .trim();

    if (!answer) {
      const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'No text was returned';
      return res.status(502).json({
        error: `Gemini returned no text (${reason}).`,
        provider: 'Gemini',
        model
      });
    }

    return res.status(200).json({ message: answer, model, provider: 'Gemini' });
  } catch (error) {
    return res.status(502).json({
      error: `Could not reach Gemini: ${error?.message || 'network error'}`,
      provider: 'Gemini',
      model
    });
  }
}
