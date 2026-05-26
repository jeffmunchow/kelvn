const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, senha } = req.body;
  if (!slug || !senha) return res.status(400).json({ error: 'Missing slug or senha' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // Dados ficam na tabela 'galerias', coluna 'data' (array de galerias por usuário)
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

    // Verifica senha (comparação simples — sem hash no MVP)
    if (galeria.senha !== senha) {
      return res.status(403).json({ error: 'Senha incorreta' });
    }

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
