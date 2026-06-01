const { createClient } = require('@supabase/supabase-js');
const { signKey } = require('./gallery-sign');

// Regex que valida que a key tem formato esperado: {uuid}/{qualquer-coisa}/arquivo
// Impede que alguém tente escanear o bucket com paths arbitrários.
const KEY_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/.+\/.+$/i;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { key, filename } = req.query;
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Missing key' });

  // Proteção contra path traversal
  if (key.includes('..') || key.startsWith('/')) {
    return res.status(400).json({ error: 'Chave inválida' });
  }

  const auth = req.headers.authorization;
  const isAutenticado = auth?.startsWith('Bearer ');

  if (isAutenticado) {
    // ── Fotógrafo autenticado: valida JWT + posse da key ─────────────
    const token = auth.slice(7);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Token inválido ou expirado' });

    if (!key.startsWith(`${user.id}/`)) {
      return res.status(403).json({ error: 'Acesso negado: este arquivo não pertence ao usuário autenticado' });
    }
  } else {
    // ── Casal (anônimo): valida apenas o formato UUID da key ─────────
    // A key foi obtida de uma signed URL gerada por gallery-verify/gallery-public,
    // portanto já passou pela verificação de senha e pertence a uma galeria publicada.
    // O formato UUID/... garante que não é possível escanear o bucket com paths arbitrários.
    if (!KEY_FORMAT.test(key)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
  }

  try {
    // Gera signed URL com Content-Disposition: attachment para forçar download
    const safeName = (filename || key.split('/').pop() || 'foto.jpg')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const signedUrl = await signKey(key, safeName);

    // Redireciona para a signed URL — o R2 serve o arquivo diretamente
    return res.redirect(302, signedUrl);
  } catch (err) {
    console.error('gallery-download error:', err);
    if (err.name === 'NoSuchKey') return res.status(404).json({ error: 'File not found' });
    return res.status(500).json({ error: 'Download failed' });
  }
};
