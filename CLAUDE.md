# Kelvn — Contexto para Claude Code

> Este arquivo é o ponto de partida para qualquer sessão no Claude Code.
> Leia antes de qualquer tarefa. Atualize ao concluir pendências — não deixe
> achados de auditoria "resolvidos no código" sem atualizar aqui.

---

## 1. O projeto

**Kelvn** é um sistema de gestão (CRM + financeiro + galerias) para fotógrafos
de casamento brasileiros. Fundador: Jeff Münchow (Münchow Studio).

**Foco atual (2026):** preparar o app nativo para lançamento na App Store.
Toda alteração no app web precisa ser espelhada no app nativo — ver seção 5.

### Stack de produção

| Camada | Tecnologia |
|---|---|
| Frontend web | `app/kelvn.html` (sistema) e `app/album.html` (editor de álbum) — HTML/CSS/JS puro, sem framework |
| Páginas públicas | `app/assinar.html`, `app/form.html`, `app/galeria.html`, `app/album-revisao.html` |
| App nativo | Capacitor + Xcode (`native/`) — Mac Catalyst e iOS, espelha o app web |
| Hospedagem | Vercel (auto-deploy no push para `main`) |
| Backend | Supabase (Postgres + RLS + Auth), região São Paulo (`sa-east-1`) |
| Fotos | Cloudflare R2 (bucket `kelvn-galerias`), via `/api/gallery-*` |
| Backup | GitHub Actions diário (`.github/workflows/backup-supabase.yml`) → snapshots JSON no R2, retenção 30 dias |
| Pagamento | Kirvano → webhook (`api/webhook-kirvano.js`) cria usuário |
| Email | Resend |
| DNS | Hostinger |
| Repo | `github.com/jeffmunchow/kelvn` (público) |

### Domínios

- `kelvn.com.br` → raiz do repositório (landing page)
- `app.kelvn.com.br` → pasta `app/` → `kelvn.html` (sistema) — roteamento em `vercel.json`

### Chaves e segredos

- **Chave anon/publishable** (`eyJ...`): pública por design, está no `kelvn.html`. A segurança **não** depende dela ser secreta.
- **`SUPABASE_SERVICE_KEY`**: env da Vercel, ignora RLS, nunca aparece no client.
- **`ANTHROPIC_API_KEY`**, credenciais R2, token Kirvano, `BROWSERLESS_TOKEN`, `CRON_SECRET`: env vars da Vercel — nenhuma hardcoded no repo.
- **Credenciais do backup** (`SUPABASE_SERVICE_KEY`, R2): vivem como GitHub Actions secrets, separadas das env da Vercel.

### Regra de ouro de segurança

A chave publishable é pública. **Toda a segurança de dados está nas políticas RLS e nas funções serverless.** É lá que se foca ao revisar qualquer mudança.

---

## 2. Segurança — estado atual

Duas rodadas de auditoria já fechadas (maio/2026 e junho/2026). Todos os P0/P1
identificados nessas rodadas estão **corrigidos e em produção**:

