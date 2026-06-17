(function(){
  // ── CSS ──────────────────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '.fb-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:900;align-items:center;justify-content:center;padding:1rem;}',
    '.fb-overlay.open{display:flex;}',
    '.fb-modal{background:var(--surface);border-radius:var(--radius,8px);border:.5px solid var(--border-strong);width:100%;max-width:500px;max-height:90vh;overflow-y:auto;padding:1.75rem;}',
    '.fb-modal h2{font-family:\'Playfair Display\',serif;font-size:1.05rem;font-weight:600;margin-bottom:.35rem;}',
    '.fb-modal p{font-size:.78rem;color:var(--text-muted);line-height:1.4;margin-bottom:1.25rem;}',
    '.fb-modal .fb-field{display:flex;flex-direction:column;gap:.4rem;margin-bottom:1rem;}',
    '.fb-modal .fb-field label{font-size:.7rem;color:var(--text-muted);font-weight:500;}',
    '.fb-modal .fb-actions{display:flex;gap:.5rem;justify-content:flex-end;margin-top:.5rem;}',
    '.fb-pill{font-size:.62rem;padding:2px 9px;border-radius:20px;border:.5px solid var(--border-strong);background:transparent;color:var(--text-hint);cursor:pointer;font-family:\'DM Sans\',sans-serif;transition:background .15s,color .15s;}',
    '.fb-pill:hover{background:var(--surface2);}',
    '.fb-pill.active{background:transparent;color:var(--text);border-color:var(--border-strong);}',
    '.fb-pill.active:hover{background:var(--surface2);}',
    '#fb-msg::placeholder{color:var(--text-hint);}',
  ].join('');
  document.head.appendChild(style);

  // ── HTML ─────────────────────────────────────────────────────────────────────
  var wrap = document.createElement('div');
  wrap.innerHTML = [
    '<div class="fb-overlay" id="ov-feedback">',
    '  <div class="fb-modal">',
    '    <h2>Manda pra gente</h2>',
    '    <p>O que você está achando? Ideia, problema ou só um elogio —<br>a gente lê tudo.</p>',
    '    <div class="fb-field">',
    '      <label>Tipo</label>',
    '      <div id="fb-tipos" style="display:flex;gap:6px;flex-wrap:wrap;">',
    '        <button type="button" class="fb-pill active" data-tipo="sugestao" onclick="fbSelTipo(this)">Sugestão</button>',
    '        <button type="button" class="fb-pill" data-tipo="problema" onclick="fbSelTipo(this)">Problema</button>',
    '        <button type="button" class="fb-pill" data-tipo="elogio" onclick="fbSelTipo(this)">Elogio</button>',
    '        <button type="button" class="fb-pill" data-tipo="outro" onclick="fbSelTipo(this)">Outro</button>',
    '      </div>',
    '    </div>',
    '    <div class="fb-field">',
    '      <label>Sua mensagem</label>',
    '      <textarea id="fb-msg" rows="5" placeholder="Conta pra gente com suas palavras…" style="width:100%;font-family:\'DM Sans\',sans-serif;font-size:.85rem;border:.5px solid var(--border-strong);border-radius:var(--radius,8px);background:transparent;color:var(--text);outline:none;padding:.65rem .75rem;resize:vertical;line-height:1.5;box-sizing:border-box;"></textarea>',
    '    </div>',
    '    <div class="fb-actions">',
    '      <button class="btn" onclick="fecharFeedback()">Cancelar</button>',
    '      <button class="btn primary" id="fb-enviar" onclick="enviarFeedback()">Enviar</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('');
  document.body.appendChild(wrap.firstElementChild);

  // Fechar ao clicar fora
  document.getElementById('ov-feedback').addEventListener('click', function(e){
    if(e.target === this) fecharFeedback();
  });

  // ── Funções globais ───────────────────────────────────────────────────────────
  window._fbTipo = 'sugestao';

  window.abrirFeedback = function(){
    window._fbTipo = 'sugestao';
    document.querySelectorAll('#fb-tipos .fb-pill').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-tipo') === 'sugestao');
    });
    document.getElementById('fb-msg').value = '';
    var btn = document.getElementById('fb-enviar');
    btn.textContent = 'Enviar';
    btn.disabled = false;
    document.getElementById('ov-feedback').classList.add('open');
    setTimeout(function(){ document.getElementById('fb-msg').focus(); }, 50);
  };

  window.fecharFeedback = function(){
    document.getElementById('ov-feedback').classList.remove('open');
  };

  window.fbSelTipo = function(btn){
    window._fbTipo = btn.getAttribute('data-tipo');
    document.querySelectorAll('#fb-tipos .fb-pill').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
  };

  window.enviarFeedback = async function(){
    var msg = document.getElementById('fb-msg').value.trim();
    if(!msg){
      if(typeof notify === 'function') notify('Escreva uma mensagem antes de enviar.');
      else alert('Escreva uma mensagem antes de enviar.');
      return;
    }
    var btn = document.getElementById('fb-enviar');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try{
      var sb = window._sb;
      var token = '';
      if(sb){
        var sessionR = await sb.auth.getSession();
        token = sessionR.data && sessionR.data.session ? sessionR.data.session.access_token : '';
      }
      var contexto = typeof _curSection !== 'undefined' ? ('seção: ' + _curSection) : 'editor de álbuns';
      if(typeof APP_VERSION !== 'undefined') contexto += ' · ' + APP_VERSION;
      var resp = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ tipo: window._fbTipo, mensagem: msg, contexto: contexto }),
      });
      if(!resp.ok) throw new Error('falha');
      fecharFeedback();
      if(typeof notify === 'function') notify('Obrigado! Recebemos seu feedback.');
      else alert('Obrigado! Recebemos seu feedback.');
    }catch(e){
      btn.disabled = false;
      btn.textContent = 'Enviar';
      if(typeof notify === 'function') notify('Algo deu errado por aqui. Tente de novo em instantes.');
      else alert('Algo deu errado por aqui. Tente de novo em instantes.');
    }
  };
})();
