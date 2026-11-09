// Função serverless da Vercel: gera exercícios de lei seca (CronogramaGame) com o Claude.
// Mesmo modelo de segurança do analisar.js: a chave fica em ANTHROPIC_API_KEY na Vercel
// e só usuários logados no Firebase do app podem chamar.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const FIREBASE_API_KEY = 'AIzaSyD2d9bFtE-29MegN1xG9NOf776Rx8Lfgrs';
const MAX_CARACTERES = 15000;
const MAX_ARTIGOS = 15;

const client = new Anthropic();

const Exercicio = z.object({
  tipo: z.enum(['lacuna', 'certo_errado', 'pegadinha', 'ordenar_incisos']),
  artigo: z.string().describe('Rótulo do artigo de onde saiu o exercício, ex: "Art. 5º"'),
  enunciado: z.string().describe('lacuna: trecho literal do artigo com UMA palavra ou expressão-chave trocada por "____". certo_errado: afirmação sobre o artigo. pegadinha: pergunta, ex: "De acordo com o art. 12, assinale a alternativa correta". ordenar_incisos: instrução, ex: "Coloque os incisos do art. 5º na ordem da lei"'),
  opcoes: z.array(z.string()).describe('lacuna: 3 ou 4 opções curtas para a lacuna (a certa e distratores plausíveis). pegadinha: 4 alternativas completas. Outros tipos: lista vazia'),
  correta: z.number().int().describe('lacuna e pegadinha: índice (começando em 0) da opção certa. Outros tipos: 0'),
  verdadeiro: z.boolean().describe('certo_errado: true se a afirmação está CERTA conforme o texto da lei. Outros tipos: false'),
  itens: z.array(z.string()).describe('ordenar_incisos: 3 a 6 incisos ou parágrafos NA ORDEM EM QUE APARECEM NA LEI, cada um resumido em até 15 palavras e SEM o número/romano. Outros tipos: lista vazia'),
  explicacao: z.string().describe('1 ou 2 frases explicando a resposta com base no que a lei diz'),
});
const Saida = z.object({ exercicios: z.array(Exercicio) });

const SYSTEM = `Você cria exercícios de "lei seca" para concursos públicos no Brasil (estilo VUNESP, FCC e Cebraspe).
Use SOMENTE o texto dos artigos fornecidos: nada de doutrina ou jurisprudência, e nunca invente regra que não está no texto.
Crie 10 exercícios variados, cobrindo os artigos da fase:
- cerca de 3 "lacuna": copie um trecho literal e troque por "____" a palavra que a banca costuma trocar (prazo, número, autoridade competente, "poderá"/"deverá", "salvo", "vedado", "somente"). Os distratores devem ser plausíveis.
- cerca de 3 "certo_errado": misture afirmações certas e erradas. As erradas mudam um detalhe da lei (prazo, quem faz, exceção, palavra restritiva).
- cerca de 2 "pegadinha": 4 alternativas, só uma reproduz a lei corretamente; as outras são as pegadinhas típicas de banca.
- 1 ou 2 "ordenar_incisos": só quando algum artigo tiver pelo menos 3 incisos ou parágrafos; se não tiver, faça mais exercícios dos outros tipos.
Escreva em português do Brasil, com frases curtas e claras.`;

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

// Descarta exercício mal formado e devolve só os campos que o tipo usa
function limpar(x) {
  const base = { tipo: x.tipo, artigo: x.artigo.trim(), enunciado: x.enunciado.trim(), explicacao: x.explicacao.trim() };
  const opcoes = x.opcoes.map(o => o.trim()).filter(Boolean);
  if ((x.tipo === 'lacuna' || x.tipo === 'pegadinha') && opcoes.length === x.opcoes.length && opcoes.length >= 2 && x.correta >= 0 && x.correta < opcoes.length) {
    if (x.tipo === 'lacuna' && !base.enunciado.includes('____')) return null;
    return { ...base, opcoes, correta: x.correta };
  }
  if (x.tipo === 'certo_errado' && base.enunciado) return { ...base, verdadeiro: x.verdadeiro };
  if (x.tipo === 'ordenar_incisos') {
    const itens = x.itens.map(i => i.trim()).filter(Boolean);
    if (itens.length >= 3) return { ...base, itens };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use POST' });

  try {
    if (!(await usuarioLogado(req))) return res.status(401).json({ erro: 'Faça login novamente.' });
  } catch {
    return res.status(503).json({ erro: 'Não foi possível validar o login.' });
  }

  const lei = String(req.body?.lei || '').slice(0, 120);
  const artigos = (Array.isArray(req.body?.artigos) ? req.body.artigos : [])
    .filter(a => a && typeof a.texto === 'string' && a.texto.trim())
    .slice(0, MAX_ARTIGOS)
    .map(a => ({ rot: String(a.rot || '').slice(0, 40), texto: a.texto.trim() }));
  if (!artigos.length) return res.status(400).json({ erro: 'Nenhum artigo enviado.' });
  const texto = artigos.map(a => a.texto).join('\n\n');
  if (texto.length > MAX_CARACTERES) return res.status(400).json({ erro: `Fase muito longa (máx. ${MAX_CARACTERES} caracteres).` });

  const prompt = `Lei: ${lei || '(não informada)'}

Artigos desta fase:

${texto}`;

  try {
    const response = await client.messages.parse({
      model: 'claude-haiku-5-5',
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { effort: 'low', format: zodOutputFormat(Saida) },
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.stop_reason === 'refusal') return res.status(422).json({ erro: 'A IA não conseguiu criar exercícios para estes artigos.' });
    if (!response.parsed_output) return res.status(502).json({ erro: 'Resposta inválida da IA. Tente de novo.' });
    const exercicios = response.parsed_output.exercicios.map(limpar).filter(Boolean);
    if (!exercicios.length) return res.status(502).json({ erro: 'A IA não gerou exercícios válidos. Tente de novo.' });
    return res.status(200).json({ exercicios });
  } catch (err) {
    console.error('Erro na API do Claude:', err);
    if (err instanceof Anthropic.AuthenticationError) return res.status(500).json({ erro: 'Chave da API inválida (ANTHROPIC_API_KEY).' });
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ erro: 'Muitos pedidos seguidos. Aguarde um pouco.' });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ erro: 'Erro na IA: ' + err.message });
    return res.status(500).json({ erro: 'Erro inesperado: ' + (err?.message || err) });
  }
}
