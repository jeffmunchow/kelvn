/**
 * gallery-sign.js — helper compartilhado para gerar URLs assinadas do R2.
 * Usado por gallery-public, gallery-verify e gallery-download.
 * Signed URLs expiram em 1 hora — suficiente para uma sessão de galeria.
 */
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const EXPIRES_IN = 3600; // 1 hora

/**
 * Assina uma única key do R2.
 * @param {string} key  — key do objeto no bucket
 * @param {string} [filename] — se fornecido, força Content-Disposition: attachment
 * @returns {Promise<string>} URL assinada
 */
async function signKey(key, filename) {
  const params = { Bucket: process.env.R2_BUCKET_NAME, Key: key };
  if (filename) {
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    params.ResponseContentDisposition = `attachment; filename="${safe}"`;
  }
  return getSignedUrl(s3, new GetObjectCommand(params), { expiresIn: EXPIRES_IN });
}

/**
 * Extrai a key R2 de uma URL pública do bucket.
 * Suporta: https://pub-xxx.r2.dev/{key} e https://xxx.r2.cloudflarestorage.com/{bucket}/{key}
 * Retorna null se não for URL R2 reconhecível.
 */
function keyFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  // Formato proxy autenticado: /api/gallery-img?key={keyEncodada}
  const proxyMatch = url.match(/[?&]key=([^&]+)/);
  if (proxyMatch) return decodeURIComponent(proxyMatch[1]);
  // Formato pub-xxx.r2.dev (Public Development URL)
  const devMatch = url.match(/r2\.dev\/(.+)/);
  if (devMatch) return devMatch[1].split('?')[0];
  // Formato storage R2 (r2.cloudflarestorage.com/bucket/key)
  const storageMatch = url.match(/r2\.cloudflarestorage\.com\/[^/]+\/(.+?)(\?|$)/);
  if (storageMatch) return storageMatch[1];
  // Tenta usar o env var R2_PUBLIC_URL se disponível
  const pub = process.env.R2_PUBLIC_URL;
  if (pub && url.startsWith(pub + '/')) return url.slice(pub.length + 1).split('?')[0];
  return null;
}

/**
 * Recebe o array de fotos armazenado no Supabase e substitui
 * url/webUrl pelas versões assinadas, mantendo key/webKey intactos.
 * Se foto.key não existir, tenta extrair a key da url para assinar.
 */
async function signFotos(fotos) {
  if (!Array.isArray(fotos) || !fotos.length) return fotos;

  return Promise.all(fotos.map(async (foto) => {
    const signed = { ...foto };
    try {
      const key    = foto.key    || keyFromUrl(foto.url);
      const webKey = foto.webKey || keyFromUrl(foto.webUrl);
      if (key)    signed.url    = await signKey(key);
      if (webKey) signed.webUrl = await signKey(webKey);
    } catch (e) {
      console.error('gallery-sign: erro ao assinar foto', foto.key, e.message);
    }
    return signed;
  }));
}

/**
 * Assina a cover_url de uma galeria.
 * Aceita tanto uma key R2 direta quanto uma URL pública do bucket.
 */
async function signCoverUrl(coverUrl) {
  if (!coverUrl) return null;
  const key = keyFromUrl(coverUrl) || coverUrl; // se não for URL, trata como key direta
  try { return await signKey(key); }
  catch (e) { return null; }
}

module.exports = { signKey, signFotos, signCoverUrl, s3, EXPIRES_IN };
