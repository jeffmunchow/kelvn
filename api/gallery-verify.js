const { createClient } = require('@supabase/supabase-js');

// Rate limit: máximo de tentativas por IP por janela de tempo
const RATE_LIMIT_MAX    = 10;  // tentativas
const RATE_LIMIT_JANELA = 15;  // minutos

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, senha } = req.body;
  if (!slug || !senha) return res.status(400).json({ error: 'Missing slug or senha' });

  // Captura IP server-side — não confia em nada do body
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // 1) Verifica rate limit — conta tentativas desta IP nos últimos N minutos
  const janela = new Date(Date.now() - RATE_LIMIT_JANELA * 60 * 1000).toISOString();
  const { count, error: countError } = await supabase
    .from('galeria_verify_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('created_at', janela);

  if (countError) {
    console.error('gallery-verify rate limit check error:', countError);
    return res.status(500).json({ error: 'Server error' });
  }

  if (count >= RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
    });
  }

  try {
    // 2) Busca a galeria pelo slug
    const { data: rows, error } = await supabase
      .from('galerias')
      .select('data');

    if (error) throw error;

    let galeria = null;
    for (const row of rows || []) {
      const lista = Array.isArray(row.data) ? row.data : [];
      const match = lista.find(g => g.slug === slug && g.status === 'publicado');
      if (match) { galeria = match; break; }
    }

    if (!galeria) return res.status(404).json({ error: 'Galeria não encontrada' });

    // 3) Verifica senha — senhas de galeria são códigos de acesso que o fotógrafo
    //    precisa ler e compartilhar, então ficam como texto legível.
    //    A proteção contra força bruta é o rate limit acima.
    if (galeria.senha !== senha) {
      // Registra tentativa falhada
      await supabase
        .from('galeria_verify_attempts')
        .insert({ ip, slug });

      return res.status(403).json({ error: 'Senha incorreta' });
    }

    // 4) Sucesso — retorna os dados da galeria
    return res.status(200).json({
      fotos:               galeria.fotos || [],
      downloads_liberados: galeria.downloads_liberados,
      subgalerias:         galeria.subgalerias || []
    });

  } catch (err) {
    console.error('gallery-verify error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
