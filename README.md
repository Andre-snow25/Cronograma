# Calcula Marmitas

Aplicativo web para cálculo de custo e precificação de marmitas.

## Status atual

- [x] Interface (index.html) com abas Dashboard, Insumos, Receitas, Clientes
- [x] Cálculo de custo, % de lucro e preço de venda por receita
- [x] Schema do banco (supabase-schema.sql) com RLS revisado
- [ ] Conectar index.html ao Supabase (hoje roda com dados mockados em memória)
- [ ] Tela de lançar pedido (cliente + receita + quantidade)
- [ ] Campo de preço manual (sobrescreve o preço calculado pela % de lucro)
- [ ] Deploy no Vercel

## Estrutura

- `index.html` — aplicação (frontend)
- `supabase-schema.sql` — schema do banco, com RLS
- `.env.local.example` — modelo de variáveis de ambiente (Supabase)

## Como rodar localmente

Abra `index.html` direto no navegador (por enquanto sem persistência real).

## Configurar Supabase

1. Criar projeto em https://supabase.com
2. Rodar `supabase-schema.sql` no SQL Editor
3. Copiar a URL do projeto e a chave anon para dentro do `index.html` (ou variáveis de ambiente, quando migrarmos para build com Next.js/Vite)

## Deploy

GitHub → Vercel (import do repositório).
