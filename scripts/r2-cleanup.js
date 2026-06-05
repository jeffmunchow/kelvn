/**
 * r2-cleanup.js — limpa arquivos orphaned no R2
 *
 * Uso:
 *   node scripts/r2-cleanup.js              → dry-run (só lista, não deleta)
 *   node scripts/r2-cleanup.js --delete     → deleta de verdade
 *
 * Requer variáveis de ambiente (copie do .env.local ou Vercel):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

require('dotenv').config({ path: '.env.local' });

const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = !process.argv.includes('--delete');
const BATCH_DELETE = 1000; // R2 aceita até 1000 por DeleteObjects

// ── Clientes ──────────────────────────────────────────────────────────────────
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Utilitários ───────────────────────────────────────────────────────────────
function bytes(n) {
  if (n < 1024)          return n + ' B';
  if (n < 1024 ** 2)     return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3)     return (n / 1024 ** 2).toFixed(2) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

// ── 1. Lista todos os objetos do R2 ──────────────────────────────────────────
async function listarR2() {
  console.log('\n📦 Listando objetos no R2...');
  const objetos = new Map(); // key → { size, lastModified }
  let continuationToken;
  let paginas = 0;

  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket:            process.env.R2_BUCKET_NAME,
      ContinuationToken: continuationToken,
    }));

    for (const obj of resp.Contents || []) {
      objetos.set(obj.Key, { size: obj.Size, lastModified: obj.LastModified });
    }

    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : null;
    paginas++;
    process.stdout.write(`\r   ${objetos.size} objetos lidos (página ${paginas})...`);
  } while (continuationToken);

  console.log(`\n   Total no R2: ${objetos.size} objetos`);
  return objetos;
}

// ── 2. Coleta todas as keys registradas no Supabase ──────────────────────────
async function listarKeysRegistradas() {
  console.log('\n🗄️  Consultando Supabase...');
  const keysRegistradas = new Set();

  // Busca todas as linhas da tabela galerias (uma por fotógrafo)
  const { data: linhas, error } = await supabase
    .from('galerias')
    .select('data');

  if (error) throw new Error('Supabase error: ' + error.message);

  let totalFotos = 0;
  for (const linha of linhas || []) {
    const galerias = Array.isArray(linha.data) ? linha.data : [];
    for (const gal of galerias) {
      for (const foto of gal.fotos || []) {
        totalFotos++;
        if (foto.key)      keysRegistradas.add(foto.key);
        if (foto.thumbKey) keysRegistradas.add(foto.thumbKey);
        if (foto.webKey)   keysRegistradas.add(foto.webKey);
      }
    }
  }

  // Também inclui keys da nova tabela galeria_asset
  const { data: assets, error: aErr } = await supabase
    .from('galeria_asset')
    .select('r2_key');

  if (!aErr) {
    for (const asset of assets || []) {
      if (asset.r2_key) keysRegistradas.add(asset.r2_key);
    }
  }

  console.log(`   Galerias processadas: ${(linhas || []).length}`);
  console.log(`   Fotos registradas no banco: ${totalFotos}`);
  console.log(`   Keys únicas registradas: ${keysRegistradas.size}`);
  return keysRegistradas;
}

// ── 3. Compara e encontra orphans ─────────────────────────────────────────────
function encontrarOrphans(objetosR2, keysRegistradas) {
  console.log('\n🔍 Comparando...');
  const orphans = [];
  let bytesOrphan = 0;

  for (const [key, meta] of objetosR2) {
    if (!keysRegistradas.has(key)) {
      orphans.push({ key, ...meta });
      bytesOrphan += meta.size || 0;
    }
  }

  orphans.sort((a, b) => b.size - a.size); // maior primeiro
  return { orphans, bytesOrphan };
}

// ── 4. Deleta em lotes ────────────────────────────────────────────────────────
async function deletarOrphans(orphans) {
  let deletados = 0;
  let erros = 0;

  for (let i = 0; i < orphans.length; i += BATCH_DELETE) {
    const lote = orphans.slice(i, i + BATCH_DELETE);
    try {
      const resp = await s3.send(new DeleteObjectsCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Delete: {
          Objects: lote.map(o => ({ Key: o.key })),
          Quiet: false,
        },
      }));
      deletados += (resp.Deleted || []).length;
      erros     += (resp.Errors  || []).length;
      if (resp.Errors?.length) {
        resp.Errors.forEach(e => console.error('   ❌', e.Key, e.Message));
      }
      process.stdout.write(`\r   ${deletados} deletados...`);
    } catch (err) {
      console.error('\n   Erro no lote:', err.message);
      erros += lote.length;
    }
  }

  return { deletados, erros };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log(' Kelvn R2 Cleanup');
  console.log(DRY_RUN
    ? ' Modo: DRY-RUN (nenhum arquivo será deletado)'
    : ' Modo: DELETE REAL ⚠️');
  console.log('═══════════════════════════════════════════════════');

  // Valida env vars
  const required = ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME','SUPABASE_URL','SUPABASE_SERVICE_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('\n❌ Variáveis faltando:', missing.join(', '));
    console.error('   Crie um arquivo .env.local na raiz com essas variáveis.');
    process.exit(1);
  }

  try {
    const [objetosR2, keysRegistradas] = await Promise.all([
      listarR2(),
      listarKeysRegistradas(),
    ]);

    const { orphans, bytesOrphan } = encontrarOrphans(objetosR2, keysRegistradas);

    console.log('\n───────────────────────────────────────────────────');
    console.log(` Objetos no R2:         ${objetosR2.size}`);
    console.log(` Keys no banco:         ${keysRegistradas.size}`);
    console.log(` Orphans encontrados:   ${orphans.length}`);
    console.log(` Espaço a recuperar:    ${bytes(bytesOrphan)}`);
    console.log('───────────────────────────────────────────────────');

    if (!orphans.length) {
      console.log('\n✅ Nenhum orphan encontrado. R2 está limpo.');
      return;
    }

    // Mostra os 20 maiores
    console.log('\n Top 20 orphans por tamanho:');
    orphans.slice(0, 20).forEach((o, i) => {
      console.log(`  ${String(i+1).padStart(2)}. ${bytes(o.size).padStart(9)}  ${o.key}`);
    });
    if (orphans.length > 20) {
      console.log(`  ... e mais ${orphans.length - 20} arquivos`);
    }

    if (DRY_RUN) {
      console.log('\n⚠️  DRY-RUN: nada foi deletado.');
      console.log('   Para deletar de verdade, rode:');
      console.log('   node scripts/r2-cleanup.js --delete\n');
      return;
    }

    // Confirmação mínima antes de deletar
    console.log(`\n🗑️  Deletando ${orphans.length} arquivos (${bytes(bytesOrphan)})...`);
    const { deletados, erros } = await deletarOrphans(orphans);
    console.log(`\n\n✅ Concluído: ${deletados} deletados, ${erros} erros.`);

  } catch (err) {
    console.error('\n❌ Erro fatal:', err.message);
    process.exit(1);
  }
})();
