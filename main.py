import csv
import io
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from supabase import Client, create_client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
PARTIDAS_CSV_PADRAO = Path(
    os.getenv("PARTIDAS_CSV_PATH", str(DATA_DIR / "copa_2026.csv"))
)

CAMPOS_CSV_PARTIDAS = (
    "id",
    "time_casa",
    "time_fora",
    "data_hora_jogo",
    "gols_casa",
    "gols_fora",
    "status",
)

supabase: Client | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global supabase

    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError(
            "Variáveis SUPABASE_URL e SUPABASE_KEY devem estar definidas no .env"
        )

    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    yield


app = FastAPI(
    title="BolãoFort",
    description="Sistema de palpites para a Copa do Mundo",
    version="0.1.0",
    lifespan=lifespan,
)


def get_supabase() -> Client:
    if supabase is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cliente Supabase não inicializado",
        )
    return supabase


LOCKOUT_ANTECEDENCIA = timedelta(hours=1)


def parse_timestamp(value: str) -> datetime:
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def palpite_dentro_do_prazo(data_hora_jogo: datetime) -> bool:
    # Define o fuso horário de Brasília (UTC-3)
    brasilia_tz = timezone(timedelta(hours=-3))
    
    # Pega o horário atual em Brasília
    agora = datetime.now(brasilia_tz)
    
    # Garante que a data do jogo esteja no mesmo fuso para comparação correta
    if data_hora_jogo.tzinfo is None:
        data_hora_jogo = data_hora_jogo.replace(tzinfo=brasilia_tz)
    else:
        data_hora_jogo = data_hora_jogo.astimezone(brasilia_tz)
        
    return data_hora_jogo - agora > LOCKOUT_ANTECEDENCIA


def houve_acerto_classificacao(
    gols_casa: int,
    gols_fora: int,
    palpite_casa: int,
    palpite_fora: int,
    mata_mata: bool,
    vencedor_penaltis: str | None,
    palpite_penaltis: str | None,
) -> bool:
    """
    Indica se o usuário acertou quem se classifica em um jogo de mata-mata
    decidido nos pênaltis (placar empatado no tempo normal).
    Só conta se o usuário também tiver "chamado" o empate no palpite.
    """
    return bool(
        mata_mata
        and gols_casa == gols_fora
        and vencedor_penaltis in ("casa", "fora")
        and palpite_casa == palpite_fora
        and palpite_penaltis == vencedor_penaltis
    )


def calcular_pontos_palpite(
    gols_casa: int,
    gols_fora: int,
    palpite_casa: int,
    palpite_fora: int,
    mata_mata: bool = False,
    vencedor_penaltis: str | None = None,
    palpite_penaltis: str | None = None,
) -> int:
    """
    2 pts placar cheio, 1 pt vencedor/empate, 0 pts erro.
    +1 pt bônus se for mata-mata decidido nos pênaltis e o usuário acertar
    tanto o empate quanto o time que avança.
    """
    if gols_casa == palpite_casa and gols_fora == palpite_fora:
        pontos = 2
    elif (
        (gols_casa > gols_fora and palpite_casa > palpite_fora)
        or (gols_casa < gols_fora and palpite_casa < palpite_fora)
        or (gols_casa == gols_fora and palpite_casa == palpite_fora)
    ):
        pontos = 1
    else:
        pontos = 0

    if houve_acerto_classificacao(
        gols_casa, gols_fora, palpite_casa, palpite_fora,
        mata_mata, vencedor_penaltis, palpite_penaltis,
    ):
        pontos += 1

    return pontos


def mapear_status_partida(status_api: str) -> str:
    status_normalizado = (status_api or "SCHEDULED").upper()
    mapa = {
        "FINISHED": "FINISHED",
        "SCHEDULED": "SCHEDULED",
        "TIMED": "SCHEDULED",
        "IN_PLAY": "IN_PLAY",
        "LIVE": "IN_PLAY",
        "PAUSED": "IN_PLAY",
        "POSTPONED": "POSTPONED",
        "SUSPENDED": "SUSPENDED",
        "CANCELLED": "CANCELLED",
    }
    return mapa.get(status_normalizado, status_normalizado[:20])


def parsear_int_opcional(valor: str | None) -> int | None:
    if valor is None or str(valor).strip() == "":
        return None
    return int(valor)


