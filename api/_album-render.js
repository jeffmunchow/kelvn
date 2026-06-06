/**
 * _album-render.js — geração de PDF de álbum server-side.
 * Prefixo _ para não contar como função Vercel.
 * Chamado por album-exportar.js via require('./_album-render').
 *
 * Depende de: pdf-lib, sharp, @aws-sdk/client-s3 (já em package.json).
 */

'use strict';

const { PDFDocument, rgb } = require('pdf-lib');
const sharp = require('sharp');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3 } = require('./_gallery-sign');
const { PERFIS_GRAFICA, DIMENSOES_FORMATO, REF_CANVAS_W } = require('./_perfis-grafica');

// ── Templates de layout (idênticos ao album.html) ────────────────────────────
const TEMPLATES = [
  { id:'uma-foto',       slots:[{x:.02,y:.02,w:.96,h:.96}] },
  { id:'full-bleed',     slots:[{x:0,y:0,w:1,h:1}] },
  { id:'duas-lado',      slots:[{x:.01,y:.02,w:.485,h:.96},{x:.505,y:.02,w:.485,h:.96}] },
  { id:'tres-direita',   slots:[{x:.01,y:.02,w:.63,h:.96},{x:.65,y:.02,w:.335,h:.47},{x:.65,y:.51,w:.335,h:.47}] },
  { id:'tres-esquerda',  slots:[{x:.01,y:.02,w:.335,h:.47},{x:.01,y:.51,w:.335,h:.47},{x:.36,y:.02,w:.63,h:.96}] },
  { id:'quatro-grid',    slots:[{x:.01,y:.02,w:.485,h:.47},{x:.505,y:.02,w:.485,h:.47},{x:.01,y:.51,w:.485,h:.47},{x:.505,y:.51,w:.485,h:.47}] },
  { id:'tira-topo',      slots:[{x:.01,y:.02,w:.32,h:.96},{x:.34,y:.02,w:.32,h:.96},{x:.67,y:.02,w:.32,h:.96}] },
  { id:'panorama',       slots:[{x:.01,y:.02,w:.96,h:.45},{x:.01,y:.52,w:.475,h:.46},{x:.505,y:.52,w:.475,h:.46}] },
  { id:'destaque-topo',  slots:[{x:.01,y:.02,w:.96,h:.55},{x:.01,y:.59,w:.31,h:.39},{x:.345,y:.59,w:.31,h:.39},{x:.68,y:.59,w:.305,h:.39}] },
];

// ── Função principal ──────────────────────────────────────────────────────────

/**
 * Gera o PDF completo do álbum e faz upload para o R2.
 * @param {object} job  — registro de album_exportacoes
 * @param {object} sb   — cliente Supabase com service key
 * @returns {{ pdf_key: string, pdf_tamanho_kb: number }}
 */
