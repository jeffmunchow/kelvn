const { createClient } = require('@supabase/supabase-js');

function jwtUserId(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.sub || null;
  } catch { return null; }
}

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

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const userId = jwtUserId(token);
  if (!userId) return res.status(401).json({ error: 'Invalid token' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Busca galerias do fotógrafo e favoritos do slug em paralelo
    const [galRow, favsRes] = await Promise.all([
      supabase.from('galerias').select('data').eq('user_id', userId).single(),
      supabase.from('galeria_favoritos')
        .select('email, lista, foto_ids, atualizado_em')
        .eq('galeria_slug', slug)
        .order('atualizado_em', { ascending: false })
    ]);

    const galerias = Array.isArray(galRow.data?.data) ? galRow.data.data : [];
    if (!galerias.find(g => g.slug === slug)) {
      return res.status(403).json({ error: 'Galeria não encontrada' });
    }

    if (favsRes.error) throw favsRes.error;

    const porEmail = {};
    (favsRes.data || []).forEach(row => {
      if (!porEmail[row.email]) porEmail[row.email] = { email: row.email, listas: {}, atualizado_em: row.atualizado_em };
      porEmail[row.email].listas[row.lista] = row.foto_ids || [];
      if (row.atualizado_em > porEmail[row.email].atualizado_em) porEmail[row.email].atualizado_em = row.atualizado_em;
    });

    return res.status(200).json({ selecoes: Object.values(porEmail) });
  } catch (err) {
    console.error('favoritos-list error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
