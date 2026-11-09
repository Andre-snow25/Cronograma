// ===== CRONOGRAMAGAME =====
// Lei seca em fases, estilo Duolingo: importa o PDF de uma lei, separa os artigos em fases
// e o Claude (api/gerar-exercicios.js) cria os exercícios de cada fase.
// O texto da lei e os exercícios ficam em cronogramas/{uid}/game/{id} (o documento principal
// tem limite de 1 MiB); em e.game fica só o progresso: XP, vidas, ofensiva, avatar e fases.

const VIDAS_MAX = 5;
const VIDA_MS = 30 * 60 * 1000;          // 1 vida volta a cada 30 min
const XP_ACERTO = 10, XP_REPETIDA = 5, XP_FIM = 20, XP_PERFEITO = 15;
const CHARS_POR_FASE = 5000;
const EX_POR_LICAO = 10;
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs';
const AVATARES = [
  {em:'🐣', nivel:1,  nome:'Calouro'},
  {em:'🦊', nivel:2,  nome:'Esperto'},
  {em:'🐼', nivel:3,  nome:'Focado'},
  {em:'🦉', nivel:4,  nome:'Estudioso'},
  {em:'🐯', nivel:5,  nome:'Determinado'},
  {em:'👮', nivel:6,  nome:'Policial'},
  {em:'🦁', nivel:7,  nome:'Destemido'},
  {em:'⚖️', nivel:8,  nome:'Legalista'},
  {em:'🐉', nivel:10, nome:'Lendário'},
  {em:'🧑‍⚖️', nivel:12, nome:'Magistrado'},
];
const TIPOS = {
  lacuna:          {rotulo:'Complete a lacuna',        cor:'bg-sky-100 text-sky-700'},
  certo_errado:    {rotulo:'Certo ou errado?',         cor:'bg-amber-100 text-amber-700'},
  pegadinha:       {rotulo:'Cuidado com a pegadinha',  cor:'bg-rose-100 text-rose-700'},
  ordenar_incisos: {rotulo:'Coloque na ordem da lei',  cor:'bg-violet-100 text-violet-700'},
};

let ctx = null;
let leiAberta = null;   // id da lei aberta no mapa
let licao = null;       // lição em andamento

export function iniciarGame(contexto){
  ctx = contexto;
  Object.assign(window, {
    gmImportar, gmAbrirLei, gmFecharLei, gmExcluirLei, gmFase, gmIniciarFase, gmLerFase,
    gmAvatar, gmEscolherAvatar, gmEscolher, gmOrdenar, gmDesordenar, gmVerificar, gmContinuar, gmSair, gmFimLicao,
  });
}

