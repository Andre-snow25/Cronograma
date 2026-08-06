-- Schema Supabase para Marmitas App

-- Tabela de insumos
CREATE TABLE insumos (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nome VARCHAR(255) NOT NULL,
  unidade VARCHAR(10) NOT NULL,
  qtd_embalagem NUMERIC NOT NULL,
  preco_embalagem NUMERIC NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_insumos_user_id ON insumos(user_id);

-- Tabela de receitas
CREATE TABLE receitas (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nome VARCHAR(255) NOT NULL,
  percentual_lucro NUMERIC DEFAULT 30,
  preco_venda_manual NUMERIC, -- se preenchido, sobrescreve o preço calculado pela % de lucro
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_receitas_user_id ON receitas(user_id);

-- Tabela de ingredientes por receita
CREATE TABLE receita_insumos (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  receita_id BIGINT NOT NULL REFERENCES receitas(id) ON DELETE CASCADE,
  insumo_id BIGINT NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  quantidade NUMERIC NOT NULL
);

CREATE INDEX idx_receita_insumos_receita_id ON receita_insumos(receita_id);

-- Tabela de clientes
CREATE TABLE clientes (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nome VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_clientes_user_id ON clientes(user_id);

-- Tabela de pedidos
CREATE TABLE pedidos (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  cliente_id BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  receita_id BIGINT NOT NULL REFERENCES receitas(id) ON DELETE CASCADE,
  quantidade NUMERIC NOT NULL,
  custo_unitario_no_pedido NUMERIC NOT NULL, -- custo da receita no momento da venda
  preco_unitario_no_pedido NUMERIC NOT NULL, -- preço cobrado no momento da venda
  data TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_pedidos_cliente_id ON pedidos(cliente_id);

-- Enable RLS
ALTER TABLE insumos ENABLE ROW LEVEL SECURITY;
ALTER TABLE receitas ENABLE ROW LEVEL SECURITY;
ALTER TABLE receita_insumos ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view own insumos" ON insumos FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own insumos" ON insumos FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own insumos" ON insumos FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own insumos" ON insumos FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "Users can view own receitas" ON receitas FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own receitas" ON receitas FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own receitas" ON receitas FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own receitas" ON receitas FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "Users can view own clientes" ON clientes FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own clientes" ON clientes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own clientes" ON clientes FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "Users can view own pedidos" ON pedidos FOR SELECT
  USING (EXISTS (SELECT 1 FROM clientes WHERE clientes.id = pedidos.cliente_id AND clientes.user_id = auth.uid()));
CREATE POLICY "Users can insert own pedidos" ON pedidos FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM clientes WHERE clientes.id = pedidos.cliente_id AND clientes.user_id = auth.uid()));
CREATE POLICY "Users can update own pedidos" ON pedidos FOR UPDATE
  USING (EXISTS (SELECT 1 FROM clientes WHERE clientes.id = pedidos.cliente_id AND clientes.user_id = auth.uid()));
CREATE POLICY "Users can delete own pedidos" ON pedidos FOR DELETE
  USING (EXISTS (SELECT 1 FROM clientes WHERE clientes.id = pedidos.cliente_id AND clientes.user_id = auth.uid()));

-- receita_insumos tinha RLS ativado sem NENHUMA política, o que bloqueava todo acesso.
-- Acesso liberado sempre que o usuário é dono da receita associada.
CREATE POLICY "Users can view own receita_insumos" ON receita_insumos FOR SELECT
  USING (EXISTS (SELECT 1 FROM receitas WHERE receitas.id = receita_insumos.receita_id AND receitas.user_id = auth.uid()));
CREATE POLICY "Users can insert own receita_insumos" ON receita_insumos FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM receitas WHERE receitas.id = receita_insumos.receita_id AND receitas.user_id = auth.uid()));
CREATE POLICY "Users can update own receita_insumos" ON receita_insumos FOR UPDATE
  USING (EXISTS (SELECT 1 FROM receitas WHERE receitas.id = receita_insumos.receita_id AND receitas.user_id = auth.uid()));
CREATE POLICY "Users can delete own receita_insumos" ON receita_insumos FOR DELETE
  USING (EXISTS (SELECT 1 FROM receitas WHERE receitas.id = receita_insumos.receita_id AND receitas.user_id = auth.uid()));

-- clientes também estava sem política de UPDATE
CREATE POLICY "Users can update own clientes" ON clientes FOR UPDATE USING (auth.uid() = user_id);
