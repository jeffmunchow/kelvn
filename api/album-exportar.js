/**
 * /api/album-exportar
 *
 * GET  ?action=status&job_id=<id>  → polling do progresso (autenticado)
 * POST ?action=iniciar             → cria job e dispara processar (autenticado)
 * POST ?action=processar           → gera o PDF em background (protegido por CRON_SECRET)
 *
 * Funções Vercel: 1 arquivo = 1 função. maxDuration: 300 configurado em vercel.json.
 * ⚠ Requer Vercel Pro para maxDuration > 60s no action=processar.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { s3 } = require('./_gallery-sign');
const { gerarPdfAlbum } = require('./_album-render');

const DOWNLOAD_EXPIRY = 24 * 60 * 60; // 24h em segundos

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.kelvn.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  if (action === 'status')    return acStatus(req, res);
  if (action === 'iniciar')   return acIniciar(req, res);
  if (action === 'processar') return acProcessar(req, res);

  return res.status(404).json({ error: 'Not found' });
};

// ── action=iniciar ────────────────────────────────────────────────────────────

async function acIniciar(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Autenticação
  const jwt = req.headers.authorization?.split('Bearer ')[1];
  if (!jwt) return res.status(401).json({ error: 'Unauthorized' });

  const sbAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: { user }, error: authErr } = await sbAnon.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });
  const userId = user.id;

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { album_id, perfil_grafica } = body;
  if (!album_id) return res.status(400).json({ error: 'album_id obrigatório' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Verificar posse do álbum E que está aprovado
  const { data: album, error: aErr } = await sb
    .from('albuns')
    .select('id, nome, aprovado, formato')
    .eq('id', album_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (aErr || !album) return res.status(404).json({ error: 'Álbum não encontrado' });
  if (!album.aprovado) return res.status(403).json({ error: 'O álbum precisa ser aprovado pelo casal antes de exportar' });

  // Contar spreads
  const { count: totalSpreads } = await sb
    .from('album_spreads')
    .select('*', { count: 'exact', head: true })
    .eq('album_id', album_id)
    .eq('user_id', userId);

  // Criar job
  const { data: job, error: jErr } = await sb
    .from('album_exportacoes')
    .insert({
      album_id,
      user_id: userId,
      perfil_grafica: perfil_grafica || 'padrao',
      status: 'aguardando',
      progresso: 0,
      total_spreads: totalSpreads || 0,
    })
    .select()
    .single();

  if (jErr || !job) {
    console.error('acIniciar insert error:', jErr);
    return res.status(500).json({ error: 'Erro ao criar job de exportação' });
  }

  // Disparar processamento em background (fire and forget)
  const baseUrl = `https://${req.headers.host}`;
  fetch(`${baseUrl}/api/album-exportar?action=processar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': process.env.CRON_SECRET,
    },
    body: JSON.stringify({ job_id: job.id }),
  }).catch((err) => {
    console.error('acIniciar: erro ao disparar processar:', err.message);
  });

  return res.status(200).json({ job_id: job.id });
}

// ── action=status ─────────────────────────────────────────────────────────────

async function acStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const jwt = req.headers.authorization?.split('Bearer ')[1];
  if (!jwt) return res.status(401).json({ error: 'Unauthorized' });

  const sbAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: { user }, error: authErr } = await sbAnon.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { job_id } = req.query;
  if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: job, error: jErr } = await sb
    .from('album_exportacoes')
    .select('id, status, progresso, pdf_key, pdf_tamanho_kb, total_spreads, iniciado_em, concluido_em, pdf_expira_em')
    .eq('id', job_id)
    .eq('user_id', user.id) // nunca confiar no body
    .maybeSingle();

  if (jErr || !job) return res.status(404).json({ error: 'Job não encontrado' });

  if (job.status === 'erro') {
    return res.status(200).json({ status: 'erro', mensagem: 'Erro ao gerar o PDF. Tente novamente.' });
  }

  if (job.status === 'concluido' && job.pdf_key) {
    // Verificar se o link ainda é válido (ou gerar um novo)
    const agora = new Date();
    const expira = job.pdf_expira_em ? new Date(job.pdf_expira_em) : null;
    let downloadUrl = null;

    if (!expira || expira > agora) {
      // Gerar signed URL de 24h
      try {
        downloadUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: job.pdf_key,
            ResponseContentDisposition: 'attachment; filename="album.pdf"',
          }),
          { expiresIn: DOWNLOAD_EXPIRY }
        );

        // Atualizar pdf_expira_em se ainda não está definido
        if (!job.pdf_expira_em) {
          const novaExpiracao = new Date(Date.now() + DOWNLOAD_EXPIRY * 1000).toISOString();
          await sb.from('album_exportacoes')
            .update({ pdf_expira_em: novaExpiracao })
            .eq('id', job.id);
        }
      } catch (err) {
        console.error('acStatus: erro ao gerar signed URL:', err.message);
      }
    }

    return res.status(200).json({
      status: 'concluido',
      download_url: downloadUrl,
      pdf_tamanho_kb: job.pdf_tamanho_kb,
      expira_em: job.pdf_expira_em,
      concluido_em: job.concluido_em,
    });
  }

  // aguardando ou processando
  return res.status(200).json({
    status: job.status,
    progresso: job.progresso || 0,
    total_spreads: job.total_spreads,
  });
}

// ── action=processar ──────────────────────────────────────────────────────────

async function acProcessar(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Protegido por CRON_SECRET — apenas chamadas internas
  const cronSecret = process.env.CRON_SECRET;
  const recebido   = req.headers['x-cron-secret'];
  if (!cronSecret || recebido !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { job_id } = body;
  if (!job_id) return res.status(400).json({ error: 'job_id obrigatório' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Buscar job aguardando
  const { data: job, error: jErr } = await sb
    .from('album_exportacoes')
    .select('*')
    .eq('id', job_id)
    .eq('status', 'aguardando')
    .maybeSingle();

  if (jErr || !job) {
    console.error('acProcessar: job não encontrado ou não aguardando:', job_id);
    return res.status(404).json({ error: 'Job não encontrado' });
  }

  // Marcar como processando
  await sb.from('album_exportacoes')
    .update({ status: 'processando', progresso: 5 })
    .eq('id', job.id);

  try {
    const resultado = await gerarPdfAlbum(job, sb);

    const expira = new Date(Date.now() + DOWNLOAD_EXPIRY * 1000).toISOString();
    await sb.from('album_exportacoes').update({
      status: 'concluido',
      progresso: 100,
      pdf_key: resultado.pdf_key,
      pdf_tamanho_kb: resultado.pdf_tamanho_kb,
      concluido_em: new Date().toISOString(),
      pdf_expira_em: expira,
    }).eq('id', job.id);

    return res.status(200).json({ ok: true, pdf_tamanho_kb: resultado.pdf_tamanho_kb });

  } catch (err) {
    // Nunca enviar erro_detalhe para o client — só salvar internamente
    const detalheInterno = err.message || String(err);
    console.error('acProcessar: gerarPdfAlbum falhou:', detalheInterno);

    await sb.from('album_exportacoes').update({
      status: 'erro',
      progresso: 0,
      erro_detalhe: detalheInterno.substring(0, 500), // truncar PII eventual
    }).eq('id', job.id);

    return res.status(500).json({ error: 'Erro ao gerar PDF' });
  }
}

// Config do body parser — PDF jobs podem ter payloads pequenos, mas ok manter padrão
module.exports.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
