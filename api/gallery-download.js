const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { key, filename } = req.query;
  if (!key) return res.status(400).json({ error: 'Missing key' });

  // Segurança: impede path traversal
  if (key.includes('..') || key.startsWith('/')) {
    return res.status(400).json({ error: 'Invalid key' });
  }

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

    // Stream direto do R2 para o cliente
    object.Body.pipe(res);
  } catch (err) {
    console.error('gallery-download error:', err);
    if (err.name === 'NoSuchKey') return res.status(404).json({ error: 'File not found' });
    return res.status(500).json({ error: 'Download failed' });
  }
};