// ---------- estado ----------
function g(){
  const e = ctx.estado();
  return e.game ||= {xp:0, vidas:VIDAS_MAX, vidasEm:null, ofensiva:{dias:0, ultimo:null}, avatar:'🐣', leis:[]};
}
const esc = s => ctx.escHtml(s);
function isoDe(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function hoje(){ return isoDe(new Date()); }
function ontem(){ const d = new Date(); d.setDate(d.getDate()-1); return isoDe(d); }
function atualizarVidas(){
  const G = g();
  if(G.vidas >= VIDAS_MAX){ G.vidas = VIDAS_MAX; G.vidasEm = null; return; }
  if(!G.vidasEm){ G.vidasEm = Date.now(); return; }
  const n = Math.floor((Date.now() - G.vidasEm) / VIDA_MS);
  if(n > 0){
    G.vidas = Math.min(VIDAS_MAX, G.vidas + n);
    G.vidasEm = G.vidas >= VIDAS_MAX ? null : G.vidasEm + n * VIDA_MS;
  }
}
function minutosProximaVida(){
  const G = g();
  if(G.vidas >= VIDAS_MAX || !G.vidasEm) return 0;
  return Math.max(1, Math.ceil((G.vidasEm + VIDA_MS - Date.now()) / 60000));
}
function ofensiva(){
  const o = g().ofensiva;
  return o.ultimo === hoje() || o.ultimo === ontem() ? o.dias : 0;
}
function nivelDe(xp){ return Math.floor(Math.sqrt(xp / 40)) + 1; }
function xpDoNivel(n){ return 40 * (n - 1) ** 2; }
function embaralhar(a){
  const b = a.slice();
  for(let i = b.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}
function lei(id){ return g().leis.find(l => l.id === id); }

// ---------- nuvem (subcoleção game) ----------
function ref(id){ return ctx.doc(ctx.db, 'cronogramas', ctx.uid(), 'game', id); }
const docFase = (leiId, i) => `${leiId}__f${i}`;
async function lerDoc(id){
  const s = await ctx.getDoc(ref(id));
  return s.exists() ? s.data() : null;
}
async function gravarDoc(id, dados){
  await ctx.setDoc(ref(id), JSON.parse(JSON.stringify(dados)));
}
function erroNuvem(err){
  console.error('CronogramaGame:', err);
  if(err?.code === 'permission-denied'){
    ctx.modal(`<h3 class="text-lg font-bold mb-2">🔒 Falta liberar o Game no Firebase</h3>
      <p class="text-sm text-gray-600 mb-3">O Firebase bloqueou a gravação. No console do Firebase → Firestore → <b>Regras</b>, acrescente este bloco junto dos outros e clique em <b>Publicar</b>:</p>
      <pre class="bg-gray-900 text-green-300 text-xs rounded-lg p-3 overflow-x-auto mb-4">match /cronogramas/{userId}/game/{doc} {
  allow read, write: if request.auth != null
    && request.auth.uid == userId;
}</pre>
      <button onclick="document.getElementById('modal-root').innerHTML=''" class="w-full bg-indigo-600 text-white rounded-lg py-2.5 font-semibold">Entendi</button>`);
    return;
  }
  ctx.ntf('❌ Erro ao acessar a nuvem: ' + (err?.message || err), 'er');
}

// ---------- PDF → artigos → fases ----------
async function textoDoPdf(arquivo, aoAvancar){
  const pdfjs = await import(PDFJS);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const pdf = await pdfjs.getDocument({data: await arquivo.arrayBuffer()}).promise;
  let out = '';
  for(let i = 1; i <= pdf.numPages; i++){
    const pg = await pdf.getPage(i);
    const tc = await pg.getTextContent();
    tc.items.forEach(it => { out += it.str + (it.hasEOL ? '\n' : ' '); });
    out += '\n';
    aoAvancar?.(i, pdf.numPages);
  }
  return out;
}
// "Art. 1º", "Art. 10.", "Art. 1.091-A", "Art. 5o" no começo da linha. As leis vêm em ordem
// crescente, então um "Art." com número menor que o anterior é citação, não artigo novo.
function separarArtigos(texto){
  const t = texto.replace(/\r/g, '').replace(/[ \t ]+/g, ' ');
  const re = /(?:^|\n) ?(?:Art\.|Artigo) ?(\d{1,3}(?:\.\d{3})*) ?([º°o])?\.? ?(?: ?- ?([A-Z]{1,2})\b)?/g;
  const marcas = [];
  let m, ultimo = -1;
  while((m = re.exec(t))){
    const num = parseInt(m[1].replace(/\./g, ''), 10);
    if(num < ultimo) continue;
    ultimo = num;
    marcas.push({ini: m.index + (t[m.index] === '\n' ? 1 : 0), num, letra: m[3] || ''});
  }
  return marcas.map((mk, i) => {
    const fim = i + 1 < marcas.length ? marcas[i + 1].ini : t.length;
    const texto = t.slice(mk.ini, fim).replace(/\n{2,}/g, '\n').replace(/ ?\n ?/g, '\n').trim();
    const numFmt = mk.num.toLocaleString('pt-BR');
    const rot = `Art. ${numFmt}${mk.num < 10 ? 'º' : ''}${mk.letra ? '-' + mk.letra : ''}`;
    return {rot, texto};
  }).filter(a => !(a.texto.length < 140 && /revogad|vetad/i.test(a.texto)));
}
function montarFases(artigos, porFase){
  const fases = [];
  let atual = [], chars = 0;
  artigos.forEach(a => {
    if(atual.length && (atual.length >= porFase || chars + a.texto.length > CHARS_POR_FASE)){
      fases.push(atual); atual = []; chars = 0;
    }
    atual.push({rot: a.rot, texto: a.texto.slice(0, 6000)});
    chars += Math.min(a.texto.length, 6000);
  });
  if(atual.length) fases.push(atual);
  return fases;
}
function rotuloFase(arts){
  return arts.length === 1 ? arts[0].rot : `${arts[0].rot} a ${arts[arts.length - 1].rot.replace(/^Art\. /, '')}`;
}

function gmImportar(){
  ctx.modal(`
    <h3 class="text-lg font-bold mb-1">📥 Nova lei</h3>
    <p class="text-sm text-gray-500 mb-3">Envie o PDF da lei (ex.: do site do Planalto) ou cole o texto. O app separa os artigos em fases; os exercícios de cada fase são criados pela IA quando você abrir a fase.</p>
    <label class="block text-sm font-semibold text-gray-700 mb-1">Nome da lei</label>
    <input id="gm-nome" placeholder="Ex: LC 207/79 – Lei Orgânica da PC/SP" class="w-full border-2 border-gray-300 rounded-lg p-2 text-sm mb-3 focus:border-indigo-500 focus:outline-none">
    <label class="inline-block bg-indigo-50 border-2 border-indigo-200 text-indigo-700 rounded-lg px-3 py-2 text-sm font-bold cursor-pointer hover:bg-indigo-100 mb-2">📄 Escolher PDF ou .txt
      <input id="gm-arquivo" type="file" accept=".pdf,.txt,application/pdf,text/plain" class="hidden">
    </label>
    <textarea id="gm-texto" rows="6" placeholder="...ou cole aqui o texto da lei (Art. 1º ... Art. 2º ...)" class="w-full border-2 border-gray-300 rounded-lg p-2 text-xs font-mono focus:border-indigo-500 focus:outline-none"></textarea>
    <div class="flex items-center gap-2 mt-2 text-sm">
      <label class="font-semibold text-gray-700">Artigos por fase:</label>
      <select id="gm-por" class="border-2 border-gray-300 rounded-lg px-2 py-1"><option>3</option><option selected>5</option><option>8</option></select>
    </div>
    <div id="gm-previa" class="text-sm text-gray-600 mt-3"></div>
    <div class="flex gap-3 mt-5">
      <button onclick="document.getElementById('modal-root').innerHTML=''" class="flex-1 border-2 border-gray-200 text-gray-600 rounded-lg py-2.5 font-semibold hover:bg-gray-50">Cancelar</button>
      <button id="gm-salvar" class="flex-1 bg-indigo-600 text-white rounded-lg py-2.5 font-semibold hover:bg-indigo-700">Criar fases</button>
    </div>`, 620);
  const $ = id => document.getElementById(id);
  let artigos = [];
  const previa = () => {
    artigos = separarArtigos($('gm-texto').value);
    const fases = montarFases(artigos, +$('gm-por').value);
    $('gm-previa').innerHTML = artigos.length
      ? `<p class="font-bold text-gray-700">✅ ${artigos.length} artigos · ${fases.length} fases <span class="font-normal text-gray-500">(${esc(artigos[0].rot)} até ${esc(artigos[artigos.length - 1].rot)})</span></p>`
      : ($('gm-texto').value.trim() ? '<p class="text-red-600">Não achei artigos. O texto precisa ter linhas começando com "Art. 1º", "Art. 2º"...</p>' : '');
  };
  $('gm-texto').addEventListener('input', previa);
  $('gm-por').addEventListener('change', previa);
  $('gm-arquivo').onchange = async ev => {
    const f = ev.target.files[0];
    if(!f) return;
    if(!$('gm-nome').value.trim()) $('gm-nome').value = f.name.replace(/\.[^.]+$/, '');
    if(/\.txt$/i.test(f.name) || f.type === 'text/plain'){ $('gm-texto').value = await f.text(); previa(); return; }
    $('gm-previa').innerHTML = '<p class="text-indigo-600">📄 Lendo o PDF...</p>';
    try{
      $('gm-texto').value = await textoDoPdf(f, (i, n) => { $('gm-previa').innerHTML = `<p class="text-indigo-600">📄 Lendo o PDF... página ${i} de ${n}</p>`; });
      previa();
      if(!artigos.length) $('gm-previa').innerHTML = '<p class="text-red-600">Não achei artigos no PDF. Se for um PDF escaneado (imagem), copie o texto da lei e cole na caixa.</p>';
    }catch(err){
      console.error(err);
      $('gm-previa').innerHTML = '<p class="text-red-600">Não consegui ler esse PDF. Tente copiar o texto da lei e colar na caixa.</p>';
    }
  };
  $('gm-salvar').onclick = async () => {
    const nome = $('gm-nome').value.trim();
    if(!nome){ ctx.ntf('❌ Dê um nome para a lei', 'er'); return; }
    if(!artigos.length){ ctx.ntf('❌ Envie o PDF ou cole o texto da lei', 'er'); return; }
    const fases = montarFases(artigos, +$('gm-por').value);
    const id = 'lei' + Date.now().toString(36);
    $('gm-salvar').disabled = true; $('gm-salvar').textContent = 'Salvando...';
    try{
      for(let i = 0; i < fases.length; i += 20){
        await Promise.all(fases.slice(i, i + 20).map((arts, k) => gravarDoc(docFase(id, i + k), {artigos: arts, exercicios: null})));
      }
    }catch(err){
      $('gm-salvar').disabled = false; $('gm-salvar').textContent = 'Criar fases';
      erroNuvem(err);
      return;
    }
    g().leis.push({id, nome, criada: new Date().toISOString(), nArt: artigos.length, fases: fases.map(arts => ({rot: rotuloFase(arts), est: 0}))});
    leiAberta = id;
    document.getElementById('modal-root').innerHTML = '';
    ctx.sv(); ctx.rend();
    ctx.ntf(`🎮 ${fases.length} fases criadas!`);
  };
}

function gmAbrirLei(id){ leiAberta = id; ctx.rend(); window.scrollTo({top: 0}); }
function gmFecharLei(){ leiAberta = null; ctx.rend(); }
async function gmExcluirLei(id){
  const L = lei(id);
  if(!L || !confirm(`Excluir "${L.nome}" e o progresso das ${L.fases.length} fases?`)) return;
  g().leis = g().leis.filter(x => x !== L);
  if(leiAberta === id) leiAberta = null;
  ctx.sv(); ctx.rend();
  L.fases.forEach((f, i) => ctx.deleteDoc(ref(docFase(id, i))).catch(() => {}));
}

// ---------- fase: painel, leitura e início ----------
function liberada(L, i){ return i === 0 || L.fases[i - 1].est > 0 || L.fases[i].est > 0; }
function estrelas(n, tam = ''){ return [1, 2, 3].map(k => `<span class="${tam} ${k <= n ? '' : 'opacity-25 grayscale'}">⭐</span>`).join(''); }
function gmFase(id, i){
  const L = lei(id), f = L && L.fases[i];
  if(!f) return;
  ctx.modal(`
    <p class="text-xs font-bold text-indigo-600 uppercase tracking-wide">${esc(L.nome)} · Fase ${i + 1}</p>
    <h3 class="text-xl font-bold mb-1">${esc(f.rot)}</h3>
    <div class="text-2xl mb-4">${estrelas(f.est)}</div>
    <button onclick="gmIniciarFase('${id}',${i})" class="w-full bg-green-500 hover:bg-green-600 text-white rounded-xl py-3 font-bold text-lg shadow-[0_4px_0_#15803d] mb-2">▶ ${f.est ? 'Praticar de novo' : 'Começar'}</button>
    <button onclick="gmLerFase('${id}',${i})" class="w-full border-2 border-gray-200 text-gray-700 rounded-xl py-2.5 font-bold hover:bg-gray-50 mb-2">📖 Ler os artigos antes</button>
    ${f.gerada ? `<button onclick="gmIniciarFase('${id}',${i},true)" class="w-full text-sm text-indigo-600 hover:underline font-semibold py-1">🔄 Criar exercícios novos para esta fase</button>` : ''}
    <button onclick="document.getElementById('modal-root').innerHTML=''" class="w-full text-sm text-gray-400 hover:text-gray-600 py-1">Fechar</button>`);
}
async function gmLerFase(id, i){
  try{
    const d = await lerDoc(docFase(id, i));
    ctx.modal(`
      <h3 class="text-lg font-bold mb-3">📖 ${esc(lei(id).fases[i].rot)}</h3>
      <div class="space-y-3 text-sm text-gray-800 max-h-[60vh] overflow-y-auto pr-1">${(d?.artigos || []).map(a => `<p class="whitespace-pre-line leading-relaxed">${esc(a.texto)}</p>`).join('')}</div>
      <div class="flex gap-3 mt-4">
        <button onclick="gmFase('${id}',${i})" class="flex-1 border-2 border-gray-200 text-gray-600 rounded-lg py-2.5 font-semibold">Voltar</button>
        <button onclick="gmIniciarFase('${id}',${i})" class="flex-1 bg-green-500 hover:bg-green-600 text-white rounded-lg py-2.5 font-bold">▶ Começar</button>
      </div>`, 680);
  }catch(err){ erroNuvem(err); }
}
async function gmIniciarFase(id, i, novos = false){
  const L = lei(id);
  if(!L) return;
  atualizarVidas();
  if(g().vidas <= 0){ ctx.ntf(`💔 Sem vidas. A próxima volta em ${minutosProximaVida()} min.`, 'warn'); return; }
  document.getElementById('modal-root').innerHTML = '';
  licao = {leiId: id, fase: i, carregando: true};
  ctx.rend();
  let d;
  try{
    d = await lerDoc(docFase(id, i));
    if(!d) throw new Error('Fase não encontrada na nuvem.');
    if(d.exercicios?.length && !L.fases[i].gerada){ L.fases[i].gerada = true; ctx.sv(); }
    if(novos || !d.exercicios?.length){
      const token = await ctx.auth.currentUser.getIdToken();
      const r = await fetch('/api/gerar-exercicios', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token},
        body: JSON.stringify({lei: L.nome, artigos: d.artigos}),
      });
      const resp = await r.json().catch(() => ({erro: 'Resposta inválida do servidor.'}));
      if(!r.ok) throw new Error(resp.erro || 'Erro ' + r.status);
      d.exercicios = resp.exercicios;
      await gravarDoc(docFase(id, i), d);
      L.fases[i].gerada = true;
      ctx.sv();
    }
  }catch(err){
    licao = null; ctx.rend();
    if(err?.code) erroNuvem(err); else ctx.ntf('❌ ' + (err.message || err), 'er');
    return;
  }
  if(licao?.leiId !== id || licao.fase !== i) return; // saiu enquanto carregava
  const fila = embaralhar(d.exercicios).slice(0, EX_POR_LICAO).map(x => preparar(x));
  licao = {leiId: id, fase: i, fila, idx: 0, erros: 0, xp: 0, estado: 'pergunta'};
  ctx.rend();
}
function preparar(x, repetida = false){
  const p = {...x, sel: null, ordem: [], repetida};
  if(x.tipo === 'ordenar_incisos'){
    let mist = embaralhar(x.itens.map((_, k) => k));
    if(mist.every((v, k) => v === k)) mist = mist.reverse();
    p.mistura = mist;
  }
  return p;
}

