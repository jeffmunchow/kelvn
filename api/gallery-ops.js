'use strict';

/**
 * /api/gallery-ops
 *
 * Combina gallery-delete, gallery-download e gallery-cover num único handler
 * para economizar slots de Serverless Function no Vercel Hobby (limite: 12).
 *
 * Roteado por vercel.json:
 *   /api/gallery-delete   → /api/gallery-ops?action=delete
 *   /api/gallery-download → /api/gallery-ops?action=download
 *   /api/gallery-cover    → /api/gallery-ops?action=cover
 */

const { createClient } = require('@supabase/supabase-js');
const { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { signKey } = require('./_gallery-sign');
const sharp = require('sharp');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Regex para validar formato da key: {uuid}/{slug}/{arquivo}
const KEY_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/.+\/.+$/i;

module.exports = async function handler(req, res) {
  const { action } = req.query;

  if (action === 'delete')   return acDelete(req, res);
  if (action === 'download') return acDownload(req, res);
  if (action === 'cover')    return acCover(req, res);

  return res.status(404).json({ error: 'Not found' });
};

// ── DELETE ────────────────────────────────────────────────────────────────────

async function acDelete(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido ou expirado' });
  const userId = user.id;

  const { key } = req.body;
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Missing key' });

  if (!key.startsWith(`${userId}/`)) {
    return res.status(403).json({ error: 'Acesso negado: este arquivo não pertence ao usuário autenticado' });
  }
  if (key.includes('..') || key.startsWith('/')) {
    return res.status(400).json({ error: 'Chave inválida' });
  }

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('gallery-ops/delete error:', err);
    return res.status(500).json({ error: 'Failed to delete object' });
  }
}

// ── DOWNLOAD ──────────────────────────────────────────────────────────────────

async function acDownload(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { key, filename } = req.query;
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Missing key' });
  if (key.includes('..') || key.startsWith('/')) return res.status(400).json({ error: 'Chave inválida' });

  const auth = req.headers.authorization;
  const isAutenticado = auth?.startsWith('Bearer ');

  if (isAutenticado) {
    const token = auth.slice(7);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Token inválido ou expirado' });

    if (!key.startsWith(`${user.id}/`)) {
      return res.status(403).json({ error: 'Acesso negado: este arquivo não pertence ao usuário autenticado' });
    }
  } else {
    if (!KEY_FORMAT.test(key)) return res.status(403).json({ error: 'Acesso negado' });
  }

  try {
    const safeName = (filename || key.split('/').pop() || 'foto.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
    const signedUrl = await signKey(key, safeName);
    return res.redirect(302, signedUrl);
  } catch (err) {
    console.error('gallery-ops/download error:', err);
    if (err.name === 'NoSuchKey') return res.status(404).json({ error: 'File not found' });
    return res.status(500).json({ error: 'Download failed' });
  }
}

// ── COVER ─────────────────────────────────────────────────────────────────────
// Gera versão otimizada da foto de capa (2000px, ~500 KB) e salva como
// covers/{userId}/{slug}.jpg — sobrescreve sempre, sem acumular arquivos.

async function acCover(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await supabase.auth.getUser(auth.slice(7));
  if (authError || !user) return res.status(401).json({ error: 'Token inválido ou expirado' });

  const { key, slug } = req.body || {};
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Missing key' });
  if (!slug || typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug))
    return res.status(400).json({ error: 'Missing or invalid slug' });

  // Garante que a foto pertence ao usuário autenticado
  if (!key.startsWith(`${user.id}/`))
    return res.status(403).json({ error: 'Acesso negado' });
  if (key.includes('..') || key.startsWith('/'))
    return res.status(400).json({ error: 'Chave inválida' });

  try {
    // 1. Baixa o original do R2
    const getCmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key });
    const obj = await s3.send(getCmd);
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    const originalBuffer = Buffer.concat(chunks);

    // 2. Redimensiona para 2000px de largura (mantém aspecto), JPEG 85%
    const coverBuffer = await sharp(originalBuffer)
      .resize({ width: 2000, withoutEnlargement: true })
      .jpeg({ quality: 85, progressive: true })
      .toBuffer();

    // 3. Salva como covers/{userId}/{slug}.jpg — sobrescreve sempre
    const coverKey = `covers/${user.id}/${slug}.jpg`;
    await s3.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME,
      Key:         coverKey,
      Body:        coverBuffer,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000',
    }));

    const coverUrl = `${process.env.R2_PUBLIC_URL}/${coverKey}`;
    return res.status(200).json({ cover_url: coverUrl, cover_key: coverKey });
  } catch (err) {
    console.error('gallery-ops/cover error:', err);
    if (err.name === 'NoSuchKey') return res.status(404).json({ error: 'Foto não encontrada' });
    return res.status(500).json({ error: 'Falha ao gerar capa' });
  }
}
