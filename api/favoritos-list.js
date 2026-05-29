const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.slice(7);

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Verifica que o usuário autenticado é dono da galeria com esse slug
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return res.status(401).json({ error: 'Invalid token' });
  const userId = userData.user.id;

  try {
    // Confirma que o slug pertence a esse fotógrafo
    const { data: rows } = await supabase
      .from('dados_usuario')
      .select('valor')
      .eq('user_id', userId)
      .eq('modulo', 'galerias')
      .eq('chave', 'data')
      .single();

    const galerias = Array.isArray(rows?.valor) ? rows.valor : [];
    const galeria = galerias.find(g => g.slug === slug);
    if (!galeria) return res.status(403).json({ error: 'Galeria não encontrada' });

    // Busca todos os favoritos desse slug
    const { data: favs, error } = await supabase
      .from('galeria_favoritos')
      .select('email, lista, foto_ids, atualizado_em')
      .eq('galeria_slug', slug)
      .order('atualizado_em', { ascending: false });

    if (error) throw error;

    // Agrupa por email
    const porEmail = {};
    (favs || []).forEach(row => {
      if (!porEmail[row.email]) porEmail[row.email] = { email: row.email, listas: {}, atualizado_em: row.atualizado_em };
      porEmail[row.email].listas[row.lista] = row.foto_ids || [];
      if (row.atualizado_em > porEmail[row.email].atualizado_em) {
        porEmail[row.email].atualizado_em = row.atualizado_em;
      }
    });

    return res.status(200).json({ selecoes: Object.values(porEmail) });
  } catch (err) {
    console.error('favoritos-list error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