// ---------- lição ----------
function atual(){ return licao.fila[licao.idx]; }
function redesenharLicao(){
  const el = document.getElementById('game-licao');
  if(el) el.innerHTML = licaoHtml(); else ctx.rend();
}
function gmEscolher(v){ if(licao?.estado !== 'pergunta') return; atual().sel = v; redesenharLicao(); }
function gmOrdenar(k){ if(licao?.estado !== 'pergunta') return; const x = atual(); if(!x.ordem.includes(k)) x.ordem.push(k); redesenharLicao(); }
function gmDesordenar(k){ if(licao?.estado !== 'pergunta') return; const x = atual(); x.ordem = x.ordem.filter(v => v !== k); redesenharLicao(); }
function pronto(x){
  if(x.tipo === 'ordenar_incisos') return x.ordem.length === x.itens.length;
  return x.sel !== null;
}
function acertou(x){
  if(x.tipo === 'certo_errado') return x.sel === x.verdadeiro;
  if(x.tipo === 'ordenar_incisos') return x.ordem.every((v, k) => v === k);
  return x.sel === x.correta;
}
function gmVerificar(){
  const x = atual();
  if(licao?.estado !== 'pergunta' || !pronto(x)) return;
  x.ok = acertou(x);
  if(x.ok){
    licao.xp += x.repetida ? XP_REPETIDA : XP_ACERTO;
  } else {
    licao.erros++;
    const G = g();
    atualizarVidas();
    if(G.vidas >= VIDAS_MAX) G.vidasEm = Date.now();
    G.vidas = Math.max(0, G.vidas - 1);
    if(!x.repetida) licao.fila.push(preparar(x, true)); // a errada volta no fim da lição
    ctx.sv();
  }
  licao.estado = 'resposta';
  redesenharLicao();
}
function gmContinuar(){
  if(licao?.estado !== 'resposta') return;
  if(g().vidas <= 0){ licao.estado = 'semvidas'; finalizar(false); redesenharLicao(); return; }
  licao.idx++;
  if(licao.idx >= licao.fila.length){ finalizar(true); }
  else licao.estado = 'pergunta';
  redesenharLicao();
}
function finalizar(concluiu){
  const G = g(), L = lei(licao.leiId);
  if(concluiu){
    const est = licao.erros === 0 ? 3 : licao.erros <= 2 ? 2 : 1;
    licao.est = est;
    licao.xp += XP_FIM + (licao.erros === 0 ? XP_PERFEITO : 0);
    if(L) L.fases[licao.fase].est = Math.max(L.fases[licao.fase].est || 0, est);
    const o = G.ofensiva;
    if(o.ultimo !== hoje()){
      o.dias = o.ultimo === ontem() ? o.dias + 1 : 1;
      o.ultimo = hoje();
      licao.ofensivaSubiu = true;
    }
    licao.estado = 'fim';
  }
  licao.nivelAntes = nivelDe(G.xp);
  G.xp += licao.xp;
  ctx.sv();
}
function gmSair(){
  if(licao && licao.estado !== 'fim' && licao.estado !== 'semvidas' && !licao.carregando
     && !confirm('Sair da lição? O progresso desta lição será perdido.')) return;
  licao = null; ctx.rend();
}
function gmFimLicao(){ licao = null; ctx.rend(); }

