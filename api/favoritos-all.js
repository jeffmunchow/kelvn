const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return res.status(401).json({ error: 'Invalid token' });
  const userId = userData.user.id;

  try {
    // Busca todas as galerias do fotógrafo para mapear slug → nome
    const { data: row } = await supabase
      .from('galerias')
      .select('data')
      .eq('user_id', userId)
      .single();

    const galerias = Array.isArray(row?.data) ? row.data : [];
    const slugToNome = {};
    galerias.forEach(g => { if (g.slug) slugToNome[g.slug] = g.nomeCliente || g.slug; });
    const slugsDoFotografo = Object.keys(slugToNome);

    if (!slugsDoFotografo.length) return res.status(200).json({ selecoes: [] });

    // Busca todos os favoritos dessas galerias
    const { data: favs, error } = await supabase
      .from('galeria_favoritos')
      .select('galeria_slug, email, lista, foto_ids, atualizado_em')
      .in('galeria_slug', slugsDoFotografo)
      .order('atualizado_em', { ascending: false });

    if (error) throw error;

    // Agrupa por (slug + email), mantém ordem por atualizado_em
    const map = {};
    (favs || []).forEach(row => {
      const key = row.galeria_slug + '||' + row.email;
      if (!map[key]) {
        map[key] = {
          galeria_slug: row.galeria_slug,
          galeria_nome: slugToNome[row.galeria_slug] || row.galeria_slug,
          email: row.email,
          total_fotos: 0,
          atualizado_em: row.atualizado_em
        };
      }
      map[key].total_fotos += (row.foto_ids || []).length;
      if (row.atualizado_em > map[key].atualizado_em) map[key].atualizado_em = row.atualizado_em;
    });

    const selecoes = Object.values(map).sort((a, b) =>
      new Date(b.atualizado_em) - new Date(a.atualizado_em)
    );

    return res.status(200).json({ selecoes });
  } catch (err) {
    console.error('favoritos-all error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
