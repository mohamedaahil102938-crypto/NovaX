export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Current Cerebras hosted model used by NOVA.
  // llama3.1-8b was retired; use gpt-oss-120b instead.
  const model = 'gpt-oss-120b';

  const keys = [1, 2, 3, 4]
    .map((n) => process.env[`CEREBRAS_API_KEY_${n}`])
    .filter((key) => typeof key === 'string' && key.trim());

  if (!keys.length) {
    return res.status(500).json({
      error: 'No Cerebras API keys are configured for this deployment.'
    });
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const workspace = typeof body.workspace === 'string' ? body.workspace : 'Core';
  const context = typeof body.context === 'string' ? body.context.slice(0, 30000) : '';

  if (!messages.length) return res.status(400).json({ error: 'Messages are required.' });

  const system = {
    role: 'system',
    content: `You are NOVA — Your AI Workspace.

NOVA is an intelligent workspace, not just a chatbot. It connects Core, Learn, Documents, Research, Writer, Create, Code, Analyze, Mail, and Settings.

Interaction philosophy: the user stays centered and stationary. NOVA moves the workspace, panels, objects, documents, visualizations, and information around the user. Never describe the user as walking around NOVA World.

Current workspace: ${workspace}.

Your job is to directly answer the user's question whenever you have enough information. Be capable across school subjects, science, math, technology, writing, coding, planning, explanations, brainstorming, and everyday questions.

Workspace capabilities:
- Core: answer general questions, plan tasks, coordinate the workspace, and decide what capability should help next.
- Learn: teach step-by-step, adapt explanations, create examples, flashcards, practice questions, and quizzes.
- Documents: summarize and explain supplied document text, extract key points, create study guides and presentations.
- Research: structure research, compare information supplied by the user, identify questions to investigate, and produce organized notes/reports. Do not pretend to have live web access unless a real search tool is connected.
- Writer: draft, rewrite, structure, simplify, formalize, and improve text.
- Create: brainstorm images, designs, presentations, videos, stories, concepts, and creative directions. Do not claim a file was generated unless a real generation tool created it.
- Code: write, explain, debug, and plan software. Do not claim code was executed unless a real execution tool executed it.
- Analyze: reason about supplied data, calculations, tables, patterns, and reports. Ask for data when it is missing.
- Mail: draft and organize emails. Never claim an email was sent without a real sending integration and user approval.
- Settings: explain workspace settings and behavior.

Answer the actual question first. Do not tell the user to check environment variables or models unless the server itself reports a configuration problem. If something is unavailable, clearly explain what is missing.

Be accurate, helpful, conversational, and reasonably concise. Use markdown when useful. Do not invent actions, files, searches, integrations, or results.

${context ? `The user also supplied this workspace context/file text:\n${context}` : ''}`
  };

  let lastError = 'Cerebras request failed.';

  for (const apiKey of keys) {
    try {
      const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey.trim()}`
        },
        body: JSON.stringify({
          model,
          messages: [system, ...messages.slice(-30)],
          temperature: 0.7,
          max_tokens: 1800
        })
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        const answer = data.choices?.[0]?.message?.content;
        if (answer) {
          return res.status(200).json({
            message: answer,
            model,
            provider: 'Cerebras'
          });
        }
        lastError = 'Cerebras returned an empty answer.';
        continue;
      }

      lastError = data?.error?.message || `Cerebras returned HTTP ${response.status}.`;
    } catch (error) {
      lastError = error?.message || lastError;
    }
  }

  return res.status(502).json({
    error: `Cerebras could not answer after trying the configured keys: ${lastError}`,
    model
  });
}
