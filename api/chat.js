export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKeys = [
    process.env.GROQ_API_KEY_1?.trim(),
    process.env.GROQ_API_KEY_2?.trim(),
    process.env.GROQ_API_KEY_3?.trim()
  ].filter(Boolean);

  const answerModel = 'openai/gpt-oss-120b';
  const visionModel = 'meta-llama/llama-4-scout-17b-16e-instruct';

  if (!apiKeys.length) {
    return res.status(500).json({ error: 'No Groq API keys are configured.' });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ error: 'Invalid JSON request body.' });
    }
  }

  const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
  const workspace = typeof body.workspace === 'string' ? body.workspace : 'Core';
  const context = typeof body.context === 'string' ? body.context.slice(0, 60000) : '';
  if (!incomingMessages.length) return res.status(400).json({ error: 'Messages are required.' });

  const hasImage = incomingMessages.some(m =>
    Array.isArray(m?.content) &&
    m.content.some(p => p?.type === 'image_url' && typeof p?.image_url?.url === 'string' && p.image_url.url)
  );

  const messages = incomingMessages.filter(m => {
    if (!m || typeof m !== 'object') return false;
    if (!['user', 'assistant', 'system'].includes(m.role)) return false;
    return typeof m.content === 'string' || Array.isArray(m.content);
  }).slice(-30);

  if (!messages.length) return res.status(400).json({ error: 'No valid chat messages were provided.' });

  let lastError = null;

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];

    try {
      let finalMessages;

      if (hasImage) {
        const imageParts = [];
        for (const m of messages) {
          if (!Array.isArray(m.content)) continue;
          for (const part of m.content) {
            if (part?.type === 'image_url' && typeof part?.image_url?.url === 'string' && part.image_url.url) {
              imageParts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
            }
          }
        }

        if (!imageParts.length) {
          return res.status(400).json({ error: 'The photo attachment was not received by NOVA.' });
        }

        const latestUser = [...messages].reverse().find(m => m.role === 'user');
        const userText = Array.isArray(latestUser?.content)
          ? latestUser.content
              .filter(p => p?.type === 'text')
              .map(p => p.text || '')
              .join(' ')
              .trim()
          : String(latestUser?.content || '').trim();

        const visionResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: visionModel,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Analyze the attached photo carefully for NOVA. The user's request is: ${userText || 'Describe what is visible.'}\n\nReturn ONLY a detailed factual description of everything relevant in the image: objects, people, text, scene, colors, layout, visible actions, and other useful details. Do not invent anything. This description will be given to another AI that must answer the user. If something is unreadable or uncertain, say so.`
                },
                ...imageParts
              ]
            }],
            temperature: 0.1,
            max_completion_tokens: 3000,
            stream: false
          })
        });

        const visionRaw = await visionResponse.text();
        let visionData = {};
        try { visionData = visionRaw ? JSON.parse(visionRaw) : {}; } catch {}

        if (!visionResponse.ok) {
          const detail = visionData?.error?.message || visionRaw || `HTTP ${visionResponse.status}`;
          lastError = `Groq vision key ${i + 1}: HTTP ${visionResponse.status} — ${detail}`;
          if ([401, 403, 429].includes(visionResponse.status)) continue;
          break;
        }

        const visualDescription = visionData?.choices?.[0]?.message?.content;
        if (typeof visualDescription !== 'string' || !visualDescription.trim()) {
          lastError = `Groq vision key ${i + 1} returned no visual analysis.`;
          continue;
        }

        const cleanedMessages = messages.map(m => {
          if (!Array.isArray(m.content)) return m;
          const textOnly = m.content
            .filter(p => p?.type === 'text')
            .map(p => p.text || '')
            .join(' ')
            .trim();
          return {
            role: m.role,
            content: textOnly || (m.role === 'user' ? 'The user attached a photo.' : '')
          };
        }).filter(m => m.content || m.role !== 'user');

        // Do NOT tell GPT-OSS that it cannot see images. Give it the successful
        // visual analysis as explicit evidence and require it to answer from it.
        const evidenceMessage = {
          role: 'system',
          content: `PHOTO ANALYSIS — TRUSTED INPUT FOR THIS TURN:\n${visualDescription}\n\nUse this photo analysis as the factual visual evidence for the user's request. The photo was successfully processed before this response. Answer the user's question directly from the evidence above. Never reply that you cannot see, receive, access, or analyze the photo. Never ask the user to resend the photo unless the evidence explicitly says the image content is unreadable. Do not invent details that are not supported by the photo analysis.`
        };

        finalMessages = [
          {
            role: 'system',
            content: `You are NOVA — Your AI Workspace. Answer directly, clearly, and helpfully. Current workspace: ${workspace}.${context ? `\n\nDocument context:\n${context}` : ''}`
          },
          evidenceMessage,
          ...cleanedMessages
        ];
      } else {
        finalMessages = [
          {
            role: 'system',
            content: `You are NOVA — Your AI Workspace. Answer the user's actual question directly, clearly and helpfully. Current workspace: ${workspace}.${context ? `\n\nUser supplied document/file context:\n${context}` : ''}`
          },
          ...messages
        ];
      }

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
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
          return res.status(200).json({
            message: answer,
            model: answerModel,
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
      if (![401, 403, 429].includes(response.status)) break;
    } catch (error) {
      lastError = `Groq key ${i + 1}: ${error?.message || 'Network error'}`;
    }
  }

  return res.status(502).json({
    error: hasImage
      ? 'NOVA could not process the attached photo with Groq.'
      : 'NOVA could not get a response from Groq.',
    details: lastError || 'All configured Groq keys failed.',
    provider: 'Groq',
    model: answerModel,
    keysTried: apiKeys.length,
    vision: hasImage
  });
}
