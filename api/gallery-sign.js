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
 * Recebe o array de fotos armazenado no Supabase e substitui
 * url/webUrl pelas versões assinadas, mantendo key/webKey intactos.
 * Fotos sem key são ignoradas (mantêm url original).
 */
async function signFotos(fotos) {
  if (!Array.isArray(fotos) || !fotos.length) return fotos;

  return Promise.all(fotos.map(async (foto) => {
    const signed = { ...foto };
    try {
      if (foto.key)    signed.url    = await signKey(foto.key);
      if (foto.webKey) signed.webUrl = await signKey(foto.webKey);
    } catch (e) {
      console.error('gallery-sign: erro ao assinar foto', foto.key, e.message);
      // Em caso de erro, mantém a URL original para não quebrar a galeria
    }
    return signed;
  }));
}

/**
 * Assina a cover_url se ela tiver um key R2 associado.
 * Recebe o objeto completo da galeria e devolve com cover_url assinada.
 */
async function signCoverUrl(coverKey) {
  if (!coverKey) return null;
  try { return await signKey(coverKey); }
  catch (e) { return null; }
}

module.exports = { signKey, signFotos, signCoverUrl, s3, EXPIRES_IN };
