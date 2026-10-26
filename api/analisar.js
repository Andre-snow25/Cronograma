// Função serverless da Vercel: analisa uma questão errada com o Claude.
// A chave fica na variável de ambiente ANTHROPIC_API_KEY (configurada na Vercel),
// nunca no navegador. Só aceita usuários logados no Firebase do app.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const FIREBASE_API_KEY = 'AIzaSyD2d9bFtE-29MegN1xG9NOf776Rx8Lfgrs';
const MAX_CARACTERES = 6000;

const client = new Anthropic();

const Analise = z.object({
  assunto: z.string().describe('Assunto específico dentro da matéria que a questão cobra, do geral ao específico, níveis separados por " → ". O 1º nível é um tema amplo da matéria (agrupa vários erros), o 2º um subtema. Ex: "Crimes contra a Administração Pública → Peculato → Peculato culposo"'),
  motivo_erro: z.string().describe('Por que a alternativa marcada pelo aluno está errada (ou o provável motivo do erro), em 1 a 3 frases'),
  revisar: z.array(z.string()).describe('2 a 4 tópicos curtos e objetivos para revisar'),
});

const SYSTEM = `Você é um professor de cursinho para concursos públicos no Brasil.
O aluno errou uma questão e quer saber exatamente qual assunto precisa reforçar dentro da matéria informada.
Seja direto e específico (nada genérico como "estudar mais a matéria"). Responda em português do Brasil.
Se faltar informação (ex: gabarito não informado), deduza o gabarito mais provável e diga isso no motivo do erro.`;

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use POST' });

  try {
    if (!(await usuarioLogado(req))) return res.status(401).json({ erro: 'Faça login novamente.' });
  } catch {
    return res.status(503).json({ erro: 'Não foi possível validar o login.' });
  }

  const { materia = '', questao = '', resposta = '', gabarito = '' } = req.body || {};
  // Temas (1º nível do assunto) já usados nesta matéria, para a IA reaproveitar o mesmo
  // nome e o ranking "Temas que você mais erra" agrupar os erros de verdade.
  const temas = (Array.isArray(req.body?.temas) ? req.body.temas : [])
    .filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().slice(0, 120)).slice(0, 40);
  if (!questao.trim()) return res.status(400).json({ erro: 'Cole o enunciado da questão.' });
  if ((questao + resposta + gabarito).length > MAX_CARACTERES) {
    return res.status(400).json({ erro: `Questão muito longa (máx. ${MAX_CARACTERES} caracteres).` });
  }

  const prompt = `Matéria: ${materia}

Questão:
${questao}

Alternativa que marquei: ${resposta || '(não informada)'}
Gabarito: ${gabarito || '(não informado)'}${temas.length ? `

Temas já usados nesta matéria (1º nível do assunto): ${temas.join(' | ')}
Se a questão se encaixar em um deles, comece o assunto com exatamente o mesmo nome; só crie um tema novo se nenhum servir.` : ''}`;

  try {
    const response = await client.messages.parse({
      model: 'claude-haiku-5-5',
      max_tokens: 2000,
      system: SYSTEM,
      output_config: { effort: 'low', format: zodOutputFormat(Analise) },
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.stop_reason === 'refusal') return res.status(422).json({ erro: 'A IA não conseguiu analisar esta questão.' });
    if (!response.parsed_output) return res.status(502).json({ erro: 'Resposta inválida da IA. Tente de novo.' });
    return res.status(200).json(response.parsed_output);
  } catch (err) {
    console.error('Erro na API do Claude:', err);
    if (err instanceof Anthropic.AuthenticationError) return res.status(500).json({ erro: 'Chave da API inválida (ANTHROPIC_API_KEY).' });
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ erro: 'Muitas análises seguidas. Aguarde um pouco.' });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ erro: 'Erro na IA: ' + err.message });
    return res.status(500).json({ erro: 'Erro inesperado na análise: ' + (err?.message || err) });
  }
}
