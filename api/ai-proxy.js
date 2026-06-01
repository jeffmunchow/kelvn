const { createClient } = require('@supabase/supabase-js');
const { checkRateLimit, cleanOldRecords } = require('./_rate-limit');

// Limites por usuário autenticado — impede abuso de custo na API da Anthropic.
const RATE_LIMIT_MAX = 60;   // requests
const RATE_LIMIT_WIN = 60;   // minutos (janela deslizante de 1 hora)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1) Validação de JWT — CORS não protege fora do navegador.
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  // 2) Rate limit por usuário — evita uso ilimitado da chave Anthropic.
  const rl = await checkRateLimit(supabase, user.id, 'ai-proxy', RATE_LIMIT_MAX, RATE_LIMIT_WIN);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(RATE_LIMIT_WIN * 60));
    return res.status(429).json({
      error: 'Rate limit excedido. Tente novamente em alguns minutos.',
      limit: rl.limit,
    });
  }

  // Limpeza ocasional (1 em cada 50 requests) para não acumular dados.
  if (Math.random() < 0.02) cleanOldRecords(supabase);

  try {
    const { messages, system } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: system || '',
        messages,
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });
    return res.status(200).json(data);

  } catch (error) {
    console.error('AI proxy error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};
