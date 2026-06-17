(function(){
  // ── CSS — cópia exata dos estilos usados em kelvn.html ────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:900;align-items:center;justify-content:center;padding:1rem;}',
    '.overlay.open{display:flex;}',
    '.modal{background:var(--surface);border-radius:var(--radius);border:.5px solid var(--border-strong);width:100%;max-width:500px;max-height:90vh;overflow-y:auto;padding:1.75rem;}',
    '.modal h2{font-family:\'Playfair Display\',serif;font-size:1.05rem;font-weight:600;margin-bottom:1.25rem;}',
    '.field{margin-bottom:.9rem;}',
    '.field label{display:block;font-size:.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px;}',
    '.field input,.field select{width:100%;font-family:\'DM Sans\',sans-serif;font-size:.88rem;background:var(--surface2);border:.5px solid var(--border-strong);border-radius:var(--radius-sm);padding:8px 11px;color:var(--text);outline:none;}',
    '.ma{display:flex;gap:8px;margin-top:1.5rem;justify-content:flex-end;flex-wrap:wrap;}',
    '.btn{font-family:\'DM Sans\',sans-serif;font-size:.78rem;padding:6px 15px;border-radius:var(--radius);border:.5px solid var(--border-strong);background:transparent;color:var(--text-muted);cursor:pointer;}',
    '.btn.primary{background:var(--text);color:var(--bg);border-color:var(--text);}',
    '.btn.primary:hover{opacity:.82;}',
    '.ig-pill{font-size:.62rem;padding:2px 9px;border-radius:20px;border:.5px solid var(--border-strong);background:transparent;color:var(--text-hint);cursor:pointer;font-family:\'DM Sans\',sans-serif;transition:background .15s,color .15s;}',
    '#fb-msg::placeholder{color:var(--text-hint);}',
    '#fb-tipos .ig-pill{transition:background .15s,color .15s;}',
    '#fb-tipos .ig-pill:hover{background:var(--surface2);}',
    '#fb-tipos .ig-pill.active{background:transparent;color:var(--text);border-color:var(--border-strong);}',
    '#fb-tipos .ig-pill.active:hover{background:var(--surface2);}',
  ].join('');
  document.head.appendChild(style);

  // ── HTML — estrutura idêntica à do kelvn.html ─────────────────────────────────
  var el = document.createElement('div');
  el.innerHTML = [
    '<div class="overlay" id="ov-feedback"><div class="modal">',
    '  <h2 style="margin-bottom:.35rem;">Manda pra gente</h2>',
    '  <p style="font-size:.78rem;color:var(--text-muted);margin-bottom:1.25rem;line-height:1.4;">O que você está achando? Ideia, problema ou só um elogio —<br>a gente lê tudo.</p>',
    '  <div class="field">',
    '    <label>Tipo</label>',
    '    <div id="fb-tipos" style="display:flex;gap:6px;flex-wrap:wrap;">',
    '      <button type="button" class="ig-pill active" data-tipo="sugestao" onclick="fbSelTipo(this)">Sugestão</button>',
    '      <button type="button" class="ig-pill" data-tipo="problema" onclick="fbSelTipo(this)">Problema</button>',
    '      <button type="button" class="ig-pill" data-tipo="elogio" onclick="fbSelTipo(this)">Elogio</button>',
    '      <button type="button" class="ig-pill" data-tipo="outro" onclick="fbSelTipo(this)">Outro</button>',
    '    </div>',
    '  </div>',
    '  <div class="field">',
    '    <label>Sua mensagem</label>',
    '    <textarea id="fb-msg" rows="5" placeholder="Conta pra gente com suas palavras…" style="width:100%;font-family:\'DM Sans\',sans-serif;font-size:.85rem;border:.5px solid var(--border-strong);border-radius:var(--radius);background:transparent;color:var(--text);outline:none;padding:.65rem .75rem;resize:vertical;line-height:1.5;"></textarea>',
    '  </div>',
    '  <div class="ma">',
    '    <button class="btn" onclick="fecharFeedback()">Cancelar</button>',
    '    <button class="btn primary" id="fb-enviar" onclick="enviarFeedback()">Enviar</button>',
    '  </div>',
    '</div></div>',
  ].join('');
  document.body.appendChild(el.firstElementChild);

  document.getElementById('ov-feedback').addEventListener('click', function(e){
    if(e.target === this) fecharFeedback();
  });

  // ── Funções globais ───────────────────────────────────────────────────────────
  window._fbTipo = 'sugestao';

  window.abrirFeedback = function(){
    window._fbTipo = 'sugestao';
    document.querySelectorAll('#fb-tipos .ig-pill').forEach(function(b){
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
    document.querySelectorAll('#fb-tipos .ig-pill').forEach(function(b){ b.classList.remove('active'); });
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
      var token = '';
      if(window._sb){
        var sessionR = await window._sb.auth.getSession();
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
