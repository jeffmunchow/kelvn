/**
 * /api/favoritos — handler unificado (substitui favoritos-get/save/list/all)
 *
 * GET  ?action=get&slug=...&email=...        → favoritos de um email (público, galeria)
 * POST {action:'save', slug, email, lista, foto_ids}  → salva favoritos (público, galeria)
 * GET  ?action=list&slug=...  + Authorization  → todas as seleções de uma galeria (fotógrafo)
 * POST {action:'all',  slugs, slugToNome}  + Authorization  → todas as seleções de todas as galerias
 */
const { createClient } = require('@supabase/supabase-js');

function jwtUserId(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.sub || null;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const action = req.method === 'GET' ? req.query.action : (req.body?.action);

  // ── GET: busca favoritos de um email (galeria pública) ──────────────────────
  if (req.method === 'GET' && action === 'get') {
    const { slug, email } = req.query;
    if (!slug || !email) return res.status(400).json({ error: 'Missing slug or email' });
    try {
      const { data, error } = await supabase
        .from('galeria_favoritos').select('lista, foto_ids')
        .eq('galeria_slug', slug).eq('email', email.toLowerCase().trim());
      if (error) throw error;
      const listas = {};
      (data || []).forEach(r => { listas[r.lista] = r.foto_ids || []; });
      return res.status(200).json({ listas });
    } catch (err) { return res.status(500).json({ error: 'Server error' }); }
  }

  // ── POST save: upsert favoritos (galeria pública) ───────────────────────────
  if (req.method === 'POST' && action === 'save') {
    const { slug, email, lista, foto_ids } = req.body || {};
    if (!slug || !email || !lista || !Array.isArray(foto_ids))
      return res.status(400).json({ error: 'Missing or invalid fields' });
    const emailNorm = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm))
      return res.status(400).json({ error: 'Invalid email' });
    try {
      const { error } = await supabase.from('galeria_favoritos').upsert(
        { galeria_slug: slug, email: emailNorm, lista, foto_ids, atualizado_em: new Date().toISOString() },
        { onConflict: 'galeria_slug,email,lista' }
      );
      if (error) throw error;
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: 'Server error' }); }
  }

  // ── GET list: seleções de uma galeria (fotógrafo autenticado) ───────────────
  if (req.method === 'GET' && action === 'list') {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: 'Missing slug' });
    const userId = jwtUserId(auth.slice(7));
    if (!userId) return res.status(401).json({ error: 'Invalid token' });
    try {
      const [galRow, favsRes] = await Promise.all([
        supabase.from('galerias').select('data').eq('user_id', userId).single(),
        supabase.from('galeria_favoritos').select('email, lista, foto_ids, atualizado_em')
          .eq('galeria_slug', slug).order('atualizado_em', { ascending: false })
      ]);
      const galerias = Array.isArray(galRow.data?.data) ? galRow.data.data : [];
      if (!galerias.find(g => g.slug === slug))
        return res.status(403).json({ error: 'Galeria não encontrada' });
      if (favsRes.error) throw favsRes.error;
      const porEmail = {};
      (favsRes.data || []).forEach(row => {
        if (!porEmail[row.email]) porEmail[row.email] = { email: row.email, listas: {}, atualizado_em: row.atualizado_em };
        porEmail[row.email].listas[row.lista] = row.foto_ids || [];
        if (row.atualizado_em > porEmail[row.email].atualizado_em) porEmail[row.email].atualizado_em = row.atualizado_em;
      });
      return res.status(200).json({ selecoes: Object.values(porEmail) });
    } catch (err) { return res.status(500).json({ error: 'Server error' }); }
  }

  // ── POST all: todas as seleções de todas as galerias (fotógrafo autenticado) ─
  if (req.method === 'POST' && action === 'all') {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const userId = jwtUserId(auth.slice(7));
    if (!userId) return res.status(401).json({ error: 'Invalid token' });
    const { slugs, slugToNome } = req.body || {};
    if (!Array.isArray(slugs) || !slugs.length) return res.status(200).json({ selecoes: [] });
    try {
      const { data: favs, error } = await supabase
        .from('galeria_favoritos').select('galeria_slug, email, foto_ids, atualizado_em')
        .in('galeria_slug', slugs).order('atualizado_em', { ascending: false });
      if (error) throw error;
      const map = {};
      (favs || []).forEach(row => {
        if (!slugToNome?.[row.galeria_slug]) return;
        const key = row.galeria_slug + '||' + row.email;
        if (!map[key]) map[key] = { galeria_slug: row.galeria_slug, galeria_nome: slugToNome[row.galeria_slug], email: row.email, total_fotos: 0, atualizado_em: row.atualizado_em };
        map[key].total_fotos += (row.foto_ids || []).length;
        if (row.atualizado_em > map[key].atualizado_em) map[key].atualizado_em = row.atualizado_em;
      });
      const selecoes = Object.values(map).sort((a, b) => new Date(b.atualizado_em) - new Date(a.atualizado_em));
      return res.status(200).json({ selecoes });
    } catch (err) { return res.status(500).json({ error: 'Server error' }); }
  }

  return res.status(400).json({ error: 'Invalid action' });
};
