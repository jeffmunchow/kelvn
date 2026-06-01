/**
 * _rate-limit.js — helper de rate limit por usuário autenticado.
 * Prefixo _ para não contar como função Vercel (limite Hobby = 12).
 *
 * Usa a tabela api_rate_limits no Supabase para contar requests
 * por user_id + endpoint numa janela de tempo deslizante.
 *
 * Criação da tabela (rodar no SQL Editor do Supabase):
 *   CREATE TABLE api_rate_limits (
 *     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
 *     user_id uuid NOT NULL,
 *     endpoint text NOT NULL,
 *     created_at timestamptz DEFAULT now()
 *   );
 *   CREATE INDEX ON api_rate_limits (user_id, endpoint, created_at);
 *   ALTER TABLE api_rate_limits ENABLE ROW LEVEL SECURITY;
 */

/**
 * Verifica e registra um request.
 * @param {object} supabase  — cliente com service key
 * @param {string} userId    — auth.uid() do usuário
 * @param {string} endpoint  — nome do endpoint (ex: 'ai-proxy')
 * @param {number} max       — máximo de requests na janela
 * @param {number} windowMin — tamanho da janela em minutos
 * @returns {Promise<{allowed: boolean, count: number, limit: number}>}
 */
async function checkRateLimit(supabase, userId, endpoint, max, windowMin) {
  const since = new Date(Date.now() - windowMin * 60 * 1000).toISOString();

  // Conta requests recentes
  const { count, error } = await supabase
    .from('api_rate_limits')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('endpoint', endpoint)
    .gte('created_at', since);

  if (error) {
    // Em caso de erro no banco, permite (fail-open) para não bloquear
    // o usuário legítimo por problema de infra. Loga para investigar.
    console.error('[rate-limit] erro ao consultar:', error.message);
    return { allowed: true, count: 0, limit: max };
  }

  if (count >= max) {
    return { allowed: false, count, limit: max };
  }

  // Registra o request atual (não bloqueia se falhar)
  await supabase
    .from('api_rate_limits')
    .insert({ user_id: userId, endpoint })
    .then(({ error: e }) => {
      if (e) console.error('[rate-limit] erro ao registrar:', e.message);
    });

  return { allowed: true, count: count + 1, limit: max };
}

/**
 * Limpeza periódica de registros antigos.
 * Chamar ocasionalmente (ex: 1 em cada 100 requests) para não acumular dados.
 */
async function cleanOldRecords(supabase, olderThanHours = 48) {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();
  await supabase
    .from('api_rate_limits')
    .delete()
    .lt('created_at', cutoff)
    .then(({ error: e }) => {
      if (e) console.error('[rate-limit] erro na limpeza:', e.message);
    });
}

module.exports = { checkRateLimit, cleanOldRecords };