function coracoes(){
  const v = g().vidas;
  return `<span class="font-bold text-rose-500 whitespace-nowrap" title="${v < VIDAS_MAX ? `Próxima vida em ${minutosProximaVida()} min` : 'Vidas cheias'}">❤️ ${v}</span>`;
}
function licaoHtml(){
  const L = lei(licao.leiId);
  if(licao.carregando) return `<div class="flex flex-col items-center justify-center py-20 text-center">
    <div class="text-6xl mb-4 animate-bounce">${g().avatar}</div>
    <p class="font-bold text-gray-700">Preparando a fase ${licao.fase + 1}...</p>
    <p class="text-sm text-gray-500 mt-1">Na primeira vez a IA cria os exercícios (leva uns segundos).</p>
    <button onclick="gmSair()" class="mt-6 text-sm text-gray-400 hover:text-gray-600">Cancelar</button>
  </div>`;

  if(licao.estado === 'fim' || licao.estado === 'semvidas'){
    const ok = licao.estado === 'fim';
    const subiu = nivelDe(g().xp) > licao.nivelAntes;
    return `<div class="max-w-md mx-auto text-center py-10">
      <div class="text-7xl mb-3">${ok ? (licao.erros === 0 ? '🏆' : '🎉') : '💔'}</div>
      <h3 class="text-2xl font-bold mb-1">${ok ? (licao.erros === 0 ? 'Perfeito!' : 'Fase concluída!') : 'Acabaram as vidas'}</h3>
      <p class="text-gray-500 mb-5">${esc(L?.fases[licao.fase]?.rot || '')}</p>
      ${ok ? `<div class="text-4xl mb-5">${estrelas(licao.est)}</div>` : `<p class="text-sm text-gray-600 mb-5">A fase não foi concluída. Uma vida volta a cada 30 minutos — aproveite para ler os artigos.</p>`}
      <div class="grid grid-cols-2 gap-3 mb-6">
        <div class="bg-amber-50 border-2 border-amber-200 rounded-xl p-3"><p class="text-xs font-bold text-amber-700">XP GANHO</p><p class="text-2xl font-bold text-amber-600">+${licao.xp}</p></div>
        <div class="bg-orange-50 border-2 border-orange-200 rounded-xl p-3"><p class="text-xs font-bold text-orange-700">OFENSIVA</p><p class="text-2xl font-bold text-orange-600">🔥 ${ofensiva()}</p>${licao.ofensivaSubiu ? '<p class="text-xs text-orange-600 font-bold">+1 hoje!</p>' : ''}</div>
      </div>
      ${subiu ? `<p class="bg-indigo-50 border-2 border-indigo-200 rounded-xl p-3 mb-6 font-bold text-indigo-700">⬆️ Você chegou ao nível ${nivelDe(g().xp)}!</p>` : ''}
      <button onclick="gmFimLicao()" class="w-full bg-green-500 hover:bg-green-600 text-white rounded-xl py-3 font-bold text-lg shadow-[0_4px_0_#15803d]">Continuar</button>
    </div>`;
  }

  const x = atual();
  const total = licao.fila.length;
  const pct = Math.round(licao.idx / total * 100);
  const tipo = TIPOS[x.tipo];
  const resp = licao.estado === 'resposta';
  let corpo = '';
  const btnOpcao = (rotulo, valor, selecionada, certa) => {
    let cls = 'border-gray-200 bg-white hover:bg-gray-50 shadow-[0_3px_0_#e5e7eb]';
    if(resp && certa) cls = 'border-green-400 bg-green-50 text-green-800';
    else if(resp && selecionada) cls = 'border-rose-400 bg-rose-50 text-rose-800';
    else if(selecionada) cls = 'border-sky-400 bg-sky-50 text-sky-800 shadow-[0_3px_0_#7dd3fc]';
    return `<button onclick="gmEscolher(${valor})" ${resp ? 'disabled' : ''} class="w-full text-left border-2 ${cls} rounded-xl px-4 py-3 font-semibold transition-all">${rotulo}</button>`;
  };
  if(x.tipo === 'lacuna'){
    const escolhida = x.sel !== null ? x.opcoes[x.sel] : null;
    const lacuna = `<span class="inline-block min-w-[90px] border-b-2 ${escolhida ? 'border-sky-400 text-sky-700 font-bold' : 'border-gray-400'} px-1 mx-1">${escolhida ? esc(escolhida) : '&nbsp;'}</span>`;
    corpo = `<p class="text-lg leading-relaxed mb-6">${esc(x.enunciado).replace('____', lacuna)}</p>
      <div class="flex flex-wrap gap-2">${x.opcoes.map((o, k) => {
        const sel = x.sel === k, certa = resp && k === x.correta;
        const cls = resp && certa ? 'border-green-400 bg-green-50 text-green-800' : resp && sel ? 'border-rose-400 bg-rose-50 text-rose-800' : sel ? 'border-sky-400 bg-sky-50 text-sky-800' : 'border-gray-200 bg-white hover:bg-gray-50';
        return `<button onclick="gmEscolher(${k})" ${resp ? 'disabled' : ''} class="border-2 ${cls} rounded-xl px-4 py-2 font-semibold shadow-[0_3px_0_#e5e7eb]">${esc(o)}</button>`;
      }).join('')}</div>`;
  } else if(x.tipo === 'certo_errado'){
    corpo = `<p class="text-lg leading-relaxed mb-6 bg-gray-50 border-l-4 border-amber-300 rounded-r-lg p-4">${esc(x.enunciado)}</p>
      <div class="grid grid-cols-2 gap-3">${btnOpcao('✅ Certo', true, x.sel === true, resp && x.verdadeiro)}${btnOpcao('❌ Errado', false, x.sel === false, resp && !x.verdadeiro)}</div>`;
  } else if(x.tipo === 'pegadinha'){
    corpo = `<p class="text-lg leading-relaxed mb-5">${esc(x.enunciado)}</p>
      <div class="space-y-2">${x.opcoes.map((o, k) => btnOpcao(`<span class="text-gray-400 mr-2">${'ABCDE'[k]}</span>${esc(o)}`, k, x.sel === k, resp && k === x.correta)).join('')}</div>`;
  } else {
    const montado = x.ordem.map((k, pos) => {
      const cor = resp ? (k === pos ? 'border-green-400 bg-green-50' : 'border-rose-400 bg-rose-50') : 'border-violet-300 bg-violet-50';
      return `<button onclick="gmDesordenar(${k})" ${resp ? 'disabled' : ''} class="w-full text-left border-2 ${cor} rounded-xl px-3 py-2 text-sm font-semibold"><span class="text-violet-500 mr-2">${pos + 1}.</span>${esc(x.itens[k])}</button>`;
    }).join('');
    corpo = `<p class="text-lg leading-relaxed mb-4">${esc(x.enunciado)}</p>
      <div class="min-h-[60px] border-2 border-dashed border-violet-200 rounded-xl p-2 space-y-2 mb-4">${montado || '<p class="text-sm text-gray-400 text-center py-3">Toque nos itens abaixo na ordem em que aparecem na lei</p>'}</div>
      <div class="space-y-2">${x.mistura.filter(k => !x.ordem.includes(k)).map(k => `<button onclick="gmOrdenar(${k})" class="w-full text-left border-2 border-gray-200 bg-white hover:bg-gray-50 rounded-xl px-3 py-2 text-sm font-semibold shadow-[0_3px_0_#e5e7eb]">${esc(x.itens[k])}</button>`).join('')}</div>
      ${resp && !x.ok ? `<div class="mt-4 text-sm"><p class="font-bold text-green-700 mb-1">Ordem certa:</p><ol class="list-decimal ml-5 space-y-0.5 text-gray-700">${x.itens.map(i => `<li>${esc(i)}</li>`).join('')}</ol></div>` : ''}`;
  }

  const rodape = resp
    ? `<div class="${x.ok ? 'bg-green-100 border-green-300' : 'bg-rose-100 border-rose-300'} border-t-2 rounded-b-2xl px-5 py-4 -mx-5 -mb-5 mt-6">
        <p class="font-bold text-lg ${x.ok ? 'text-green-700' : 'text-rose-700'} mb-1">${x.ok ? '✅ Isso aí!' : '❌ Não foi dessa vez'}</p>
        ${x.explicacao ? `<p class="text-sm ${x.ok ? 'text-green-800' : 'text-rose-800'} mb-3">${esc(x.explicacao)}</p>` : ''}
        <button onclick="gmContinuar()" class="w-full ${x.ok ? 'bg-green-500 hover:bg-green-600 shadow-[0_4px_0_#15803d]' : 'bg-rose-500 hover:bg-rose-600 shadow-[0_4px_0_#be123c]'} text-white rounded-xl py-3 font-bold">Continuar</button>
      </div>`
    : `<button onclick="gmVerificar()" ${pronto(x) ? '' : 'disabled'} class="w-full mt-6 rounded-xl py-3 font-bold text-white ${pronto(x) ? 'bg-green-500 hover:bg-green-600 shadow-[0_4px_0_#15803d]' : 'bg-gray-300 cursor-not-allowed'}">Verificar</button>`;

  return `<div class="max-w-2xl mx-auto">
    <div class="flex items-center gap-3 mb-5">
      <button onclick="gmSair()" class="text-gray-400 hover:text-gray-700 text-2xl leading-none" title="Sair">✕</button>
      <div class="flex-1 bg-gray-200 rounded-full h-4 overflow-hidden"><div class="bg-green-500 h-4 rounded-full transition-all" style="width:${pct}%"></div></div>
      ${coracoes()}
    </div>
    <div class="bg-white border-2 border-gray-100 rounded-2xl p-5 shadow-sm">
      <div class="flex items-center gap-2 mb-4 flex-wrap">
        <span class="${tipo.cor} text-xs font-bold px-2.5 py-1 rounded-full">${tipo.rotulo}</span>
        ${x.artigo ? `<span class="text-xs text-gray-400 font-bold">${esc(x.artigo)}</span>` : ''}
        ${x.repetida ? '<span class="text-xs text-rose-500 font-bold">↻ revendo um erro</span>' : ''}
      </div>
      ${corpo}
      ${rodape}
    </div>
  </div>`;
}

