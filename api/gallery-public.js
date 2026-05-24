const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // Busca todas as galerias e procura pelo slug
    // (eficiente para número pequeno de usuários no MVP)
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

    if (!galeria) {
      return res.status(404).json({ error: 'Galeria não encontrada' });
    }

    // Verifica se tem senha — nunca expõe o hash da senha
    const temSenha = !!galeria.senha;

    // Se não tem senha, retorna tudo incluindo fotos
    // Se tem senha, retorna apenas metadados (fotos vêm via gallery-verify)
    const resposta = {
      id:                  galeria.id,
      nomeCliente:         galeria.nomeCliente,
      dataEvento:          galeria.dataEvento,
      cover_url:           galeria.cover_url,
      total_fotos:         galeria.total_fotos,
      downloads_liberados: galeria.downloads_liberados,
      subgalerias:         galeria.subgalerias || [],
      temSenha,
      fotos: temSenha ? undefined : (galeria.fotos || [])
    };

    return res.status(200).json({ galeria: resposta });
  } catch (err) {
    console.error('gallery-public error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