def converter_linha_csv_para_partida(linha: dict[str, str], numero_linha: int) -> dict[str, Any]:
    campos_ausentes = [c for c in CAMPOS_CSV_PARTIDAS if c not in linha]
    if campos_ausentes:
        raise ValueError(
            f"Linha {numero_linha}: colunas obrigatórias ausentes: {', '.join(campos_ausentes)}"
        )

    status_partida = mapear_status_partida(linha["status"])
    gols_casa = parsear_int_opcional(linha.get("gols_casa"))
    gols_fora = parsear_int_opcional(linha.get("gols_fora"))

    if status_partida == "FINISHED":
        if gols_casa is None or gols_fora is None:
            raise ValueError(
                f"Linha {numero_linha}: jogos FINISHED precisam de gols_casa e gols_fora"
            )
    else:
        gols_casa = None
        gols_fora = None

    data_hora = parse_timestamp(linha["data_hora_jogo"].strip())

    return {
        "id": int(linha["id"]),
        "time_casa": linha["time_casa"].strip()[:50],
        "time_fora": linha["time_fora"].strip()[:50],
        "data_hora_jogo": data_hora.isoformat(),
        "gols_casa": gols_casa,
        "gols_fora": gols_fora,
        "status": status_partida,
    }


def ler_partidas_de_csv(conteudo: str) -> list[dict[str, Any]]:
    """Lê partidas de um CSV com cabeçalho padrão da Copa."""
    conteudo = conteudo.lstrip("\ufeff")
    leitor = csv.DictReader(io.StringIO(conteudo))

    if not leitor.fieldnames:
        raise ValueError("CSV vazio ou sem cabeçalho")

    partidas: list[dict[str, Any]] = []
    for numero_linha, linha in enumerate(leitor, start=2):
        if not any((valor or "").strip() for valor in linha.values()):
            continue
        partidas.append(converter_linha_csv_para_partida(linha, numero_linha))

    if not partidas:
        raise ValueError("Nenhuma partida encontrada no CSV")

    return partidas


def enriquecer_partidas(partidas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    enriquecidas: list[dict[str, Any]] = []
    for partida in partidas:
        data_hora_jogo = parse_timestamp(partida["data_hora_jogo"])
        enriquecidas.append(
            {
                **partida,
                "palpite_expirado": not palpite_dentro_do_prazo(data_hora_jogo),
            }
        )
    return enriquecidas


def importar_partidas_csv(conteudo: str, origem: str) -> dict[str, Any]:
    """Faz upsert das partidas lidas do CSV no Supabase."""
    partidas = ler_partidas_de_csv(conteudo)

    db = get_supabase()
    resultado = db.table("partidas").upsert(partidas).execute()
    if not resultado.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Falha ao importar partidas no Supabase",
        )

    partidas_importadas = enriquecer_partidas(resultado.data)
    return {
        "message": f"Importação concluída ({len(partidas_importadas)} partidas)",
        "fonte": "csv",
        "arquivo": origem,
        "total": len(partidas_importadas),
        "partidas": partidas_importadas,
    }


def importar_partidas_csv_arquivo(caminho: Path) -> dict[str, Any]:
    if not caminho.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Arquivo CSV não encontrado: {caminho}",
        )
    conteudo = caminho.read_text(encoding="utf-8")
    return importar_partidas_csv(conteudo, str(caminho.name))


def obter_registro_unico(response: Any) -> dict[str, Any] | None:
    """Normaliza resposta do Supabase (maybe_single pode retornar None)."""
    if response is None:
        return None

    data = response.data
    if data is None:
        return None
    if isinstance(data, list):
        return data[0] if data else None
    if isinstance(data, dict):
        return data
    return None


# -----------------------------------------------------------------------------
# Schemas (Pydantic)
# -----------------------------------------------------------------------------


class UsuarioCreate(BaseModel):
    nome: str = Field(..., min_length=1, max_length=100)
    senha: str = Field(..., min_length=4, max_length=50)


class UsuarioLogin(BaseModel):
    nome: str = Field(..., min_length=1)
    senha: str = Field(..., min_length=1)


class UsuarioResponse(BaseModel):
    id: UUID
    nome: str
    is_admin: bool = False

