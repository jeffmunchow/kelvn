const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, email } = req.query;
  if (!slug || !email) return res.status(400).json({ error: 'Missing slug or email' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    const { data, error } = await supabase
      .from('galeria_favoritos')
      .select('lista, foto_ids')
      .eq('galeria_slug', slug)
      .eq('email', email.toLowerCase().trim());

    if (error) throw error;

    // Monta objeto { listaNome: [fotoIds] }
    const listas = {};
    (data || []).forEach(row => {
      listas[row.lista] = row.foto_ids || [];
    });

    return res.status(200).json({ listas });
  } catch (err) {
    console.error('favoritos-get error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
