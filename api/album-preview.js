/**
 * /api/album-preview
 *
 * POST ?action=upload  — recebe JPEG base64 de um spread, guarda no R2,
 *                        atualiza album_spreads.preview_key (autenticado)
 */

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
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
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.query;
  if (action !== 'upload') return res.status(404).json({ error: 'Not found' });

  // Auth
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const jwt = auth.slice(7);

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { album_id, spread_id, data_url } = req.body || {};
  if (!album_id || !spread_id || !data_url) {
    return res.status(400).json({ error: 'album_id, spread_id e data_url são obrigatórios' });
  }

  // Verifica propriedade do álbum
  const { data: album, error: aErr } = await sb
    .from('albuns').select('id').eq('id', album_id).eq('user_id', user.id).maybeSingle();
  if (aErr || !album) return res.status(404).json({ error: 'Álbum não encontrado' });

  // Converte data URL para buffer
  const base64 = data_url.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');

  // Chave no R2: album_id/previews/spread_id.jpg
  const key = `${album_id}/previews/${spread_id}.jpg`;

  try {
    await s3.send(new PutObjectCommand({
      Bucket:       process.env.R2_BUCKET_NAME,
      Key:          key,
      Body:         buffer,
      ContentType:  'image/jpeg',
    }));
  } catch (e) {
    console.error('album-preview upload R2 error:', e);
    return res.status(500).json({ error: 'Erro ao salvar preview' });
  }

  // Salva a chave no spread
  const { error: uErr } = await sb
    .from('album_spreads').update({ preview_key: key, atualizado_em: new Date().toISOString() })
    .eq('id', spread_id).eq('album_id', album_id);
  if (uErr) {
    console.error('album-preview update spread error:', uErr);
    return res.status(500).json({ error: 'Erro ao salvar preview_key' });
  }

  return res.status(200).json({ key });
};
