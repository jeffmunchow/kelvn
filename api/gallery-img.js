/**
 * gallery-img.js — proxy de imagem para exibição inline (sem Content-Disposition).
 * Usado pelo kelvn.html para exibir thumbnails e covers no painel do fotógrafo.
 *
 * Sem autenticação obrigatória — segurança baseada na opacidade da key (UUID).
 * Keys são geradas pelo servidor, não são adivinháveis.
 *
 * Modos:
 *  - padrão:  302 redirect para URL assinada do R2 (leve, usado nas <img>)
 *  - ?raw=1:  faz stream dos bytes same-origin com CORS liberado — necessário
 *             para o cliente buscar a imagem como File e compartilhar via
 *             Web Share API (ex.: Stories do Instagram), sem esbarrar em CORS.
 */
const { signKey } = require('./_gallery-sign');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const UUID_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/.+/i;

let _s3;
function s3() {
  if (!_s3) {
    _s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).end();

  const { key, raw } = req.query;
  if (!key || typeof key !== 'string' || key.includes('..') || key.startsWith('/')) {
    return res.status(400).json({ error: 'Invalid key' });
  }
  if (!UUID_PATH.test(key)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  // Modo bytes: stream same-origin (para Web Share API / compartilhamento de arquivo)
  if (raw) {
    try {
      const obj = await s3().send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key:    key,
      }));
      const chunks = [];
      for await (const chunk of obj.Body) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      res.setHeader('Content-Type', obj.ContentType || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=3000');
      res.status(200);
      return res.end(buffer);
    } catch (err) {
      if (err.name === 'NoSuchKey') return res.status(404).end();
      console.error('gallery-img raw error:', err);
      return res.status(500).end();
    }
  }

  try {
    // Sem filename = sem Content-Disposition → imagem exibe inline no browser
    const signedUrl = await signKey(key);
    res.setHeader('Cache-Control', 'private, max-age=3000'); // cache um pouco menor que o TTL (3600s)
    return res.redirect(302, signedUrl);
  } catch (err) {
    if (err.name === 'NoSuchKey') return res.status(404).end();
    console.error('gallery-img error:', err);
    return res.status(500).end();
  }
};