| Item | Status | Onde |
|---|---|---|
| Webhook Kirvano sem verificação de origem | ✅ corrigido | `api/webhook-kirvano.js` — compara `KIRVANO_WEBHOOK_TOKEN` com `timingSafeEqual` |
| Token Browserless hardcoded | ✅ corrigido | `api/contrato-pdf.js` — via `process.env.BROWSERLESS_TOKEN` |
| Cron de newsletter sem auth, vazava e-mails | ✅ corrigido | `api/_newsletter.js` — valida `CRON_SECRET`, não retorna e-mails |
| Stored XSS via favoritos (`innerHTML` sem escape) | ✅ corrigido | `app/kelvn.html` — `esc(sel.email)` no render de seleções |
| `favoritos.js` autenticava com JWT sem validar assinatura | ✅ corrigido | `api/favoritos.js` — usa `supabase.auth.getUser(token)` |
| `ai-proxy` aberto (qualquer um usava a chave Anthropic) | ✅ corrigido | `api/ai-proxy.js` — exige JWT válido do Supabase |
| Token de questionário com `Math.random()` | ✅ corrigido | `app/kelvn.html` — `crypto.randomUUID()` |
| Saída da IA injetada com `innerHTML` | ✅ corrigido | `app/kelvn.html` — usa `textContent` |
| Zero headers de segurança | ✅ corrigido | `vercel.json` — CSP, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` por rota |
| `contrato-pdf` sem auth | ✅ corrigido | `api/contrato-pdf.js` — exige JWT do Supabase |
| Sem lockfile (build não-determinístico) | ✅ corrigido | `package-lock.json` commitado |
| Sem backup do Supabase (Free não tem PITR) | ✅ resolvido | backup diário automático para R2, ver seção 1 |

**Pendências reais de segurança (backlog, não urgentes):**

- **MFA na conta do Jeff** (`jeffmunchowweddings@gmail.com`) — ainda não confirmado se está ativo. `isAdmin()` no client é só para liberar dados demo, nunca usar como gate de ação real.
- **`newsletter-unsub` por `uid` não assinado** (`api/_newsletter.js` / `api/album-revisao.js`, `action=unsub`) — o link de cancelamento usa o `uid` puro na URL, sem HMAC. Terceiro que descobrir o `uid` de outro usuário pode descadastrá-lo da newsletter. Baixo impacto (não afeta dados sensíveis), mas fácil de fechar: assinar o `uid` com HMAC antes de aceitar.
- **Verificação de RLS nas tabelas que não têm `.sql` versionado** — só `contratos.sql` e `galerias.sql` estão no repo; o resto da política RLS vive só no Supabase. Rodar de tempos em tempos:
  ```sql
  SELECT t.tablename, t.rowsecurity, count(p.policyname) AS politicas
  FROM pg_tables t LEFT JOIN pg_policies p
    ON t.schemaname = p.schemaname AND t.tablename = p.tablename
  WHERE t.schemaname = 'public' GROUP BY t.tablename, t.rowsecurity;
  ```
  Esperado: `rowsecurity = true` e ≥4 políticas (`auth.uid() = user_id`) em cada tabela de dado de usuário.

### Princípios de segurança (válidos para qualquer mudança nova)

- CORS não é autenticação. Endpoint com service key sem auth real = a única muralha é o código.
- RLS habilitada em TODA tabela — ter política não basta sem `ENABLE ROW LEVEL SECURITY`.
- Token de acesso público: sempre `crypto.randomUUID()`, nunca `Math.random()`.
- Acesso anônimo por token: sempre via função `SECURITY DEFINER` no Postgres, nunca `.eq()` no client.
- Campo de terceiro no DOM: sempre `textContent` ou `esc()`, nunca `innerHTML` direto.
- Segredo já commitado = segredo vazado. Rotacionar imediatamente, não basta trocar o código.

---

## 3. Estrutura do repositório

```
kelvn/
├── CLAUDE.md
├── vercel.json          ← roteamento de domínios + headers de segurança + cron
├── package.json
├── scripts/
│   ├── backup-supabase.js   ← backup diário (rodado via GitHub Actions)
│   ├── r2-cleanup.js        ← lista/apaga arquivos órfãos no R2 (dry-run por padrão)
│   └── sync-native.sh       ← sincroniza app/ → native/www/ → bundle do Xcode
├── .github/workflows/
│   └── backup-supabase.yml  ← cron diário 03h BRT
├── app/
│   ├── kelvn.html        ← sistema completo (CRM, financeiro, etc.)
│   ├── album.html        ← editor/visualizador de álbum
│   ├── galeria.html      ← galeria pública para os convidados do casamento
│   ├── assinar.html, form.html, album-revisao.html
│   └── vendor/
├── api/                  ← funções serverless da Vercel
│   ├── gallery-*.js      ← upload/download/delete/sign de fotos no R2
│   ├── ai-proxy.js       ← proxy autenticado pra Anthropic
│   ├── favoritos.js      ← seleção de fotos pelos convidados
│   ├── contrato-pdf.js   ← geração de PDF via Browserless
│   ├── meta-ads.js       ← sync de métricas do Meta Ads (cron diário)
│   ├── webhook-kirvano.js← cria usuário no pagamento
│   └── _newsletter.js, album-revisao.js, album-exportar.js, ...
└── native/
    ├── www/              ← cópia sincronizada de app/ (fonte intermediária)
    └── ios/App/          ← projeto Xcode (Capacitor) — Mac Catalyst + iOS