class PartidaUpdate(BaseModel):
    gols_casa: int | None = None
    gols_fora: int | None = None
    status: str | None = None
    data_hora_jogo: str | None = None
    mata_mata: bool | None = None
    vencedor_penaltis: str | None = None  # "casa" | "fora"

class PartidaCreate(BaseModel):
    time_casa: str = Field(..., min_length=1, max_length=50)
    time_fora: str = Field(..., min_length=1, max_length=50)
    data_hora_jogo: str  # String em formato ISO 8601
    mata_mata: bool = False

class PalpiteCreate(BaseModel):
    usuario_id: UUID
    partida_id: int
    gols_casa: int = Field(..., ge=0)
    gols_fora: int = Field(..., ge=0)
    penaltis: str | None = None  # "casa" | "fora" — quem o usuário acha que avança


class PalpiteResponse(BaseModel):
    id: int
    usuario_id: UUID
    partida_id: int
    palpite_gols_casa: int
    palpite_gols_fora: int
    palpite_penaltis: str | None = None


class PartidaResponse(BaseModel):
    id: int
    time_casa: str
    time_fora: str
    data_hora_jogo: str
    gols_casa: int | None
    gols_fora: int | None
    status: str
    palpite_expirado: bool
    mata_mata: bool = False
    vencedor_penaltis: str | None = None


class RankingEntry(BaseModel):
    usuario_id: UUID
    nome: str
    pontos_totais: int
    acertos_cheios: int
    acertos_vencedor: int
    acertos_classificacao: int = 0


# -----------------------------------------------------------------------------
# Rotas principais
# -----------------------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def pagina_principal() -> HTMLResponse:
    index_path = STATIC_DIR / "index.html"
    return HTMLResponse(content=index_path.read_text(encoding="utf-8"))


@app.get("/api/usuarios", response_model=list[UsuarioResponse])
async def listar_usuarios() -> list[dict[str, Any]]:
    """Lista participantes cadastrados (apenas ID e Nome)."""
    db = get_supabase()
    resultado = db.table("usuarios").select("id, nome, is_admin").order("nome").execute()
    return resultado.data or []


@app.post("/api/usuarios", response_model=UsuarioResponse, status_code=status.HTTP_201_CREATED)
async def criar_usuario(payload: UsuarioCreate) -> dict[str, Any]:
    """Registra um novo participante com nome e senha."""
    db = get_supabase()
    nome = payload.nome.strip()
    senha = payload.senha.strip()

    existente_resp = (
        db.table("usuarios")
        .select("id")
        .eq("nome", nome)
        .maybe_single()
        .execute()
    )
    if obter_registro_unico(existente_resp) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Já existe um participante com este nome",
        )

    resultado = db.table("usuarios").insert({"nome": nome, "senha": senha}).execute()
    if not resultado.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Falha ao cadastrar usuário",
        )

    usuario = resultado.data[0]
    return {"id": usuario["id"], "nome": usuario["nome"], "is_admin": usuario.get("is_admin", False)}


@app.post("/api/usuarios/login", response_model=UsuarioResponse)
async def login_usuario(payload: UsuarioLogin) -> dict[str, Any]:
    """Valida o nome e a senha do participante para efetuar login."""
    db = get_supabase()
    nome = payload.nome.strip()
    senha = payload.senha.strip()

    usuario_resp = (
        db.table("usuarios")
        .select("id, nome, senha, is_admin")
        .eq("nome", nome)
        .maybe_single()
        .execute()
    )
    usuario = obter_registro_unico(usuario_resp)

    if usuario is None or usuario.get("senha") != senha:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Nome de participante ou senha incorretos",
        )

    return {"id": usuario["id"], "nome": usuario["nome"], "is_admin": usuario.get("is_admin", False)}


@app.get("/api/partidas", response_model=list[PartidaResponse])
async def listar_partidas() -> list[dict[str, Any]]:
    """
    Lista partidas sincronizadas da Copa do Mundo,
    com status e indicação se o prazo de palpite expirou.
    """
    db = get_supabase()

    resultado = (
        db.table("partidas")
        .select("id, time_casa, time_fora, data_hora_jogo, gols_casa, gols_fora, status, mata_mata, vencedor_penaltis")
        .order("data_hora_jogo")
        .execute()
    )

    partidas: list[dict[str, Any]] = []
    for partida in resultado.data or []:
        data_hora_jogo = parse_timestamp(partida["data_hora_jogo"])
        partidas.append(
            {
                "id": partida["id"],
                "time_casa": partida["time_casa"],
                "time_fora": partida["time_fora"],
                "data_hora_jogo": partida["data_hora_jogo"],
                "gols_casa": partida["gols_casa"],
                "gols_fora": partida["gols_fora"],
                "status": partida["status"],
                "palpite_expirado": not palpite_dentro_do_prazo(data_hora_jogo),
                "mata_mata": partida.get("mata_mata", False),
                "vencedor_penaltis": partida.get("vencedor_penaltis"),
            }
        )

    return partidas