// ---------- avatar ----------
function gmAvatar(){
  const nv = nivelDe(g().xp);
  ctx.modal(`
    <h3 class="text-lg font-bold mb-1">Escolha seu avatar</h3>
    <p class="text-sm text-gray-500 mb-4">Novos avatares liberam conforme você sobe de nível (você está no nível ${nv}).</p>
    <div class="grid grid-cols-5 gap-2 mb-4">${AVATARES.map(a => {
      const livre = nv >= a.nivel, sel = g().avatar === a.em;
      return `<button ${livre ? `onclick="gmEscolherAvatar('${a.em}')"` : 'disabled'} title="${esc(a.nome)}${livre ? '' : ' — nível ' + a.nivel}" class="aspect-square rounded-xl border-2 text-3xl flex flex-col items-center justify-center ${sel ? 'border-indigo-500 bg-indigo-50' : livre ? 'border-gray-200 hover:bg-gray-50' : 'border-gray-100 bg-gray-50'}">
        <span class="${livre ? '' : 'opacity-30 grayscale'}">${a.em}</span>${livre ? '' : `<span class="text-[10px] font-bold text-gray-400">🔒 nv ${a.nivel}</span>`}</button>`;
    }).join('')}</div>
    <button onclick="document.getElementById('modal-root').innerHTML=''" class="w-full border-2 border-gray-200 text-gray-600 rounded-lg py-2.5 font-semibold">Fechar</button>`, 460);
}
function gmEscolherAvatar(em){
  g().avatar = em;
  document.getElementById('modal-root').innerHTML = '';
  ctx.sv(); ctx.rend();
}

