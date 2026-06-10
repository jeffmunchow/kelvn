/**
 * /api/album-upload — upload de fotos extras adicionadas pelo fotógrafo ao álbum
 *
 * POST { album_id, filename, content_type, tamanho_bytes }
 *   → retorna { key, url } (presigned PUT para R2)
 *
 * Key: {userId}/album-extras/{albumId}/{timestamp}_{filename}
 * Compatível com gallery-img.js (UUID path).
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(auth.slice(7));
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { album_id, filename, content_type, tamanho_bytes } = req.body || {};
  if (!album_id || !filename || !content_type || !tamanho_bytes)
    return res.status(400).json({ error: 'Missing required fields' });

  // Verifica que o álbum pertence ao usuário
  const { data: album } = await supabase
    .from('albuns').select('id').eq('id', album_id).eq('user_id', user.id).single();
  if (!album) return res.status(403).json({ error: 'Álbum não encontrado' });

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${user.id}/album-extras/${album_id}/${Date.now()}_${safeName}`;

  const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket:      process.env.R2_BUCKET,
    Key:         key,
    ContentType: content_type,
  }), { expiresIn: 300 });

  return res.status(200).json({ key, url });
};
