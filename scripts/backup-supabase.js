/**
 * backup-supabase.js — backup diário de todas as tabelas do Supabase para o R2
 *
 * Roda via GitHub Actions (.github/workflows/backup-supabase.yml), todo dia.
 * Lê cada tabela com a service key (ignora RLS, pega tudo) e salva um JSON
 * por tabela em backups/YYYY-MM-DD/<tabela>.json no bucket R2 (privado).
 * Também apaga snapshots com mais de RETENTION_DIAS dias.
 *
 * Motivo: Supabase Free não tem PITR nem backup automático — foi assim que
 * perdemos a coluna `galerias.data` em jun/2026 sem chance de restaurar.
 *
 * Uso local:
 *   node scripts/backup-supabase.js
 *
 * Requer variáveis de ambiente (.env.local local, ou secrets no GitHub Actions):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 */

require('dotenv').config({ path: '.env.local' });

const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

const RETENTION_DIAS = 30;

// Todas as tabelas com dados de usuário (ver CLAUDE.md seção 4)
const TABELAS = [
  'clientes',
  'eventos',
  'financeiro',
  'financeiro_pessoal',
  'galerias',
  'posproducao',
  'configuracoes',
  'questionarios',
  'contratos',
  'galeria_favoritos',
  'newsletter_unsub',
  'q_form_tokens',
  'profiles',
];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function hoje() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function baixarTabela(nome) {
  // Paginado: evita timeout/limite em tabelas grandes
  const PAGE = 1000;
  let offset = 0;
  let todas = [];
  while (true) {
    const { data, error } = await supabase.from(nome).select('*').range(offset, offset + PAGE - 1);
    if (error) throw new Error(`${nome}: ${error.message}`);
    todas = todas.concat(data || []);
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }
  return todas;
}

async function salvarNoR2(data, key) {
  const body = JSON.stringify(data, null, 0);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: 'application/json',
  }));
  return Buffer.byteLength(body);
}

async function limparAntigos() {
  const limite = new Date(Date.now() - RETENTION_DIAS * 24 * 60 * 60 * 1000);
  const aDeletar = [];
  let continuationToken;
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: 'backups/',
      ContinuationToken: continuationToken,
    }));
    for (const obj of resp.Contents || []) {
      if (obj.LastModified < limite) aDeletar.push({ Key: obj.Key });
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : null;
  } while (continuationToken);

  if (!aDeletar.length) return 0;
  for (let i = 0; i < aDeletar.length; i += 1000) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Delete: { Objects: aDeletar.slice(i, i + 1000) },
    }));
  }
  return aDeletar.length;
}

(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log(' Kelvn — Backup diário do Supabase → R2');
  console.log('═══════════════════════════════════════════════════');

  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('❌ Variáveis faltando:', missing.join(', '));
    process.exit(1);
  }

  const data = hoje();
  let totalLinhas = 0;
  let totalBytes = 0;
  let falhas = 0;

  for (const tabela of TABELAS) {
    try {
      const linhas = await baixarTabela(tabela);
      const bytes = await salvarNoR2(linhas, `backups/${data}/${tabela}.json`);
      totalLinhas += linhas.length;
      totalBytes += bytes;
      console.log(`  ✓ ${tabela}: ${linhas.length} linhas (${(bytes / 1024).toFixed(1)} KB)`);
    } catch (err) {
      falhas++;
      console.error(`  ✗ ${tabela}: ${err.message}`);
    }
  }

  console.log('───────────────────────────────────────────────────');
  console.log(`Total: ${totalLinhas} linhas, ${(totalBytes / 1024 / 1024).toFixed(2)} MB, ${falhas} falhas`);

  const removidos = await limparAntigos();
  if (removidos) console.log(`Limpeza: ${removidos} arquivos com mais de ${RETENTION_DIAS} dias removidos.`);

  if (falhas > 0) {
    console.error(`\n❌ Backup concluído com ${falhas} falha(s) — verifique os erros acima.`);
    process.exit(1);
  }
  console.log('\n✅ Backup concluído com sucesso.');
})();
