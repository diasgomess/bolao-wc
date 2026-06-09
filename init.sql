-- =============================================================================
-- BolãoFort - Schema inicial para Supabase (PostgreSQL)
-- Tabelas: usuarios, partidas, palpites + view ranking + lógica de pontuação
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tabela: usuarios
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome       VARCHAR(100) NOT NULL UNIQUE,
    criado_em  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- Tabela: partidas
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partidas (
    id              INT PRIMARY KEY,
    time_casa       VARCHAR(50)  NOT NULL,
    time_fora       VARCHAR(50)  NOT NULL,
    data_hora_jogo  TIMESTAMPTZ  NOT NULL,
    gols_casa       INT,
    gols_fora       INT,
    status          VARCHAR(20)  NOT NULL DEFAULT 'SCHEDULED'
);

-- -----------------------------------------------------------------------------
-- Tabela: palpites
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS palpites (
    id                  BIGSERIAL PRIMARY KEY,
    usuario_id          UUID        NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    partida_id          INT         NOT NULL REFERENCES partidas(id) ON DELETE CASCADE,
    palpite_gols_casa   INT         NOT NULL CHECK (palpite_gols_casa >= 0),
    palpite_gols_fora   INT         NOT NULL CHECK (palpite_gols_fora >= 0),
    criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_usuario_partida UNIQUE (usuario_id, partida_id)
);

CREATE INDEX IF NOT EXISTS idx_palpites_usuario_id ON palpites (usuario_id);
CREATE INDEX IF NOT EXISTS idx_palpites_partida_id ON palpites (partida_id);
CREATE INDEX IF NOT EXISTS idx_partidas_data_hora   ON partidas (data_hora_jogo);

-- -----------------------------------------------------------------------------
-- Função: verifica se o prazo de palpite ainda está aberto (lock-out de 1 hora)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION palpite_permitido(p_data_hora_jogo TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT p_data_hora_jogo - NOW() > INTERVAL '1 hour';
$$;

-- -----------------------------------------------------------------------------
-- Função: calcula pontos de um palpite individual
--   2 pts -> placar exato
--   1 pt  -> vencedor/empate correto (sem placar exato)
--   0 pts -> erro total
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION calcular_pontos_palpite(
    p_gols_casa    INT,
    p_gols_fora    INT,
    p_palpite_casa INT,
    p_palpite_fora INT
)
RETURNS INT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF p_gols_casa IS NULL OR p_gols_fora IS NULL THEN
        RETURN 0;
    END IF;

    -- Placar cheio
    IF p_gols_casa = p_palpite_casa AND p_gols_fora = p_palpite_fora THEN
        RETURN 2;
    END IF;

    -- Vencedor ou empate correto
    IF (p_gols_casa > p_gols_fora AND p_palpite_casa > p_palpite_fora)
        OR (p_gols_casa < p_gols_fora AND p_palpite_casa < p_palpite_fora)
        OR (p_gols_casa = p_gols_fora AND p_palpite_casa = p_palpite_fora)
    THEN
        RETURN 1;
    END IF;

    RETURN 0;
END;
$$;

-- -----------------------------------------------------------------------------
-- View: ranking agregado por usuário
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW ranking AS
SELECT
    u.id   AS usuario_id,
    u.nome,
    COALESCE(SUM(
        CASE
            WHEN p.status = 'FINISHED' THEN
                calcular_pontos_palpite(
                    p.gols_casa, p.gols_fora,
                    pl.palpite_gols_casa, pl.palpite_gols_fora
                )
            ELSE 0
        END
    ), 0)::INT AS pontos_totais,
    COALESCE(SUM(
        CASE
            WHEN p.status = 'FINISHED'
                 AND p.gols_casa = pl.palpite_gols_casa
                 AND p.gols_fora = pl.palpite_gols_fora
            THEN 1 ELSE 0
        END
    ), 0)::INT AS acertos_cheios,
    COALESCE(SUM(
        CASE
            WHEN p.status = 'FINISHED'
                 AND NOT (p.gols_casa = pl.palpite_gols_casa AND p.gols_fora = pl.palpite_gols_fora)
                 AND calcular_pontos_palpite(
                     p.gols_casa, p.gols_fora,
                     pl.palpite_gols_casa, pl.palpite_gols_fora
                 ) = 1
            THEN 1 ELSE 0
        END
    ), 0)::INT AS acertos_vencedor
FROM usuarios u
LEFT JOIN palpites pl ON pl.usuario_id = u.id
LEFT JOIN partidas p  ON p.id = pl.partida_id
GROUP BY u.id, u.nome
ORDER BY pontos_totais DESC, u.nome ASC;
