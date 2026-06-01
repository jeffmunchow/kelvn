/**
 * gallery-img.js — proxy de imagem para exibição inline (sem Content-Disposition).
 * Usado pelo kelvn.html para exibir thumbnails e covers no painel do fotógrafo.
 *
 * Sem autenticação obrigatória — segurança baseada na opacidade da key (UUID).
 * Keys são geradas pelo servidor, não são adivinháveis.
 */
const { signKey } = require('./_gallery-sign');

const UUID_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/.+/i;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).end();

  const { key } = req.query;
  if (!key || typeof key !== 'string' || key.includes('..') || key.startsWith('/')) {
    return res.status(400).json({ error: 'Invalid key' });
  }
  if (!UUID_PATH.test(key)) {
    return res.status(403).json({ error: 'Acesso negado' });
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
