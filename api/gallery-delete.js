const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1) Extrai e valida o token do header
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.slice(7);

  // 2) Valida o token com o Supabase e extrai o userId real
  //    Usa a service key apenas para validar o JWT — sem confiar em nada do client
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
  const { key } = req.body;
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'Missing key' });
  }

  // 4) Verifica posse: a key DEVE começar com o userId do token
  //    Impede IDOR — fotógrafo A não pode apagar arquivos do fotógrafo B
  if (!key.startsWith(`${userId}/`)) {
    return res.status(403).json({ error: 'Acesso negado: este arquivo não pertence ao usuário autenticado' });
  }

  // 5) Proteção extra: impede path traversal
  if (key.includes('..') || key.startsWith('/')) {
    return res.status(400).json({ error: 'Chave inválida' });
  }

  // 6) Apaga o objeto
  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    }));
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('gallery-delete error:', err);
    return res.status(500).json({ error: 'Failed to delete object' });
  }
};
