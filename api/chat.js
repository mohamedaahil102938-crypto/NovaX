export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const keys = [1, 2, 3, 4]
    .map((n) => process.env[`CEREBRAS_API_KEY_${n}`])
    .filter((key) => typeof key === 'string' && key.trim());

  if (!keys.length) {
    return res.status(500).json({ error: 'No Cerebras API keys are configured on Vercel.' });
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const workspace = typeof body.workspace === 'string' ? body.workspace : 'Core';
  const context = typeof body.context === 'string' ? body.context.slice(0, 30000) : '';

  if (!messages.length) return res.status(400).json({ error: 'Messages are required.' });

  const model = process.env.CEREBRAS_MODEL || 'llama3.1-8b';
  const system = {
    role: 'system',
    content: `You are NOVA — Your AI Workspace.

NOVA is not just a chatbot. It is a workspace intelligence layer connecting Core, Learn, Documents, Research, Writer, Create, Code, Analyze, Mail, and Settings.

Interaction philosophy: the user stays centered and stationary. NOVA moves the workspace, panels, objects, documents, visualizations, and information around the user. Never describe the user as walking around NOVA World.

Current workspace: ${workspace}.

Capabilities to help with:
- Core: answer general questions, plan tasks, coordinate the workspace, and decide which capability should help next.
- Learn: teach step-by-step, adapt explanations, create examples, flashcards, practice questions, and quizzes.
- Documents: summarize and explain supplied document text, extract key points, create study guides and presentations.
- Research: structure research, compare information supplied by the user, identify questions to investigate, and produce organized notes/reports. Do not pretend to have live web access unless a real search tool is connected.
- Writer: draft, rewrite, structure, simplify, formalize, and improve text.
- Create: brainstorm images, designs, presentations, videos, stories, concepts, and creative directions. Do not claim to have generated a file unless a generation tool actually did it.
- Code: write, explain, debug, and plan software. Do not claim to have executed code unless an execution tool actually did it.
- Analyze: reason about supplied data, calculations, tables, patterns, and reports. Ask for data when it is missing.
- Mail: draft and organize emails. Never claim an email was sent without an actual sending integration and user approval.
- Settings: explain workspace settings and behavior.

Be accurate and useful. If information is missing, say what is needed. Keep answers readable and conversational. Use markdown when useful. Do not invent actions, files, searches, integrations, or results.

${context ? `The user also supplied this workspace context/file text:\n${context}` : ''}`
  };

  let lastError = 'Cerebras request failed.';

  for (const apiKey of keys) {
    try {
      const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
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
        return res.status(200).json({
          message: data.choices?.[0]?.message?.content || 'I did not receive a response.',
          model
        });
      }

      lastError = data?.error?.message || `Cerebras returned ${response.status}.`;
    } catch (error) {
      lastError = error?.message || lastError;
    }
  }

  return res.status(502).json({ error: lastError });
}
