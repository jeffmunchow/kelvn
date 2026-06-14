const { createClient } = require('@supabase/supabase-js');
const { signFotos, signKey } = require('./_gallery-sign');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    // Busca a galeria via função SECURITY DEFINER com índice GIN —
    // em vez de trazer todas as linhas e filtrar em memória.
    const { data: rows, error } = await supabase
      .rpc('galeria_publica_obter', { p_slug: slug });

    if (error) throw error;

    if (!rows || !rows.length) {
      return res.status(404).json({ error: 'Galeria não encontrada' });
    }

    const g = rows[0];

    // Busca nome do estúdio do fotógrafo
    let nomeEstudio = null;
    if (g.user_id) {
      const { data: cfg } = await supabase
        .from('configuracoes')
        .select('sd')
        .eq('user_id', g.user_id)
        .single();
      if (cfg && cfg.sd && cfg.sd.studio_nome) {
        nomeEstudio = cfg.sd.studio_nome;
      }
    }

    // Flag de compartilhamento não vem da RPC — lê do JSON da galeria (PK = user_id).
    // Padrão: liberado (galerias antigas, sem o campo, mantêm o comportamento atual).
    let compartilharLiberado = true;
    if (g.user_id) {
      const { data: galRow } = await supabase
        .from('galerias')
        .select('data')
        .eq('user_id', g.user_id)
        .single();
      const lista = (galRow && Array.isArray(galRow.data)) ? galRow.data : [];
      const match = lista.find(x => x.slug === slug);
      if (match && match.compartilhar_liberado === false) compartilharLiberado = false;
    }

    // Assina a cover_url extraindo a key. Formatos possíveis:
    //   1. Proxy autenticado:  /api/gallery-img?key={keyEncodada}  (capa otimizada)
    //   2. R2 público:         pub-xxx.r2.dev/{key}
    //   3. R2 direto:          xxx.r2.cloudflarestorage.com/{bucket}/{key}
    let signedCover = null;
    if (g.cover_url) {
      let coverKey = null;
      const proxyMatch = g.cover_url.match(/[?&]key=([^&]+)/);
      if (proxyMatch) {
        coverKey = decodeURIComponent(proxyMatch[1]);
      } else {
        const m = g.cover_url.match(/r2\.dev\/([^?]+)/)
               || g.cover_url.match(/r2\.cloudflarestorage\.com\/[^/]+\/([^?]+)/);
        coverKey = m ? m[1] : null;
      }
      if (coverKey) {
        try { signedCover = await signKey(coverKey); }
        catch(e) { console.error('cover sign error:', e.message); }
      }
    }

    const resposta = {
      id:                  g.id,
      nomeCliente:         g.nome_cliente,
      dataEvento:          g.data_evento,
      cover_url:           signedCover,
      total_fotos:         g.total_fotos,
      downloads_liberados: g.downloads_lib,
      compartilhar_liberado: compartilharLiberado,
      subgalerias:         g.subgalerias || [],
      design:              g.design || null,
      nomeEstudio,
      temSenha:            g.tem_senha,
      // Galeria sem senha: assina URLs antes de retornar (bucket privado)
      fotos: g.tem_senha ? undefined : await signFotos(g.fotos || [])
    };

    return res.status(200).json({ galeria: resposta });
  } catch (err) {
    console.error('gallery-public error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
