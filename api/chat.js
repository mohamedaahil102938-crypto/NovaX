export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const groqKeys = [
    process.env.GROQ_API_KEY_1?.trim(),
    process.env.GROQ_API_KEY_2?.trim(),
    process.env.GROQ_API_KEY_3?.trim()
  ].filter(Boolean);

  const geminiKey = process.env.GEMINI_API_KEY_1?.trim();
  const textModel = 'openai/gpt-oss-120b';
  const geminiVisionModels = ['gemini-3.8-flash', 'gemini-3.7-flash'];
  const geminiImageModels = [
    process.env.GEMINI_IMAGE_MODEL?.trim(),
    'gemini-2.5-flash-image',
    'gemini-2.0-flash-exp-image-generation'
  ].filter(Boolean);

  if (!groqKeys.length && !geminiKey) {
    return res.status(500).json({ error: 'No AI API keys are configured.' });
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
      const url = part?.image_url?.url;
      if (
        part?.type === 'image_url' &&
        typeof url === 'string' &&
        /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(url)
      ) {
        const match = url.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.*)$/i);
        if (match) {
          imageParts.push({
            mimeType: match[1].toLowerCase(),
            base64: match[2]
          });
        }
      }
    }
  }

  const hasImage = imageParts.length > 0;
  const latestUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = Array.isArray(latestUser?.content)
    ? latestUser.content.filter(p => p?.type === 'text').map(p => p.text || '').join(' ').trim()
    : String(latestUser?.content || '').trim();

  const imageGenerationRequest = !hasImage && /\b(create|generate|make|draw|render|design|produce)\b[\s\S]{0,80}\b(image|picture|photo|art|illustration|wallpaper|poster|logo|portrait)\b/i.test(userText)
    || !hasImage && /\b(image|picture|photo|art|illustration|wallpaper|poster)\b[\s\S]{0,40}\b(generate|create|make|draw|render)\b/i.test(userText);

  // ------------------------------------------------------------
  // IMAGE GENERATION ROUTE: prompt -> Gemini image model -> NOVA chat bubble
  // Never falls back to a paid provider or to GPT-OSS for image rendering.
  // ------------------------------------------------------------
  if (imageGenerationRequest) {
    if (!geminiKey) {
      return res.status(500).json({
        error: 'NOVA image generation is not configured. Add GEMINI_API_KEY_1 to Vercel.'
      });
    }

    let lastImageError = null;

    for (const model of geminiImageModels) {
      try {
        const prompt = [
          'Create the requested image for NOVA.',
          'Generate the visual itself, not a description of it.',
          'Follow the user request closely and produce a polished result.',
          `User request: ${userText || 'Create an image.'}`,
          context ? `Relevant context:\n${context}` : ''
        ].filter(Boolean).join('\n\n');

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                role: 'user',
                parts: [{ text: prompt }]
              }],
              generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
                temperature: 1
              }
            })
          }
        );

        const raw = await response.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch {}

        if (!response.ok) {
          const detail = data?.error?.message || raw || `HTTP ${response.status}`;
          lastImageError = `Gemini image model ${model}: HTTP ${response.status} — ${detail}`;
          continue;
        }

        const parts = data?.candidates?.[0]?.content?.parts || [];
        let image = null;
        let answerText = '';

        for (const part of parts) {
          const inline = part?.inlineData || part?.inline_data;
          if (inline?.data && inline?.mimeType?.startsWith('image/')) {
            image = {
              mimeType: inline.mimeType,
              data: inline.data
            };
          }
          if (typeof part?.text === 'string' && part.text.trim()) {
            answerText += `${answerText ? '\n' : ''}${part.text.trim()}`;
          }
        }

        if (image) {
          return res.status(200).json({
            message: answerText || 'Here is your image.',
            image,
            model,
            provider: 'Google Gemini',
            vision: false,
            route: 'image-generation-gemini'
          });
        }

        lastImageError = `Gemini image model ${model} returned no image data.`;
      } catch (error) {
        lastImageError = `Gemini image model ${model}: ${error?.message || 'Network error'}`;
      }
    }

    return res.status(502).json({
      error: `NOVA could not generate the image with Gemini.\n\nREAL ERROR: ${lastImageError || 'All configured Gemini image models failed.'}`,
      details: lastImageError || 'All configured Gemini image models failed.',
      provider: 'Google Gemini',
      route: 'image-generation-gemini'
    });
  }

  // ------------------------------------------------------------
  // IMAGE ROUTE: image -> Gemini Vision -> direct Gemini answer
  // GPT-OSS is NOT called for image requests.
  // ------------------------------------------------------------
  if (hasImage) {
    if (!geminiKey) {
      return res.status(500).json({
        error: 'NOVA image vision is not configured. Add GEMINI_API_KEY_1 to Vercel.'
      });
    }

    const historyText = messages
      .filter(m => m.role !== 'system')
      .slice(-12)
      .map(m => {
        const text = Array.isArray(m.content)
          ? m.content.filter(p => p?.type === 'text').map(p => p.text || '').join(' ').trim()
          : String(m.content || '').trim();
        return text ? `${m.role === 'assistant' ? 'NOVA' : 'User'}: ${text}` : '';
      })
      .filter(Boolean)
      .join('\n');

    let lastGeminiError = null;

    for (const model of geminiVisionModels) {
      try {
        const prompt = [
          'You are NOVA — Your AI Workspace.',
          'This request contains an uploaded image.',
          'Answer the user directly from the image and their request.',
          'Carefully inspect the image. Identify visible objects, people, actions, text, colors, positions, and other relevant details.',
          'Do not invent details that are not visible.',
          userText ? `User request: ${userText}` : 'User request: Describe and explain the attached image.',
          historyText ? `Recent conversation:\n${historyText}` : '',
          context ? `Relevant document context:\n${context}` : ''
        ].filter(Boolean).join('\n\n');

        const lastImage = imageParts[imageParts.length - 1];
        const contents = [{
          role: 'user',
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: lastImage.mimeType,
                data: lastImage.base64
              }
            }
          ]
        }];

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents,
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 2048,
                topP: 0.95
              }
            })
          }
        );

        const raw = await response.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch {}

        if (!response.ok) {
          const detail = data?.error?.message || raw || `HTTP ${response.status}`;
          lastGeminiError = `Gemini ${model}: HTTP ${response.status} — ${detail}`;
          continue;
        }

        const parts = data?.candidates?.[0]?.content?.parts || [];
        const answer = parts
          .map(part => typeof part?.text === 'string' ? part.text : '')
          .filter(Boolean)
          .join(' ')
          .trim();

        if (answer) {
          return res.status(200).json({
            message: answer,
            model,
            provider: 'Google Gemini',
            vision: true,
            visionModel: model,
            route: 'image-direct-gemini'
          });
        }

        lastGeminiError = `Gemini ${model} returned no text content.`;
      } catch (error) {
        lastGeminiError = `Gemini ${model}: ${error?.message || 'Network error'}`;
      }
    }

    return res.status(502).json({
      error: `NOVA could not process the image with Gemini.\n\nREAL ERROR: ${lastGeminiError || 'All Gemini vision models failed.'}`,
      details: lastGeminiError || 'All Gemini vision models failed.',
      provider: 'Google Gemini',
      vision: true
    });
  }

  // ------------------------------------------------------------
  // TEXT ROUTE: normal messages stay on Groq GPT-OSS-120B.
  // ------------------------------------------------------------
  if (!groqKeys.length) {
    return res.status(500).json({
      error: 'NOVA text chat is not configured. Add a GROQ_API_KEY_1/2/3 to Vercel.'
    });
  }

  const finalMessages = [
    {
      role: 'system',
      content: `You are NOVA — Your AI Workspace. Answer the user's actual question directly, clearly and helpfully. Current workspace: ${workspace}.${context ? `\n\nUser supplied document/file context:\n${context}` : ''}`
    },
    ...messages
  ];

  let lastGroqError = null;

  for (let i = 0; i < groqKeys.length; i++) {
    const apiKey = groqKeys[i];

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: textModel,
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
            model: textModel,
            provider: 'Groq',
            keySlot: i + 1,
            vision: false,
            route: 'text-gpt-oss'
          });
        }

        lastGroqError = `Groq key ${i + 1} returned no message content.`;
        continue;
      }

      const detail = data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
      lastGroqError = `Groq key ${i + 1}: HTTP ${response.status} — ${detail}`;

      if (![401, 403, 429].includes(response.status)) break;
    } catch (error) {
      lastGroqError = `Groq key ${i + 1}: ${error?.message || 'Network error'}`;
    }
  }

  return res.status(502).json({
    error: `NOVA could not get a response from Groq.\n\nREAL ERROR: ${lastGroqError || 'All configured Groq keys failed.'}`,
    details: lastGroqError || 'All configured Groq keys failed.',
    provider: 'Groq',
    model: textModel,
    keysTried: groqKeys.length,
    vision: false
  });
}
