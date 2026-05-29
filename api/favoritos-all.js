const { createClient } = require('@supabase/supabase-js');

function jwtUserId(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.sub || null;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);

  const userId = jwtUserId(token);
  if (!userId) return res.status(401).json({ error: 'Invalid token' });

  // Slugs e nomes vêm do cliente (já no cache local) — elimina a query de galerias
  const { slugs, slugToNome } = req.body || {};
  if (!Array.isArray(slugs) || !slugs.length) return res.status(200).json({ selecoes: [] });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Uma única query — filtrada pelos slugs já conhecidos
    const { data: favs, error } = await supabase
      .from('galeria_favoritos')
      .select('galeria_slug, email, foto_ids, atualizado_em')
      .in('galeria_slug', slugs)
      .order('atualizado_em', { ascending: false });

    if (error) throw error;

    const map = {};
    (favs || []).forEach(row => {
      const key = row.galeria_slug + '||' + row.email;
      if (!map[key]) {
        map[key] = {
          galeria_slug: row.galeria_slug,
          galeria_nome: (slugToNome && slugToNome[row.galeria_slug]) || row.galeria_slug,
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