```

---

## 4. Supabase

- **Projeto:** `kelvn` — `https://lbsepogmbusfkdgnencb.supabase.co` — região São Paulo.
- **Tabelas principais:** `profiles`, `clientes`, `eventos`, `financeiro`, `financeiro_pessoal`, `galerias`, `posproducao`, `configuracoes`, `questionarios`, `contratos`, `galeria_favoritos`, `newsletter_unsub`, `q_form_tokens`.
- Todas com RLS — cada fotógrafo só acessa os próprios dados (`auth.uid() = user_id`).
- **Backup:** Supabase Free não tem PITR. Backup diário automático (GitHub Actions, 03h BRT) salva snapshot JSON de cada tabela em `r2://kelvn-galerias/backups/YYYY-MM-DD/`, com retenção de 30 dias. Ver `scripts/backup-supabase.js`.
- **Admin:** `jeffmunchowweddings@gmail.com` é o único usuário que vê dados demo ao logar (`isAdmin()` no client — só para demo, nunca para gate de segurança real).

---

## 5. Regra de sincronização com o app nativo (App Store)

**Toda alteração em `app/kelvn.html`, `app/album.html` ou nos assets (`vendor/`,
ícone, manifest) precisa ser refletida no app nativo.** O objetivo do projeto
é lançar um app impecável na App Store — o nativo não é um espelho secundário.

Fluxo obrigatório a cada mudança:

1. Editar a fonte em `app/`.
2. `bash scripts/sync-native.sh` — copia pra `native/www/` e roda `npx cap copy ios` (copia pra `native/ios/App/App/public/`, que é `.gitignore`d — bundle gerado, não fonte).
3. Recompilar no Xcode: `xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug -destination 'platform=macOS,variant=Mac Catalyst' CODE_SIGNING_ALLOWED=NO build` (ou pelo Xcode diretamente).
4. **Fechar e reabrir o app nativo** — Cmd+R não recarrega o bundle; o WebView do Capacitor só lê o que foi empacotado na hora do build, não busca nada novo em runtime.

**Versionamento obrigatório:** todo commit que toque `kelvn.html` deve bumpar `APP_VERSION`; todo commit que toque `album.html` deve bumpar `ALBUM_VERSION`. Isso dispara o auto-reload de quem já está com a aba aberta. Versão atual: `APP_VERSION` e `ALBUM_VERSION` — ver as respectivas linhas `var APP_VERSION = '...'` / `var ALBUM_VERSION = '...'` no topo da lógica de cada arquivo.

---

## 6. Fluxo de trabalho com o Jeff

- Claude edita o código direto (Edit/Write) — não entrega diff pra aplicar manualmente.
- Commit + push só acontece quando o Jeff digita **`//cp`**. Fora disso, nunca dar push.
- Mensagens de commit: conventional commits curtos em PT, minúsculo. Sem trailer `Co-Authored-By`.
- Mudanças cirúrgicas, uma de cada vez — sem "melhorias" não pedidas, sem find-replace global em strings repetidas.
- Mostrar a ideia antes de implementar quando a mudança não for um pedido direto e específico; ao aprovar, aplicar direto.
- Supabase / Vercel / infra / DNS: Claude não tem acesso direto — entrega o SQL/comando pronto e o passo a passo (SQL Editor do Supabase, painel da Vercel, etc.). Credenciais sensíveis (chaves, tokens) são fornecidas pelo Jeff fora do chat sempre que possível (ex: criando `.env.local` direto no terminal), nunca pedidas/coladas no histórico de conversa sem necessidade.

---

*Última atualização: 2026-06-25 — reescrito para refletir o estado real do código (as duas rodadas de auditoria de segurança estão fechadas; o item antigo que listava 13 achados "abertos" estava desatualizado).*
