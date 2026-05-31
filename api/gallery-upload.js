const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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

  // 1) Extrai e valida o token
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.slice(7);

  // 2) Valida o token com o Supabase e extrai o userId real
  //    O userId vem do JWT — nunca do body da requisição
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
  const userId = user.id;

  // 3) Valida os campos do body — userId do body é ignorado intencionalmente
  const { filename, contentType, galeriaId } = req.body;
  if (!filename || !contentType || !galeriaId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // 4) Sanitiza o nome do arquivo
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

  // 5) Constrói a key com o userId do token — garante que o upload
  //    sempre vai para a pasta do usuário autenticado
  const key = `${userId}/${galeriaId}/${Date.now()}_${safeName}`;

  // 6) Gera URL pré-assinada com escopo restrito (1 objeto, 1 método, 1h)
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;

    return res.status(200).json({ signedUrl, publicUrl, key });
  } catch (err) {
    console.error('gallery-upload error:', err);
    return res.status(500).json({ error: 'Failed to generate upload URL' });
  }
};