@app.post("/api/palpites", response_model=PalpiteResponse, status_code=status.HTTP_201_CREATED)
async def registrar_palpite(payload: PalpiteCreate) -> dict[str, Any]:
    """
    Registra ou atualiza palpite de um usuário para uma partida.
    Retorna 403 se faltar menos de 1 hora para o início do jogo.
    """
    db = get_supabase()
    usuario_id = str(payload.usuario_id)

    usuario = obter_registro_unico(
        db.table("usuarios")
        .select("id")
        .eq("id", usuario_id)
        .maybe_single()
        .execute()
    )
    if usuario is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Usuário não encontrado",
        )

    partida = obter_registro_unico(
        db.table("partidas")
        .select("id, data_hora_jogo")
        .eq("id", payload.partida_id)
        .maybe_single()
        .execute()
    )
    if partida is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Partida não encontrada",
        )

    data_hora_jogo = parse_timestamp(partida["data_hora_jogo"])
    if not palpite_dentro_do_prazo(data_hora_jogo):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Prazo para palpite encerrado. Envie pelo menos 1 hora antes do jogo.",
        )

    if payload.penaltis is not None and payload.penaltis not in ("casa", "fora"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Campo 'penaltis' deve ser 'casa' ou 'fora'",
        )

    resultado = (
        db.table("palpites")
        .upsert(
            {
                "usuario_id": usuario_id,
                "partida_id": payload.partida_id,
                "palpite_gols_casa": payload.gols_casa,
                "palpite_gols_fora": payload.gols_fora,
                "palpite_penaltis": payload.penaltis,
            },
            on_conflict="usuario_id,partida_id",
        )
        .execute()
    )

    if not resultado.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Falha ao salvar palpite",
        )

    palpite = resultado.data[0]
    return {
        "id": palpite["id"],
        "usuario_id": palpite["usuario_id"],
        "partida_id": palpite["partida_id"],
        "palpite_gols_casa": palpite["palpite_gols_casa"],
        "palpite_gols_fora": palpite["palpite_gols_fora"],
        "palpite_penaltis": palpite.get("palpite_penaltis"),
    }

@app.get("/api/palpites/usuario/{usuario_id}", response_model=list[PalpiteResponse])
async def listar_palpites_usuario(usuario_id: UUID) -> list[dict[str, Any]]:
    """Retorna todos os palpites que um usuário específico já realizou."""
    db = get_supabase()
    
    resultado = (
        db.table("palpites")
        .select("id, usuario_id, partida_id, palpite_gols_casa, palpite_gols_fora, palpite_penaltis")
        .eq("usuario_id", str(usuario_id))
        .execute()
    )
    
    return resultado.data or []


