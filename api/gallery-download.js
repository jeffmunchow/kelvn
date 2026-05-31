const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // 1) Extrai e valida o token — download exige autenticação
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.slice(7);

  // 2) Valida o token com o Supabase e extrai o userId real
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
  const userId = user.id;

  // 3) Valida a key
  const { key, filename } = req.query;
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'Missing key' });
  }

  // 4) Verifica posse: a key DEVE começar com o userId do token
  //    Impede que fotógrafo A baixe arquivos do fotógrafo B
  if (!key.startsWith(`${userId}/`)) {
    return res.status(403).json({ error: 'Acesso negado: este arquivo não pertence ao usuário autenticado' });
  }

  // 5) Proteção contra path traversal
  if (key.includes('..') || key.startsWith('/')) {
    return res.status(400).json({ error: 'Chave inválida' });
  }

  // 6) Busca e faz stream do objeto
  try {
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    });

    const object = await s3.send(command);

    const safeName = (filename || key.split('/').pop() || 'foto.jpg')
      .replace(/[^a-zA-Z0-9._-]/g, '_');

    res.setHeader('Content-Type', object.ContentType || 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    if (object.ContentLength) res.setHeader('Content-Length', object.ContentLength);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    object.Body.pipe(res);
  } catch (err) {
    console.error('gallery-download error:', err);
    if (err.name === 'NoSuchKey') return res.status(404).json({ error: 'File not found' });
    return res.status(500).json({ error: 'Download failed' });
  }
};
