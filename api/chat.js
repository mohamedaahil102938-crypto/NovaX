export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKeys = [
    process.env.GROQ_API_KEY_1?.trim(),
    process.env.GROQ_API_KEY_2?.trim(),
    process.env.GROQ_API_KEY_3?.trim()
  ].filter(Boolean);

  const answerModel = 'openai/gpt-oss-120b';
  // GPT-OSS-120B is text-only. Groq's multimodal model is used only to turn pixels into a description;
  // GPT-OSS-120B remains the model that produces NOVA's final answer.
  const visionModel = 'meta-llama/llama-4-scout-17b-16e-instruct';

  if (!apiKeys.length) {
    return res.status(500).json({ error: 'No Groq API keys are configured.' });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON request body.' }); }
  }

  const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
  const workspace = typeof body.workspace === 'string' ? body.workspace : 'Core';
  const context = typeof body.context === 'string' ? body.context.slice(0, 60000) : '';
  if (!incomingMessages.length) return res.status(400).json({ error: 'Messages are required.' });

  const hasImage = incomingMessages.some(m => Array.isArray(m?.content) && m.content.some(p => p?.type === 'image_url' && p?.image_url?.url));

  const messages = incomingMessages.filter(m => {
    if (!m || typeof m !== 'object') return false;
    if (!['user','assistant','system'].includes(m.role)) return false;
    return typeof m.content === 'string' || Array.isArray(m.content);
  }).slice(-30);
  if (!messages.length) return res.status(400).json({ error: 'No valid chat messages were provided.' });

  let lastError = null;

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    try {
      let finalMessages = messages;

      if (hasImage) {
        const imageParts = [];
        for (const m of messages) {
          if (Array.isArray(m.content)) {
            for (const part of m.content) {
              if (part?.type === 'image_url' && part?.image_url?.url) imageParts.push(part);
            }
          }
        }

        if (!imageParts.length) return res.status(400).json({ error: 'The photo attachment was not received by NOVA.' });

        const latestUser = [...messages].reverse().find(m => m.role === 'user');
        const userText = Array.isArray(latestUser?.content)
          ? latestUser.content.filter(p => p?.type === 'text').map(p => p.text || '').join(' ')
          : String(latestUser?.content || '');

        const visionResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: visionModel,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: `Inspect this image carefully. The user's question/request is: ${userText || 'Describe what is visible.'}\nReturn a detailed factual visual description that another AI can use to answer the user. Do not invent details.` },
                ...imageParts
              ]
            }],
            temperature: 0.2,
            max_completion_tokens: 2048,
            stream: false
          })
        });

        const visionRaw = await visionResponse.text();
        let visionData = {};
        try { visionData = visionRaw ? JSON.parse(visionRaw) : {}; } catch {}

        if (!visionResponse.ok) {
          const detail = visionData?.error?.message || visionRaw || `HTTP ${visionResponse.status}`;
          lastError = `Groq vision key ${i + 1}: HTTP ${visionResponse.status} — ${detail}`;
          if ([401,403,429].includes(visionResponse.status)) continue;
          break;
        }

        const visualDescription = visionData?.choices?.[0]?.message?.content;
        if (typeof visualDescription !== 'string' || !visualDescription.trim()) {
          lastError = `Groq vision key ${i + 1} returned no visual description.`;
          continue;
        }

        const cleaned = messages.map(m => {
          if (m.role !== 'user' || !Array.isArray(m.content)) return m;
          return { ...m, content: m.content.filter(p => p?.type === 'text').map(p => p.text || '').join(' ').trim() || 'The user attached an image.' };
        });

        finalMessages = [
          { role: 'system', content: `You are NOVA — Your AI Workspace. Answer directly and helpfully. The final answer must be produced by GPT-OSS-120B. A separate Groq vision step inspected the user's image because GPT-OSS-120B itself cannot accept image pixels. Treat the visual description below as the image evidence. Do not say you directly saw pixels. If the user asks to edit/transform the image, explain the requested edit but do not claim a rendered image exists unless a real image generator is connected. Current workspace: ${workspace}.${context ? `\n\nDocument context:\n${context}` : ''}\n\nVISUAL EVIDENCE FROM THE ATTACHED PHOTO:\n${visualDescription}` },
          ...cleaned
        ];
      } else {
        finalMessages = [
          { role: 'system', content: `You are NOVA — Your AI Workspace. Answer the user's actual question directly, clearly and helpfully. Current workspace: ${workspace}.${context ? `\n\nUser supplied document/file context:\n${context}` : ''}` },
          ...messages
        ];
      }

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: answerModel,
          messages: finalMessages,
          temperature: 1,
          max_completion_tokens: 2048,
          top_p: 1,
          reasoning_effort: 'medium',
          stream: false
        })
      });

      const raw = await response.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch {}

      if (response.ok) {
        const answer = data?.choices?.[0]?.message?.content;
        if (typeof answer === 'string' && answer.trim()) {
          return res.status(200).json({ message: answer, model: answerModel, provider: 'Groq', keySlot: i + 1, vision: hasImage });
        }
        lastError = `Groq key ${i + 1} returned no message content.`;
        continue;
      }

      const detail = data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
      lastError = `Groq key ${i + 1}: HTTP ${response.status} — ${detail}`;
      if (![401,403,429].includes(response.status)) break;
    } catch (error) {
      lastError = `Groq key ${i + 1}: ${error?.message || 'Network error'}`;
    }
  }

  return res.status(502).json({
    error: hasImage ? 'NOVA could not process the attached photo with Groq.' : 'NOVA could not get a response from Groq.',
    details: lastError || 'All configured Groq keys failed.',
    provider: 'Groq', model: answerModel, keysTried: apiKeys.length, vision: hasImage
  });
}