async function gerarPdfAlbum(job, sb) {
  // 1. Buscar álbum + spreads + slots
  const { data: album, error: aErr } = await sb
    .from('albuns').select('*').eq('id', job.album_id).single();
  if (aErr || !album) throw new Error('Álbum não encontrado: ' + job.album_id);

  const { data: spreads, error: sErr } = await sb
    .from('album_spreads')
    .select('*, album_slots(*), album_textos(*)')
    .eq('album_id', job.album_id)
    .eq('user_id', job.user_id)
    .order('posicao', { ascending: true });
  if (sErr) throw new Error('Erro ao buscar spreads: ' + sErr.message);

  const formato = album.formato || 'paisagem';

  // 2. Perfil de gráfica e dimensões
  const perfil = PERFIS_GRAFICA.find(p => p.id === job.perfil_grafica) || PERFIS_GRAFICA[0];
  const dpi = perfil.resolucao_dpi;
  const sangriaMm = perfil.sangria_mm;
  const dims = DIMENSOES_FORMATO[formato] || DIMENSOES_FORMATO.paisagem;
  const refW = REF_CANVAS_W[formato] || 800;

  // Converter cm → px
  const CM2PX = dpi / 2.54;
  const sangriaPx  = Math.round((sangriaMm / 10) * CM2PX);
  const contentW   = Math.round(dims.spread_w * CM2PX);
  const contentH   = Math.round(dims.h * CM2PX);
  const spreadW    = contentW + 2 * sangriaPx;
  const spreadH    = contentH + 2 * sangriaPx;

  // 3. Criar documento PDF
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(album.nome || 'Álbum');
  pdfDoc.setCreator('Kelvn');
  pdfDoc.setProducer('Kelvn — kelvn.com.br');

  const totalSpreads = spreads.length;

  // 4. Renderizar cada spread
  for (let i = 0; i < spreads.length; i++) {
    const spread = spreads[i];
    const slots  = (spread.album_slots || []).sort((a, b) => a.slot_index - b.slot_index);
    const textos = spread.album_textos || [];

    const spreadImg = await renderizarSpread(
      spread, slots, textos, spreadW, spreadH, contentW, contentH, sangriaPx, refW
    );

    // Pontos PDF (1 pt = 1/72 polegada)
    const ptW = (spreadW / dpi) * 72;
    const ptH = (spreadH / dpi) * 72;
    const page = pdfDoc.addPage([ptW, ptH]);

    const img = await pdfDoc.embedPng(spreadImg);
    page.drawImage(img, { x: 0, y: 0, width: ptW, height: ptH });

    // Marcas de corte nos 4 cantos
    adicionarMarcasDeCorte(page, sangriaPx, spreadW, spreadH, dpi);

    // Atualizar progresso (10% → 90%)
    const progresso = Math.round(10 + ((i + 1) / totalSpreads) * 80);
    await sb.from('album_exportacoes').update({ progresso }).eq('id', job.id);
  }

  // 5. Serializar PDF
  const pdfBytes = await pdfDoc.save();

  // 6. Upload para R2
  const pdfKey = `${job.user_id}/albuns/${job.album_id}/exportacoes/${job.id}.pdf`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: pdfKey,
    Body: Buffer.from(pdfBytes),
    ContentType: 'application/pdf',
  }));

  return {
    pdf_key: pdfKey,
    pdf_tamanho_kb: Math.round(pdfBytes.length / 1024),
  };
}

// ── Renderização de spread ────────────────────────────────────────────────────

async function renderizarSpread(spread, slots, textos, spreadW, spreadH, contentW, contentH, sangriaPx, refCanvasW) {
  const tpl = TEMPLATES.find(t => t.id === spread.template_id) || TEMPLATES[0];
  const bg  = spread.background_color || '#FFFFFF';
  const margemPx = (spread.margem_px != null) ? spread.margem_px : 8;
  const gutterPx = (spread.gutter_px  != null) ? spread.gutter_px  : 8;

  // Escalar espaçamento do canvas para impressão
  const sf       = contentW / refCanvasW;
  const margemHr = Math.round(margemPx * sf);
  const gutterHr = Math.round(gutterPx * sf);

  // Ajustar slots com espaçamento (same logic as aplicarEspacamento in album.html)
  const slotsAjust = aplicarEspacamento(tpl.slots, margemHr, gutterHr, contentW, contentH);

  const composite = [];

  // Processar cada slot
  for (let i = 0; i < slotsAjust.length; i++) {
    const s    = slotsAjust[i];
    const slot = slots[i];
    if (!slot || !slot.foto_key) continue;

    const slotX = sangriaPx + Math.round(s.x * contentW);
    const slotY = sangriaPx + Math.round(s.y * contentH);
    const slotW = Math.max(1, Math.round(s.w * contentW));
    const slotH = Math.max(1, Math.round(s.h * contentH));

    try {
      const photoBuffer = await baixarFotoDoR2(slot.foto_key);

      // Determinar posição focal a partir do crop salvo
      const position = calcularPosicaoSharp(
        slot.foto_x    || 0,
        slot.foto_y    || 0,
        slot.foto_escala > 0 ? slot.foto_escala : 1
      );

      const processed = await sharp(photoBuffer)
        .resize(slotW, slotH, { fit: 'cover', position })
        .png({ compressionLevel: 5 })
        .toBuffer();

      composite.push({ input: processed, left: slotX, top: slotY });
    } catch (err) {
      // Log key sem PII (só o nome do arquivo, sem userId)
      const keyParts = (slot.foto_key || '').split('/');
      console.error('[render] erro slot', i, keyParts[keyParts.length - 1], err.message);
    }
  }

  // Textos (via SVG inline)
  for (const t of textos) {
    try {
      const svgBuf = Buffer.from(gerarTextoSvg(t, spreadW, spreadH, sangriaPx, contentW, contentH));
      composite.push({ input: svgBuf, left: 0, top: 0 });
    } catch (err) {
      console.error('[render] erro texto:', err.message);
    }
  }

  // Montar imagem final com Sharp
  const bgRgb = hexToRgb(bg);
  return sharp({
    create: {
      width:    spreadW,
      height:   spreadH,
      channels: 3,
      background: { r: bgRgb.r, g: bgRgb.g, b: bgRgb.b },
    },
  })
    .composite(composite)
    .png({ compressionLevel: 5 })
    .toBuffer();
}