// ---------- telas ----------
function painelHtml(){
  const G = g(), nv = nivelDe(G.xp);
  const ini = xpDoNivel(nv), prox = xpDoNivel(nv + 1);
  const pct = Math.round((G.xp - ini) / (prox - ini) * 100);
  const av = AVATARES.filter(a => a.nivel <= nv).pop();
  return `<div class="flex items-center gap-4 flex-wrap bg-gradient-to-r from-indigo-50 to-sky-50 border-2 border-indigo-100 rounded-2xl p-4 mb-6">
    <button onclick="gmAvatar()" title="Trocar avatar" class="w-16 h-16 rounded-full bg-white border-4 border-indigo-200 text-4xl flex items-center justify-center hover:scale-105 transition-transform">${G.avatar}</button>
    <div class="flex-1 min-w-[180px]">
      <p class="font-bold text-gray-800">Nível ${nv} <span class="text-sm font-normal text-gray-500">· ${esc(av.nome)}</span></p>
      <div class="bg-white rounded-full h-3 overflow-hidden mt-1 border border-indigo-100"><div class="bg-amber-400 h-3 rounded-full" style="width:${pct}%"></div></div>
      <p class="text-xs text-gray-500 mt-1">${G.xp - ini} / ${prox - ini} XP para o nível ${nv + 1}</p>
    </div>
    <div class="flex gap-4 text-lg">
      <span class="font-bold text-orange-500" title="Ofensiva: dias seguidos com pelo menos uma fase concluída">🔥 ${ofensiva()}</span>
      <span class="font-bold text-amber-500" title="XP total">⭐ ${G.xp}</span>
      ${coracoes()}
    </div>
  </div>
  ${G.vidas < VIDAS_MAX ? `<p class="text-xs text-rose-500 -mt-4 mb-5 text-right">Próxima vida em ${minutosProximaVida()} min</p>` : ''}`;
}
function mapaHtml(L){
  const feitas = L.fases.filter(f => f.est > 0).length;
  const desloc = [0, 48, 72, 48, 0, -48, -72, -48];
  const proxima = L.fases.findIndex(f => !f.est);
  return `<div class="flex items-center gap-3 mb-2 flex-wrap">
    <button onclick="gmFecharLei()" class="bg-gray-200 hover:bg-gray-300 text-gray-700 px-3 py-2 rounded-lg text-sm font-bold">← Leis</button>
    <h3 class="text-xl font-bold flex-1 break-words">⚖️ ${esc(L.nome)}</h3>
    <button onclick="gmExcluirLei('${L.id}')" class="text-sm text-red-500 hover:text-red-700 font-bold">🗑️ Excluir</button>
  </div>
  <p class="text-sm text-gray-500 mb-6">${feitas} de ${L.fases.length} fases concluídas · ${L.nArt} artigos. Toque numa fase para começar.</p>
  <div class="flex flex-col items-center gap-5 pb-8">
    ${L.fases.map((f, i) => {
      const livre = liberada(L, i), atualF = i === proxima;
      const cor = f.est ? 'bg-amber-400 shadow-[0_6px_0_#d97706]' : livre ? 'bg-green-500 shadow-[0_6px_0_#15803d]' : 'bg-gray-300 shadow-[0_6px_0_#9ca3af]';
      return `<div class="flex flex-col items-center" style="transform:translateX(${desloc[i % desloc.length]}px)">
        ${atualF && livre ? `<span class="text-xs font-bold text-green-700 bg-white border-2 border-green-300 rounded-lg px-2 py-0.5 mb-1 animate-bounce">COMEÇAR</span>` : ''}
        <button ${livre ? `onclick="gmFase('${L.id}',${i})"` : 'disabled'} title="${esc(f.rot)}" class="w-16 h-16 rounded-full ${cor} text-white text-xl font-bold flex items-center justify-center ${livre ? 'hover:brightness-110 active:translate-y-1' : 'cursor-not-allowed'}">${livre ? (f.est ? '★' : i + 1) : '🔒'}</button>
        <p class="text-[11px] text-gray-500 mt-2 max-w-[140px] text-center leading-tight">${esc(f.rot)}</p>
        ${f.est ? `<div class="text-xs">${estrelas(f.est)}</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}
function listaHtml(){
  const leis = g().leis;
  return `<div class="flex items-center gap-3 mb-4 flex-wrap">
    <h3 class="text-xl font-bold flex-1">📚 Suas leis</h3>
    <button onclick="gmImportar()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-bold">+ Nova lei (PDF)</button>
  </div>
  ${leis.length === 0 ? `<div class="text-center py-14 bg-gray-50 rounded-2xl">
    <div class="text-6xl mb-3">⚖️</div>
    <p class="font-bold text-gray-700">Nenhuma lei ainda</p>
    <p class="text-sm text-gray-500 mt-1 mb-4">Envie o PDF de uma lei e estude a lei seca em fases curtas, com exercícios criados pela IA.</p>
    <button onclick="gmImportar()" class="bg-green-500 hover:bg-green-600 text-white px-6 py-3 rounded-xl font-bold shadow-[0_4px_0_#15803d]">📥 Importar minha primeira lei</button>
  </div>` : `<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">${leis.map(L => {
    const feitas = L.fases.filter(f => f.est > 0).length;
    const pct = Math.round(feitas / L.fases.length * 100);
    const est = L.fases.reduce((s, f) => s + (f.est || 0), 0);
    return `<button onclick="gmAbrirLei('${L.id}')" class="text-left bg-white border-2 border-gray-200 hover:border-indigo-300 hover:shadow-lg rounded-2xl p-4 transition-all">
      <p class="font-bold text-gray-800 break-words mb-1">⚖️ ${esc(L.nome)}</p>
      <p class="text-xs text-gray-500 mb-3">${L.nArt} artigos · ${L.fases.length} fases · ⭐ ${est}/${L.fases.length * 3}</p>
      <div class="bg-gray-100 rounded-full h-2.5 overflow-hidden"><div class="bg-green-500 h-2.5 rounded-full" style="width:${pct}%"></div></div>
      <p class="text-xs text-gray-400 mt-1">${pct}% concluído</p>
    </button>`;
  }).join('')}</div>`}`;
}

export function renderGame(){
  if(!ctx) return '';
  atualizarVidas();
  if(licao) return `<div id="game-licao">${licaoHtml()}</div>`;
  const L = leiAberta && lei(leiAberta);
  if(!L) leiAberta = null;
  return `<h2 class="text-2xl font-bold mb-4">🎮 CronogramaGame <span class="text-sm font-normal text-gray-500">· lei seca em fases</span></h2>
  ${painelHtml()}
  ${L ? mapaHtml(L) : listaHtml()}`;
}
