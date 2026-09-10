export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const groqKeys = [process.env.GROQ_API_KEY_1?.trim(), process.env.GROQ_API_KEY_2?.trim(), process.env.GROQ_API_KEY_3?.trim()].filter(Boolean);
  const geminiKey = process.env.GEMINI_API_KEY_1?.trim();
  const hfToken = process.env.HF_TOKEN?.trim();
  const textModel = 'openai/gpt-oss-120b';
  const geminiVisionModels = ['gemini-3.8-flash', 'gemini-3.7-flash'];

  const HF_ROUTER = 'https://router.huggingface.co';
  const HF_FAL = `${HF_ROUTER}/fal-ai`;
  const HF_INFERENCE = `${HF_ROUTER}/hf-inference/models`;
  const TEXT_IMAGE_MODEL = 'Tongyi-MAI/Z-Image-Turbo';
  const QUALITY_IMAGE_MODEL = 'krea/Krea-2-Turbo';
  const FLUX_EDIT_PATH = 'fal-ai/flux-2/edit';
  const QWEN_EDIT_PATH = 'fal-ai/qwen-image-edit-2509';

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function readError(response, raw) {
    let detail = '';
    try {
      detail = new TextDecoder().decode(raw);
      const parsed = detail ? JSON.parse(detail) : {};
      detail = parsed?.error?.message || parsed?.error || parsed?.message || detail;
    } catch {}
    return detail || `HTTP ${response.status}`;
  }

  async function imageUrlToPayload(url) {
    const response = await fetch(url);
    const raw = await response.arrayBuffer();
    if (!response.ok) throw new Error(`Generated image download failed: HTTP ${response.status}`);
    const mimeType = (response.headers.get('content-type') || 'image/png').split(';')[0].trim();
    if (!mimeType.toLowerCase().startsWith('image/')) throw new Error(`Generated image URL returned ${mimeType}`);
    return { mimeType, data: Buffer.from(raw).toString('base64') };
  }

  async function hfInferenceImage(model, prompt) {
    const url = `${HF_INFERENCE}/${model}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hfToken}`, 'Content-Type': 'application/json', Accept: 'image/png, image/jpeg, application/json' },
      body: JSON.stringify({ inputs: prompt })
    });
    const raw = await response.arrayBuffer();
    if (!response.ok) throw new Error(`Hugging Face hf-inference: HTTP ${response.status} — ${await readError(response, raw)}`);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType.startsWith('image/')) {
      return { mimeType: contentType, data: Buffer.from(raw).toString('base64') };
    }
    let data = {};
    try { data = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new Error(`Hugging Face returned ${contentType || 'non-image data'} instead of an image.`); }
    if (data?.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
    const imageUrl = data?.images?.[0]?.url || data?.image?.url;
    if (imageUrl) return await imageUrlToPayload(imageUrl);
    throw new Error(`Hugging Face completed without an image: ${JSON.stringify(data).slice(0, 1200)}`);
  }

  async function falQueueImage(path, body) {
    const submitUrl = `${HF_FAL}/${path}?_subdomain=queue`;
    const headers = { Authorization: `Bearer ${hfToken}`, 'Content-Type': 'application/json' };
    const submit = await fetch(submitUrl, { method: 'POST', headers, body: JSON.stringify(body) });
    const raw = await submit.arrayBuffer();
    if (!submit.ok) throw new Error(`Fal.ai queue submit: HTTP ${submit.status} — ${await readError(submit, raw)}`);

    let queued = {};
    try { queued = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new Error('Fal.ai queue returned invalid JSON.'); }
    if (queued?.images?.[0]?.url) return await imageUrlToPayload(queued.images[0].url);
    if (!queued?.request_id || !queued?.response_url) throw new Error(`Fal.ai queue returned no request_id/response_url: ${JSON.stringify(queued).slice(0, 1200)}`);

    const responseUrl = new URL(queued.response_url);
    const modelPath = responseUrl.pathname;
    const query = '?_subdomain=queue';
    const baseUrl = `${HF_ROUTER}/fal-ai`;
    const statusUrl = `${baseUrl}${modelPath}/status${query}`;
    const resultUrl = `${baseUrl}${modelPath}${query}`;

    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const statusResponse = await fetch(statusUrl, { headers });
      const statusRaw = await statusResponse.arrayBuffer();
      if (!statusResponse.ok) throw new Error(`Fal.ai queue status: HTTP ${statusResponse.status} — ${await readError(statusResponse, statusRaw)}`);
      let statusData = {};
      try { statusData = JSON.parse(new TextDecoder().decode(statusRaw)); } catch { throw new Error('Fal.ai status returned invalid JSON.'); }
      const status = statusData?.status;
      if (status === 'FAILED') throw new Error(`Fal.ai job failed: ${statusData?.error || JSON.stringify(statusData).slice(0, 1200)}`);
      if (status !== 'COMPLETED') continue;

      const resultResponse = await fetch(resultUrl, { headers });
      const resultRaw = await resultResponse.arrayBuffer();
      if (!resultResponse.ok) throw new Error(`Fal.ai queue result: HTTP ${resultResponse.status} — ${await readError(resultResponse, resultRaw)}`);
      let result = {};
      try { result = JSON.parse(new TextDecoder().decode(resultRaw)); } catch { throw new Error('Fal.ai result returned invalid JSON.'); }
      const imageUrl = result?.images?.[0]?.url;
      if (!imageUrl) throw new Error(`Fal.ai completed without an image URL: ${JSON.stringify(result).slice(0, 1200)}`);
      return await imageUrlToPayload(imageUrl);
    }
    throw new Error('Fal.ai image job timed out after 20 seconds.');
  }

  if (!groqKeys.length && !geminiKey && !hfToken) return res.status(500).json({ error: 'No AI API keys are configured.' });

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON request body.' }); }
  }

  const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
  const workspace = typeof body.workspace === 'string' ? body.workspace : 'Core';
  const context = typeof body.context === 'string' ? body.context.slice(0, 60000) : '';
  const generationMode = body.generationMode === 'quality' ? 'quality' : 'fast';
  if (!incomingMessages.length) return res.status(400).json({ error: 'Messages are required.' });

  const messages = incomingMessages.filter(m => m && typeof m === 'object' && ['user', 'assistant', 'system'].includes(m.role) && (typeof m.content === 'string' || Array.isArray(m.content))).slice(-30);
  if (!messages.length) return res.status(400).json({ error: 'No valid chat messages were provided.' });

  const imageParts = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const url = part?.image_url?.url;
      if (part?.type === 'image_url' && typeof url === 'string' && /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(url)) {
        const match = url.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.*)$/i);
        if (match) imageParts.push({ mimeType: match[1].toLowerCase(), base64: match[2] });
      }
    }
  }

  const hasImage = imageParts.length > 0;
  const latestUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = Array.isArray(latestUser?.content)
    ? latestUser.content.filter(p => p?.type === 'text').map(p => p.text || '').join(' ').trim()
    : String(latestUser?.content || '').trim();

  const imageGenerationRequest = !hasImage && (/(create|generate|make|draw|render|design|produce)[\s\S]{0,80}(image|picture|photo|art|illustration|wallpaper|poster|logo|portrait)/i.test(userText) || /(image|picture|photo|art|illustration|wallpaper|poster)[\s\S]{0,40}(generate|create|make|draw|render)/i.test(userText));
  const imageToImageRequest = hasImage && /(edit|change|modify|transform|restyle|redesign|remove|replace|add|turn|convert|make|generate|create|draw|render)/i.test(userText) && /(image|photo|picture|it|this|that|background|person|object|style|color|clothes|face)/i.test(userText);

  // IMAGE GENERATION: user-selected Fast or Quality.
  // Fast uses the existing working Z-Image-Turbo/fal-ai route.
  // Quality uses ONLY Hugging Face's hf-inference route with Krea-2-Turbo.
  // There is deliberately NO paid fallback for Quality.
  if (imageGenerationRequest) {
    if (!hfToken) return res.status(500).json({ error: 'NOVA image generation is not configured. Add HF_TOKEN to Vercel.' });
    const prompt = ['Create the requested image.', 'Generate the visual itself, not a description of it.', 'Follow the user request closely and produce a polished result.', generationMode === 'quality' ? 'Prioritize detail, composition, lighting, realism, and prompt fidelity over speed.' : 'Prioritize speed while keeping the image clean and polished.', `User request: ${userText || 'Create an image.'}`, context ? `Relevant context:\n${context}` : ''].filter(Boolean).join('\n\n');

    if (generationMode === 'quality') {
      try {
        const image = await hfInferenceImage(QUALITY_IMAGE_MODEL, prompt);
        return res.status(200).json({ message: 'Here is your high-quality image.', image, model: QUALITY_IMAGE_MODEL, provider: 'Hugging Face / hf-inference', vision: false, route: 'text-to-image-quality-hf-inference', generationMode: 'quality' });
      } catch (error) {
        return res.status(502).json({ error: `NOVA could not generate the high-quality image with Hugging Face. No fallback was used.\n\nREAL ERROR: ${error?.message || 'Network error'}`, details: error?.message || 'Network error', provider: 'Hugging Face / hf-inference', model: QUALITY_IMAGE_MODEL, route: 'text-to-image-quality-hf-inference', generationMode: 'quality', paidFallback: false });
      }
    }

    try {
      const response = await fetch(`${HF_FAL}/fal-ai/z-image/turbo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, image_size: { width: 1024, height: 1024 }, num_inference_steps: 8, enable_safety_checker: true, output_format: 'png' })
      });
      const raw = await response.arrayBuffer();
      if (!response.ok) return res.status(502).json({ error: `NOVA could not generate the image with Hugging Face.\n\nREAL ERROR: Z-Image-Turbo via fal-ai: HTTP ${response.status} — ${await readError(response, raw)}`, provider: 'Hugging Face', model: TEXT_IMAGE_MODEL, route: 'text-to-image-fast-fal-ai', generationMode: 'fast' });
      let data = {};
      try { data = JSON.parse(new TextDecoder().decode(raw)); } catch { return res.status(502).json({ error: 'Hugging Face fal-ai returned invalid JSON for Z-Image-Turbo.', provider: 'Hugging Face', model: TEXT_IMAGE_MODEL }); }
      const imageUrl = data?.images?.[0]?.url;
      if (!imageUrl) return res.status(502).json({ error: `Z-Image-Turbo completed without an image URL: ${JSON.stringify(data).slice(0, 1200)}`, provider: 'Hugging Face', model: TEXT_IMAGE_MODEL });
      return res.status(200).json({ message: 'Here is your fast image.', image: await imageUrlToPayload(imageUrl), model: TEXT_IMAGE_MODEL, provider: 'Hugging Face / fal-ai', vision: false, route: 'text-to-image-fast-fal-ai', generationMode: 'fast' });
    } catch (error) {
      return res.status(502).json({ error: `NOVA could not generate the image with Hugging Face.\n\nREAL ERROR: ${error?.message || 'Network error'}`, details: error?.message || 'Network error', provider: 'Hugging Face / fal-ai', model: TEXT_IMAGE_MODEL, route: 'text-to-image-fast-fal-ai', generationMode: 'fast' });
    }
  }

  // IMAGE-TO-IMAGE: FLUX.2-dev first, Qwen Image Edit fallback. Both use current fal-ai routing.
  if (imageToImageRequest) {
    if (!hfToken) return res.status(500).json({ error: 'NOVA image-to-image is not configured. Add HF_TOKEN to Vercel.' });
    const lastImage = imageParts[imageParts.length - 1];
    const imageDataUrl = `data:${lastImage.mimeType};base64,${lastImage.base64}`;
    const editPrompt = userText || 'Edit this image as requested.';
    const models = [
      { name: 'black-forest-labs/FLUX.2-dev', path: FLUX_EDIT_PATH },
      { name: 'Qwen/Qwen-Image-Edit-2509', path: QWEN_EDIT_PATH }
    ];
    const failures = [];
    for (const model of models) {
      try {
        const image = await falQueueImage(model.path, { prompt: editPrompt, image_urls: [imageDataUrl], num_images: 1, output_format: 'png' });
        return res.status(200).json({ message: 'Here is the edited image.', image, model: model.name, provider: 'Hugging Face / fal-ai', vision: false, route: 'image-to-image-fal-ai' });
      } catch (error) {
        failures.push(`${model.name}: ${error?.message || 'Inference failed.'}`);
      }
    }
    return res.status(502).json({ error: `NOVA could not edit the image with the current Hugging Face Inference Providers.\n\nTRIED ${models.length} MODELS:\n${failures.join('\n')}`, details: failures.join('\n'), provider: 'Hugging Face / fal-ai', modelsTried: models.map(m => m.name), route: 'image-to-image-fal-ai' });
  }

  // IMAGE VISION: Gemini only, direct Gemini answer. GPT-OSS is bypassed.
  if (hasImage) {
    if (!geminiKey) return res.status(500).json({ error: 'NOVA image vision is not configured. Add GEMINI_API_KEY_1 to Vercel.' });
    const historyText = messages.filter(m => m.role !== 'system').slice(-12).map(m => {
      const text = Array.isArray(m.content) ? m.content.filter(p => p?.type === 'text').map(p => p.text || '').join(' ').trim() : String(m.content || '').trim();
      return text ? `${m.role === 'assistant' ? 'NOVA' : 'User'}: ${text}` : '';
    }).filter(Boolean).join('\n');
    let lastGeminiError = null;
    for (const model of geminiVisionModels) {
      try {
        const prompt = ['You are NOVA — Your AI Workspace.', 'This request contains an uploaded image.', 'Answer the user directly from the image and their request.', 'Carefully inspect the image. Identify visible objects, people, actions, text, colors, positions, and other relevant details.', 'Do not invent details that are not visible.', userText ? `User request: ${userText}` : 'User request: Describe and explain the attached image.', historyText ? `Recent conversation:\n${historyText}` : '', context ? `Relevant document context:\n${context}` : ''].filter(Boolean).join('\n\n');
        const lastImage = imageParts[imageParts.length - 1];
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: lastImage.mimeType, data: lastImage.base64 } }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 2048, topP: 0.95 } }) });
        const raw = await response.text(); let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch {}
        if (!response.ok) { const detail = data?.error?.message || raw || `HTTP ${response.status}`; lastGeminiError = `Gemini ${model}: HTTP ${response.status} — ${detail}`; continue; }
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const answer = parts.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join(' ').trim();
        if (answer) return res.status(200).json({ message: answer, model, provider: 'Google Gemini', vision: true, visionModel: model, route: 'image-direct-gemini' });
        lastGeminiError = `Gemini ${model} returned no text content.`;
      } catch (error) { lastGeminiError = `Gemini ${model}: ${error?.message || 'Network error'}`; }
    }
    return res.status(502).json({ error: `NOVA could not process the image with Gemini.\n\nREAL ERROR: ${lastGeminiError || 'All Gemini vision models failed.'}`, details: lastGeminiError || 'All Gemini vision models failed.', provider: 'Google Gemini', vision: true });
  }

  // TEXT: Groq GPT-OSS-120B only, with the existing three-key rotation.
  if (!groqKeys.length) return res.status(500).json({ error: 'NOVA text chat is not configured. Add a GROQ_API_KEY_1/2/3 to Vercel.' });
  const finalMessages = [{ role: 'system', content: `You are NOVA — Your AI Workspace. Answer the user's actual question directly, clearly and helpfully. Current workspace: ${workspace}.${context ? `\n\nUser supplied document/file context:\n${context}` : ''}` }, ...messages];
  let lastGroqError = null;
  for (let i = 0; i < groqKeys.length; i++) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKeys[i]}` }, body: JSON.stringify({ model: textModel, messages: finalMessages, temperature: 1, max_completion_tokens: 2048, top_p: 1, reasoning_effort: 'medium', stream: false }) });
      const raw = await response.text(); let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch {}
      if (response.ok) {
        const answer = data?.choices?.[0]?.message?.content;
        if (typeof answer === 'string' && answer.trim()) return res.status(200).json({ message: answer, model: textModel, provider: 'Groq', keySlot: i + 1, vision: false, route: 'text-gpt-oss' });
        lastGroqError = `Groq key ${i + 1} returned no message content.`; continue;
      }
      const detail = data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
      lastGroqError = `Groq key ${i + 1}: HTTP ${response.status} — ${detail}`;
      if (![401, 403, 429].includes(response.status)) break;
    } catch (error) { lastGroqError = `Groq key ${i + 1}: ${error?.message || 'Network error'}`; }
  }
  return res.status(502).json({ error: `NOVA could not get a response from Groq.\n\nREAL ERROR: ${lastGroqError || 'All configured Groq keys failed.'}`, details: lastGroqError || 'All configured Groq keys failed.', provider: 'Groq', model: textModel, keysTried: groqKeys.length, vision: false });
}