@app.get("/api/ranking", response_model=list[RankingEntry])
async def obter_ranking() -> list[dict[str, Any]]:
    """Retorna classificação ordenada por pontos_totais DESC."""
    db = get_supabase()

    usuarios_resp = db.table("usuarios").select("id, nome, is_admin").execute()
    usuarios = usuarios_resp.data or []

    ranking_por_usuario: dict[str, dict[str, Any]] = {
        usuario["id"]: {
            "usuario_id": usuario["id"],
            "nome": usuario["nome"],
            "pontos_totais": 0,
            "acertos_cheios": 0,
            "acertos_vencedor": 0,
            "acertos_classificacao": 0,
        }
        for usuario in usuarios
    }

    palpites_resp = (
        db.table("palpites")
        .select(
            "usuario_id, palpite_gols_casa, palpite_gols_fora, palpite_penaltis, "
            "partidas(gols_casa, gols_fora, mata_mata, vencedor_penaltis)"
        )
        .execute()
    )

    for palpite in palpites_resp.data or []:
        partida = palpite.get("partidas")
        if not partida:
            continue

        gols_casa = partida.get("gols_casa")
        gols_fora = partida.get("gols_fora")
        if gols_casa is None or gols_fora is None:
            continue

        usuario_id = palpite["usuario_id"]
        entrada = ranking_por_usuario.get(usuario_id)
        if entrada is None:
            continue

        mata_mata = bool(partida.get("mata_mata", False))
        vencedor_penaltis = partida.get("vencedor_penaltis")
        palpite_penaltis = palpite.get("palpite_penaltis")

        pontos = calcular_pontos_palpite(
            gols_casa,
            gols_fora,
            palpite["palpite_gols_casa"],
            palpite["palpite_gols_fora"],
            mata_mata,
            vencedor_penaltis,
            palpite_penaltis,
        )
        entrada["pontos_totais"] += pontos
        if pontos >= 2 and gols_casa == palpite["palpite_gols_casa"] and gols_fora == palpite["palpite_gols_fora"]:
            entrada["acertos_cheios"] += 1
        elif pontos >= 1:
            entrada["acertos_vencedor"] += 1

        if houve_acerto_classificacao(
            gols_casa, gols_fora,
            palpite["palpite_gols_casa"], palpite["palpite_gols_fora"],
            mata_mata, vencedor_penaltis, palpite_penaltis,
        ):
            entrada["acertos_classificacao"] += 1

    return sorted(
        ranking_por_usuario.values(),
        key=lambda item: (
            -item["pontos_totais"],
            -item["acertos_cheios"],
            -item["acertos_vencedor"],
            item["nome"].casefold(),
        ),
    )


@app.post("/api/admin/palpites", response_model=PalpiteResponse, status_code=status.HTTP_201_CREATED)
async def registrar_palpite_admin(payload: PalpiteCreate) -> dict[str, Any]:
    """
    [TEMPORÁRIO] Registra palpite ignorando o lock-out de horário.
    Permitido apenas para partidas já finalizadas (teste de ranking).
    """
    db = get_supabase()
    usuario_id = str(payload.usuario_id)

    usuario = obter_registro_unico(
        db.table("usuarios")
        .select("id")
        .eq("id", usuario_id)
        .maybe_single()
        .execute()
    )
    if usuario is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Usuário não encontrado",
        )

    partida = obter_registro_unico(
        db.table("partidas")
        .select("id, status, gols_casa, gols_fora")
        .eq("id", payload.partida_id)
        .maybe_single()
        .execute()
    )
    if partida is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Partida não encontrada",
        )

    if partida["status"] != "FINISHED" or partida["gols_casa"] is None or partida["gols_fora"] is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Rota admin só aceita palpites em partidas finalizadas com placar definido",
        )

    resultado = (
        db.table("palpites")
        .upsert(
            {
                "usuario_id": usuario_id,
                "partida_id": payload.partida_id,
                "palpite_gols_casa": payload.gols_casa,
                "palpite_gols_fora": payload.gols_fora,
                "palpite_penaltis": payload.penaltis,
            },
            on_conflict="usuario_id,partida_id",
        )
        .execute()
    )

    if not resultado.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Falha ao salvar palpite",
        )

    palpite = resultado.data[0]
    return {
        "id": palpite["id"],
        "usuario_id": palpite["usuario_id"],
        "partida_id": palpite["partida_id"],
        "palpite_gols_casa": palpite["palpite_gols_casa"],
        "palpite_gols_fora": palpite["palpite_gols_fora"],
        "palpite_penaltis": palpite.get("palpite_penaltis"),
    }


@app.post("/api/admin/importar-copa")
async def importar_copa_csv_padrao() -> dict[str, Any]:
    """
    Importa jogos da Copa a partir do CSV padrão (data/copa_2026.csv).
    Edite o CSV e rode de novo para atualizar placares e status.
    """
    try:
        return importar_partidas_csv_arquivo(PARTIDAS_CSV_PADRAO)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@app.post("/api/admin/importar-copa/upload")
