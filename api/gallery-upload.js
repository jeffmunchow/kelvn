/**
 * /api/gallery-upload — upload resiliente para galerias
 *
 * POST {action:'init',     galeria_slug, filename, content_type, tamanho_bytes, secao_id?}
 *   → cria registro em galeria_asset (upload_ok=false) + retorna presigned PUT URL para o R2
 *
 * POST {action:'complete', asset_id}
 *   → marca upload_ok=true (trigger de quota dispara automaticamente)
 *
 * GET  ?action=status&galeria_slug=...
 *   → retorna lista de asset_ids já concluídos (para retomada após interrupção)
 */
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createClient } = require('@supabase/supabase-js');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function getAuthUser(supabase, authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const { data: { user }, error } = await supabase.auth.getUser(authHeader.slice(7));
  if (error || !user) return null;
  return user;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const auth     = req.headers.authorization;
  const action   = req.method === 'GET' ? req.query.action : req.body?.action;

  // ── POST init: registra asset + retorna presigned URL ──────────────────────
  if (req.method === 'POST' && action === 'init') {
    const user = await getAuthUser(supabase, auth);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { galeria_slug, filename, content_type, tamanho_bytes, secao_id } = req.body || {};
    if (!galeria_slug || !filename || !content_type || !tamanho_bytes)
      return res.status(400).json({ error: 'Missing required fields' });

    // Valida que o slug pertence a este usuário
    const { data: galRow } = await supabase
      .from('galerias').select('data').eq('user_id', user.id).single();
    const galerias = Array.isArray(galRow?.data) ? galRow.data : [];
    if (!galerias.find(g => g.slug === galeria_slug))
      return res.status(403).json({ error: 'Galeria não encontrada' });

    // Verifica quota (bytes_cota NULL = ilimitado)
    const { data: profile } = await supabase
      .from('profiles').select('bytes_usados, bytes_cota').eq('id', user.id).single();
    if (profile?.bytes_cota !== null && profile?.bytes_cota !== undefined) {
      if ((profile.bytes_usados || 0) + Number(tamanho_bytes) > profile.bytes_cota)
        return res.status(400).json({ error: 'Cota de armazenamento atingida' });
    }

    // Sanitiza nome e monta key R2
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const r2_key   = `${user.id}/${galeria_slug}/${Date.now()}_${safeName}`;

    // Insere registro com upload_ok=false
    const { data: asset, error: insErr } = await supabase
      .from('galeria_asset').insert({
        galeria_slug,
        secao_id:      secao_id || null,
        user_id:       user.id,
        r2_key,
        nome_original: filename,
        tamanho_bytes: Number(tamanho_bytes),
        mime_type:     content_type,
        upload_ok:     false,
      }).select('id').single();
    if (insErr) {
      console.error('gallery-upload init error:', insErr);
      return res.status(500).json({ error: 'Erro ao registrar arquivo' });
    }

    // Gera presigned PUT URL (válida por 1h)
    try {
      const cmd = new PutObjectCommand({
        Bucket:      process.env.R2_BUCKET_NAME,
        Key:         r2_key,
        ContentType: content_type,
      });
      const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
      const publicUrl = `${process.env.R2_PUBLIC_URL}/${r2_key}`;
      return res.status(200).json({ asset_id: asset.id, signedUrl, r2_key, publicUrl });
    } catch (err) {
      // Desfaz o insert se não conseguiu gerar URL
      await supabase.from('galeria_asset').delete().eq('id', asset.id);
      console.error('gallery-upload presign error:', err);
      return res.status(500).json({ error: 'Erro ao gerar URL de upload' });
    }
  }

  // ── POST complete: marca upload_ok=true ─────────────────────────────────────
  if (req.method === 'POST' && action === 'complete') {
    const user = await getAuthUser(supabase, auth);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { asset_id } = req.body || {};
    if (!asset_id) return res.status(400).json({ error: 'Missing asset_id' });

    // user_id garante que só o dono pode confirmar
    const { error } = await supabase
      .from('galeria_asset')
      .update({ upload_ok: true })
      .eq('id', asset_id)
      .eq('user_id', user.id);
    if (error) {
      console.error('gallery-upload complete error:', error);
      return res.status(500).json({ error: 'Erro ao confirmar upload' });
    }
    return res.status(200).json({ success: true });
  }

  // ── GET status: IDs já concluídos nesta galeria (para retomada) ─────────────
  if (req.method === 'GET' && action === 'status') {
    const user = await getAuthUser(supabase, auth);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { galeria_slug } = req.query;
    if (!galeria_slug) return res.status(400).json({ error: 'Missing galeria_slug' });

    const { data, error } = await supabase
      .from('galeria_asset')
      .select('id, r2_key, nome_original, upload_ok')
      .eq('galeria_slug', galeria_slug)
      .eq('user_id', user.id)
      .eq('upload_ok', true);
    if (error) return res.status(500).json({ error: 'Server error' });

    return res.status(200).json({ assets: data || [] });
  }

  // ── POST presign: URL sem registro no banco (para thumbs/variantes internas) ─
  if (req.method === 'POST' && action === 'presign') {
    const user = await getAuthUser(supabase, auth);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { galeria_slug, filename, content_type } = req.body || {};
    if (!galeria_slug || !filename || !content_type)
      return res.status(400).json({ error: 'Missing required fields' });

    // Valida dono
    const { data: galRow } = await supabase
      .from('galerias').select('data').eq('user_id', user.id).single();
    const galerias = Array.isArray(galRow?.data) ? galRow.data : [];
    if (!galerias.find(g => g.slug === galeria_slug))
      return res.status(403).json({ error: 'Galeria não encontrada' });

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const r2_key   = `${user.id}/${galeria_slug}/${Date.now()}_${safeName}`;
    try {
      const cmd = new PutObjectCommand({
        Bucket:      process.env.R2_BUCKET_NAME,
        Key:         r2_key,
        ContentType: content_type,
      });
      const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
      const publicUrl = `${process.env.R2_PUBLIC_URL}/${r2_key}`;
      return res.status(200).json({ signedUrl, r2_key, publicUrl });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao gerar URL' });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
};
