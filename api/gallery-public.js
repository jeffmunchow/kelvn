const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Sem cache: garante que a galeria pública sempre reflete o design atual
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // Busca galeria pelo slug
    const { data: rows, error } = await supabase
      .from('galerias')
      .select('user_id, data');

    if (error) throw error;

    let galeria = null;
    let userId = null;
    for (const row of rows || []) {
      const lista = Array.isArray(row.data) ? row.data : [];
      const match = lista.find(g => g.slug === slug && g.status === 'publicado');
      if (match) { galeria = match; userId = row.user_id; break; }
    }

    if (!galeria) {
      return res.status(404).json({ error: 'Galeria não encontrada' });
    }

    // Busca nome do estúdio do fotógrafo
    let nomeEstudio = null;
    if (userId) {
      const { data: cfg } = await supabase
        .from('configuracoes')
        .select('sd')
        .eq('user_id', userId)
        .single();
      if (cfg && cfg.sd && cfg.sd.studio_nome) {
        nomeEstudio = cfg.sd.studio_nome;
      }
    }

    const temSenha = !!galeria.senha;

    const resposta = {
      id:                  galeria.id,
      nomeCliente:         galeria.nomeCliente,
      dataEvento:          galeria.dataEvento,
      cover_url:           galeria.cover_url,
      total_fotos:         galeria.total_fotos,
      downloads_liberados: galeria.downloads_liberados,
      subgalerias:         galeria.subgalerias || [],
      design:              galeria.design || null,
      nomeEstudio,
      temSenha,
      fotos: temSenha ? undefined : (galeria.fotos || [])
    };

    return res.status(200).json({ galeria: resposta });
  } catch (err) {
    console.error('gallery-public error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
