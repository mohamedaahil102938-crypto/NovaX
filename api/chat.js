export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKeys = [
    process.env.GROQ_API_KEY_1?.trim(),
    process.env.GROQ_API_KEY_2?.trim(),
    process.env.GROQ_API_KEY_3?.trim()
  ].filter(Boolean);

  const answerModel = 'openai/gpt-oss-120b';
  const visionModels = [
    'qwen/qwen3.8-27b',
    'qwen/qwen3.6-27b',
    'meta-llama/llama-4-scout-17b-16e-instruct'
  ];

  if (!apiKeys.length) {
    return res.status(500).json({ error: 'No Groq API keys are configured.' });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Invalid JSON request body.' }); }
  }

  const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
  const workspace = typeof body.workspace === 'string' ? body.workspace : 'Core';
  const context = typeof body.context === 'string' ? body.context.slice(0, 60000) : '';

  if (!incomingMessages.length) {
    return res.status(400).json({ error: 'Messages are required.' });
  }

  const messages = incomingMessages.filter(m => {
    if (!m || typeof m !== 'object') return false;
    if (!['user', 'assistant', 'system'].includes(m.role)) return false;
    return typeof m.content === 'string' || Array.isArray(m.content);
  }).slice(-30);

  if (!messages.length) {
    return res.status(400).json({ error: 'No valid chat messages were provided.' });
  }

  const imageParts = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part?.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:image/')) {
        imageParts.push({
          type: 'image_url',
          image_url: { url: part.image_url.url }
        });
      }
    }
  }

  const hasImage = imageParts.length > 0;
  let lastError = null;

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];

    try {
      let finalMessages;

      if (hasImage) {
        const latestUser = [...messages].reverse().find(m => m.role === 'user');
        const userText = Array.isArray(latestUser?.content)
          ? latestUser.content
              .filter(p => p?.type === 'text')
              .map(p => p.text || '')
              .join(' ')
              .trim()
          : String(latestUser?.content || '').trim();

        let visualDescription = '';
        let visionModelUsed = '';
        let visionSucceeded = false;

        // Try Qwen 3.8 first, then Qwen 3.6, then Scout as a final fallback.
        for (const visionModel of visionModels) {
          try {
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
                      text: `You are the image-understanding stage for NOVA. Analyze the attached photo itself. The user's request is: ${userText || 'Describe what is visible.'}\n\nReturn a detailed factual visual analysis for a second AI. Include every relevant visible detail: objects, people, clothing, actions, scene, colors, positions, visible text, numbers, signs, UI elements, and relationships between objects. Read visible text carefully when possible. Do not invent details. Mark anything unclear as uncertain.`
                    },
                    ...imageParts.slice(-1)
                  ]
                }],
                temperature: 0.1,
                max_completion_tokens: 3000,
                top_p: 0.95,
                reasoning_effort: 'default',
                stream: false
              })
            });

            const visionRaw = await visionResponse.text();
            let visionData = {};
            try { visionData = visionRaw ? JSON.parse(visionRaw) : {}; } catch {}

            if (visionResponse.ok) {
              const candidate = visionData?.choices?.[0]?.message?.content;
              if (typeof candidate === 'string' && candidate.trim()) {
                visualDescription = candidate.trim();
                visionModelUsed = visionModel;
                visionSucceeded = true;
                break;
              }
              lastError = `Groq vision (${visionModel}) key ${i + 1} returned no analysis.`;
            } else {
              const detail = visionData?.error?.message || visionRaw || `HTTP ${visionResponse.status}`;
              lastError = `Groq vision (${visionModel}) key ${i + 1}: HTTP ${visionResponse.status} — ${detail}`;
            }
          } catch (visionError) {
            lastError = `Groq vision (${visionModel}) key ${i + 1}: ${visionError?.message || 'Network error'}`;
          }
        }

        if (!visionSucceeded) {
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

        finalMessages = [
          {
            role: 'system',
            content: `You are NOVA — Your AI Workspace. Answer directly, clearly, and helpfully. Current workspace: ${workspace}.${context ? `\n\nDocument context:\n${context}` : ''}`
          },
          {
            role: 'system',
            content: `PHOTO UNDERSTANDING FOR THE USER'S ATTACHMENT (analyzed by ${visionModelUsed}):\n${visualDescription}\n\nThis is the visual evidence produced from the photo. Use it to answer the user's request. Do not claim the photo is missing or inaccessible. Do not say you cannot see the image. Do not invent details beyond this evidence.`
          },
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
            vision: hasImage,
            visionModel: hasImage ? visionModelUsed : null
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
