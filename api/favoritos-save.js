const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, email, lista, foto_ids } = req.body || {};
  if (!slug || !email || !lista || !Array.isArray(foto_ids)) {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }

  const emailNorm = email.toLowerCase().trim();
  // Validação básica de email
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    const { error } = await supabase
      .from('galeria_favoritos')
      .upsert({
        galeria_slug:  slug,
        email:         emailNorm,
        lista:         lista,
        foto_ids:      foto_ids,
        atualizado_em: new Date().toISOString()
      }, { onConflict: 'galeria_slug,email,lista' });

    if (error) throw error;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('favoritos-save error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
