// Função serverless da Vercel: baixa a página de uma lei no site do Planalto (CronogramaGame).
// O navegador não consegue buscar direto (o Planalto bloqueia), então o servidor busca e devolve
// o HTML; quem separa os artigos e tira o texto riscado (revogado) é o app.
// Só aceita endereços do Planalto (planalto.gov.br) ou da ALESP (al.sp.gov.br) e usuários logados no Firebase do app.

const FIREBASE_API_KEY = 'AIzaSyD2d9bFtE-29MegN1xG9NOf776Rx8Lfgrs';
const MAX_BYTES = 4 * 1024 * 1024;

async function usuarioLogado(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: token }),
  });
  return r.ok;
}

// As páginas do Planalto costumam vir em windows-1252; algumas em UTF-8
function decodificar(buf, contentType) {
  const doCabecalho = /charset=([\w-]+)/i.exec(contentType || '')?.[1];
  const inicio = new TextDecoder('latin1').decode(buf.slice(0, 4096));
  const doMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(inicio)?.[1];
  const charset = (doCabecalho || doMeta || '').toLowerCase();
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try { return new TextDecoder(charset === 'iso-8859-1' ? 'windows-1252' : charset).decode(buf); } catch {}
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use POST' });

  try {
    if (!(await usuarioLogado(req))) return res.status(401).json({ erro: 'Faça login novamente.' });
  } catch {
    return res.status(503).json({ erro: 'Não foi possível validar o login.' });
  }

  let url;
  try {
    url = new URL(String(req.body?.url || '').trim().replace(/^(?!https?:\/\/)/i, 'https://'));
  } catch {
    return res.status(400).json({ erro: 'Endereço inválido.' });
  }
  const site = SITES.find(s => s.host.test(url.hostname));
  if (!/^https?:$/.test(url.protocol) || !site) {
    return res.status(400).json({ erro: 'Use um endereço do Planalto (planalto.gov.br) ou da ALESP (al.sp.gov.br).' });
  }
  url.protocol = 'https:';
  url.search = ''; // tira rastreadores como ?utm_source=...

  try {
    // ALESP: o endereço comum é o texto original; a versão atualizada fica em "compilacao-..."
    for (const alvo of site.versoes(url)) {
      const r = await fetch(alvo, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) { if (alvo !== url.href) continue; return res.status(502).json({ erro: `O site ${site.nome} respondeu com erro ${r.status}.` }); }
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > MAX_BYTES) return res.status(413).json({ erro: 'Página grande demais.' });
      return res.status(200).json({ html: decodificar(buf, r.headers.get('content-type')), url: r.url || alvo, atualizada: alvo !== url.href });
    }
  } catch (err) {
    console.error(`Erro ao buscar no site ${site.nome}:`, err);
    return res.status(502).json({ erro: `Não consegui acessar o site ${site.nome} agora. Tente de novo mais tarde ou salve a página (Ctrl+S) e envie o arquivo .htm.` });
  }
}

const SITES = [
  { nome: 'do Planalto', host: /(^|\.)planalto\.gov\.br$/i, versoes: u => [u.href] },
  {
    nome: 'da ALESP', host: /(^|\.)al\.sp\.gov\.br$/i,
    versoes: u => {
      const m = /^(.*\/)([^/]+\.html?)$/i.exec(u.pathname);
      if (!m || /^compilacao-/i.test(m[2]) || !/\/repositorio\/legislacao\//i.test(u.pathname)) return [u.href];
      return [`${u.origin}${m[1]}compilacao-${m[2]}`, u.href];
    },
  },
];
