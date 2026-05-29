const { createClient } = require('@supabase/supabase-js');

// Extrai user_id do JWT sem chamada de rede (payload é base64url)
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

  // Decodifica localmente — elimina a chamada getUser (era o gargalo principal)
  const userId = jwtUserId(token);
  if (!userId) return res.status(401).json({ error: 'Invalid token' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Busca galerias e favoritos em paralelo
    const [galRow, favsRes] = await Promise.all([
      supabase.from('galerias').select('data').eq('user_id', userId).single(),
      supabase.from('galeria_favoritos')
        .select('galeria_slug, email, foto_ids, atualizado_em')
        .order('atualizado_em', { ascending: false })
    ]);

    const galerias = Array.isArray(galRow.data?.data) ? galRow.data.data : [];
    const slugToNome = {};
    galerias.forEach(g => { if (g.slug) slugToNome[g.slug] = g.nomeCliente || g.slug; });

    if (favsRes.error) throw favsRes.error;

    // Filtra só favoritos das galerias desse fotógrafo e agrupa por slug+email
    const map = {};
    (favsRes.data || []).forEach(row => {
      if (!slugToNome[row.galeria_slug]) return; // ignora galerias de outros fotógrafos
      const key = row.galeria_slug + '||' + row.email;
      if (!map[key]) {
        map[key] = {
          galeria_slug: row.galeria_slug,
          galeria_nome: slugToNome[row.galeria_slug],
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