async def importar_copa_csv_upload(
    arquivo: UploadFile = File(...),
) -> dict[str, Any]:
    """Importa jogos da Copa a partir de um arquivo CSV enviado pelo navegador."""
    if not arquivo.filename or not arquivo.filename.lower().endswith(".csv"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Envie um arquivo .csv válido",
        )

    conteudo = (await arquivo.read()).decode("utf-8-sig")
    try:
        return importar_partidas_csv(conteudo, arquivo.filename)
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@app.post("/api/admin/sincronizar-copa")
async def sincronizar_copa() -> dict[str, Any]:
    """Alias para importar o CSV padrão da Copa."""
    return await importar_copa_csv_padrao()

@app.put("/api/admin/partidas/{partida_id}", response_model=PartidaResponse)
async def atualizar_partida_manualmente(partida_id: int, payload: PartidaUpdate):
    """Atualiza placar, status e data de uma partida manualmente."""
    db = get_supabase()
    
    if payload.vencedor_penaltis is not None and payload.vencedor_penaltis not in ("casa", "fora"):
        raise HTTPException(status_code=400, detail="vencedor_penaltis deve ser 'casa' ou 'fora'.")

    update_data = {}
    if payload.gols_casa is not None: update_data["gols_casa"] = payload.gols_casa
    if payload.gols_fora is not None: update_data["gols_fora"] = payload.gols_fora
    if payload.status is not None: update_data["status"] = payload.status
    if payload.data_hora_jogo is not None: update_data["data_hora_jogo"] = payload.data_hora_jogo
    if payload.mata_mata is not None: update_data["mata_mata"] = payload.mata_mata
    if payload.vencedor_penaltis is not None: update_data["vencedor_penaltis"] = payload.vencedor_penaltis

    if not update_data:
        raise HTTPException(status_code=400, detail="Nenhum dado enviado para atualização.")

    resultado = db.table("partidas").update(update_data).eq("id", partida_id).execute()
    
    if not resultado.data:
        raise HTTPException(status_code=404, detail="Partida não encontrada ou erro ao atualizar.")
        
    partida = resultado.data[0]
    data_hora_jogo = parse_timestamp(partida["data_hora_jogo"])
    
    return {
        "id": partida["id"],
        "time_casa": partida["time_casa"],
        "time_fora": partida["time_fora"],
        "data_hora_jogo": partida["data_hora_jogo"],
        "gols_casa": partida["gols_casa"],
        "gols_fora": partida["gols_fora"],
        "status": partida["status"],
        "palpite_expirado": not palpite_dentro_do_prazo(data_hora_jogo),
        "mata_mata": partida.get("mata_mata", False),
        "vencedor_penaltis": partida.get("vencedor_penaltis"),
    }

@app.post("/api/admin/partidas", response_model=PartidaResponse, status_code=status.HTTP_201_CREATED)
async def criar_partida_manualmente(payload: PartidaCreate):
    """Cria uma nova partida manualmente pelo painel admin."""
    db = get_supabase()

    # Formata a data para garantir que seja salva corretamente
    data_hora_jogo = parse_timestamp(payload.data_hora_jogo)

    # 1. Busca o maior ID atual na tabela de partidas
    max_id_resp = db.table("partidas").select("id").order("id", desc=True).limit(1).execute()
    
    # 2. Define o novo ID (se a tabela estiver vazia, começa no 1)
    novo_id = 1
    if max_id_resp.data:
        novo_id = max_id_resp.data[0]["id"] + 1

    # 3. Insere a partida com o novo ID calculado
    nova_partida = {
        "id": novo_id,
        "time_casa": payload.time_casa.strip(),
        "time_fora": payload.time_fora.strip(),
        "data_hora_jogo": data_hora_jogo.isoformat(),
        "status": "SCHEDULED",
        "gols_casa": None,
        "gols_fora": None,
        "mata_mata": payload.mata_mata,
    }

    resultado = db.table("partidas").insert(nova_partida).execute()

    if not resultado.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail="Erro ao criar partida no banco de dados."
        )

    partida = resultado.data[0]
    
    return {
        "id": partida["id"],
        "time_casa": partida["time_casa"],
        "time_fora": partida["time_fora"],
        "data_hora_jogo": partida["data_hora_jogo"],
        "gols_casa": partida["gols_casa"],
        "gols_fora": partida["gols_fora"],
        "status": partida["status"],
        "palpite_expirado": not palpite_dentro_do_prazo(parse_timestamp(partida["data_hora_jogo"])),
        "mata_mata": partida.get("mata_mata", False),
        "vencedor_penaltis": partida.get("vencedor_penaltis"),
    }

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")