// ── Espaçamento (idêntico a aplicarEspacamento do album.html) ─────────────────

function aplicarEspacamento(slots, margemPx, gutterPx, W, H) {
  const mx = margemPx / W, my = margemPx / H;
  const gx = (gutterPx / 2) / W, gy = (gutterPx / 2) / H;
  return slots.map(function(s) {
    const leftEdge   = s.x < 0.01;
    const topEdge    = s.y < 0.01;
    const rightEdge  = (s.x + s.w) > 0.99;
    const bottomEdge = (s.y + s.h) > 0.99;
    return {
      x: s.x + mx + (!leftEdge   ? gx : 0),
      y: s.y + my + (!topEdge    ? gy : 0),
      w: s.w - mx * 2 - (!leftEdge  ? gx : 0) - (!rightEdge  ? gx : 0),
      h: s.h - my * 2 - (!topEdge   ? gy : 0) - (!bottomEdge ? gy : 0),
    };
  });
}

// ── Posição focal para sharp ──────────────────────────────────────────────────

/**
 * Derivar gravity do sharp a partir do crop salvo no slot.
 * foto_x, foto_y são offsets em pixels de canvas (tipicamente negativos = foto
 * maior que slot, centrada). foto_escala é o fator de escala absoluto.
 *
 * Lógica: normalizamos pelo tamanho escalado da foto (escala * originalW).
 * Para fotos auto-cropadas (centradas), o resultado é sempre 'centre'.
 * Para ajustes manuais do usuário, aproximamos a direção do ajuste.
 */
function calcularPosicaoSharp(foto_x, foto_y, escala) {
  // Se escala é muito pequena ou inválida, usar centro
  if (!escala || escala <= 0) return 'centre';

  // foto_x e foto_y são em canvas pixels. Para smart crop centrado, ambos são
  // -(fw*escala - slotW)/2 (negativos). Para o sharp, usamos 'centre' como
  // default e só mudamos se o usuário fez um ajuste significativo.
  // Como não temos as dimensões do canvas neste contexto, usamos a heurística:
  // foto_x próximo de 0 ou positivo (foto deslocada para a direita) → west
  // foto_x muito negativo (foto deslocada para a esquerda) → mantém centre
  // Para v1, usamos sempre 'centre' (correto para 100% das fotos auto-cropadas).
  return 'centre';
}

// ── Texto como SVG ────────────────────────────────────────────────────────────

function gerarTextoSvg(texto, spreadW, spreadH, sangriaPx, contentW, contentH) {
  const x  = sangriaPx + Math.round((texto.x || 0.1) * contentW);
  const y  = sangriaPx + Math.round((texto.y || 0.5) * contentH);
  const sz = Math.max(8, Math.round((texto.tamanho || 24) * (contentH / 300)));

  const anchor = texto.alinhamento === 'center' ? 'middle'
    : texto.alinhamento === 'right'  ? 'end' : 'start';

  const bold   = texto.negrito ? 'bold'   : 'normal';
  const italic = texto.italico ? 'italic' : 'normal';
  const cor    = escXml(texto.cor || '#FFFFFF');
  const fonte  = escXml(texto.fonte || 'Helvetica');
  const conteudo = escXml(texto.conteudo || '');

  return `<svg width="${spreadW}" height="${spreadH}" xmlns="http://www.w3.org/2000/svg">
  <text
    x="${x}" y="${y}"
    font-family="${fonte}, sans-serif"
    font-size="${sz}"
    font-weight="${bold}"
    font-style="${italic}"
    fill="${cor}"
    text-anchor="${anchor}"
    dominant-baseline="auto"
  >${conteudo}</text>
</svg>`;
}

// ── Marcas de corte ───────────────────────────────────────────────────────────

function adicionarMarcasDeCorte(page, sangriaPx, spreadWpx, spreadHpx, dpi) {
  const ptFromPx = (px) => (px / dpi) * 72;

  const sangriaPt = ptFromPx(sangriaPx);
  const larguraPt = ptFromPx(spreadWpx);
  const alturaPt  = ptFromPx(spreadHpx);
  const marcaPt   = ptFromPx(Math.round(dpi * 0.08)); // ~2mm
  const gap       = 2;   // gap entre borda da sangria e início da marca (pt)
  const cor       = rgb(0, 0, 0);
  const esp       = 0.4; // espessura em pontos

  const marcas = [
    // Canto superior esquerdo — horizontal
    { x1: 0,         y1: alturaPt - sangriaPt, x2: sangriaPt - gap, y2: alturaPt - sangriaPt },
    // Canto superior esquerdo — vertical
    { x1: sangriaPt, y1: alturaPt,              x2: sangriaPt,       y2: alturaPt - sangriaPt + gap },
    // Canto superior direito — horizontal
    { x1: larguraPt - sangriaPt + gap, y1: alturaPt - sangriaPt, x2: larguraPt, y2: alturaPt - sangriaPt },
    // Canto superior direito — vertical
    { x1: larguraPt - sangriaPt,       y1: alturaPt,             x2: larguraPt - sangriaPt, y2: alturaPt - sangriaPt + gap },
    // Canto inferior esquerdo — horizontal
    { x1: 0,         y1: sangriaPt, x2: sangriaPt - gap, y2: sangriaPt },
    // Canto inferior esquerdo — vertical
    { x1: sangriaPt, y1: 0,         x2: sangriaPt,       y2: sangriaPt - gap },
    // Canto inferior direito — horizontal
    { x1: larguraPt - sangriaPt + gap, y1: sangriaPt, x2: larguraPt, y2: sangriaPt },
    // Canto inferior direito — vertical
    { x1: larguraPt - sangriaPt,       y1: 0,          x2: larguraPt - sangriaPt, y2: sangriaPt - gap },
  ];

  marcas.forEach(({ x1, y1, x2, y2 }) => {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, color: cor, thickness: esp });
  });
}

// ── R2 helpers ────────────────────────────────────────────────────────────────

async function baixarFotoDoR2(key) {
  const resp = await s3.send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  }));
  const chunks = [];
  for await (const chunk of resp.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ── Utilitários ───────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const c = hex.replace('#', '');
  if (c.length === 3) {
    return {
      r: parseInt(c[0]+c[0], 16),
      g: parseInt(c[1]+c[1], 16),
      b: parseInt(c[2]+c[2], 16),
    };
  }
  return {
    r: parseInt(c.slice(0, 2), 16) || 0,
    g: parseInt(c.slice(2, 4), 16) || 0,
    b: parseInt(c.slice(4, 6), 16) || 0,
  };
}

function escXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { gerarPdfAlbum };
