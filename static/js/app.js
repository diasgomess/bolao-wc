const STORAGE_KEY = "bolaofort_usuario";

let usuarioAtual = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
let palpitesDoUsuario = []; // Armazena em memória os palpites do usuário logado
let partidasCache = [];

const $ = (sel) => document.querySelector(sel);
const toast = $("#toast");

function showToast(msg, type = "success") {
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  setTimeout(() => toast.classList.remove("show"), 3500);
}

async function carregarPalpitesDoUsuario() {
  if (!usuarioAtual) {
    palpitesDoUsuario = [];
    return;
  }
  try {
    palpitesDoUsuario = await api(`/api/palpites/usuario/${usuarioAtual.id}`);
  } catch (err) {
    console.error("Erro ao carregar palpites do usuário:", err);
    palpitesDoUsuario = [];
  }
}

async function atualizarBarraUsuario() {
  const logged = $("#userLogged");
  const guest = $("#userGuest");
  const logout = $("#btnLogout");
  const tabAdmin = $("#tabAdmin");

  if (usuarioAtual) {
    logged.style.display = "flex";
    guest.style.display = "none";
    logout.style.display = "block";
    $("#userName").textContent = usuarioAtual.nome;

    if (usuarioAtual.is_admin) {
      tabAdmin.style.display = "inline-block";
    } else {
      tabAdmin.style.display = "none";
    }

    await carregarPalpitesDoUsuario();
  } else {
    logged.style.display = "none";
    guest.style.display = "block";
    logout.style.display = "none";
    tabAdmin.style.display = "none";
    palpitesDoUsuario = [];
  }
}

async function salvarUsuario(usuario) {
  usuarioAtual = usuario;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(usuario));
  await atualizarBarraUsuario();
}

function exigirLogin() {
  if (!usuarioAtual) {
    showToast("Selecione ou cadastre um participante primeiro.", "error");
    document.querySelector('[data-tab="usuario"]').click();
    return false;
  }
  return true;
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail;
    const msg = typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail.map((d) => d.msg).join(", ")
        : "Erro na requisição";
    throw new Error(msg);
  }
  return data;
}

async function carregarUsuarios() {
  const usuarios = await api("/api/usuarios");
  const select = $("#selectUsuario");
  select.innerHTML = '<option value="">— Selecione —</option>';
  usuarios.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = u.nome;
    select.appendChild(opt);
  });
  if (usuarioAtual) {
    select.value = usuarioAtual.id;
  }
}

function formatarData(iso) {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function statusPartida(p) {
  if (p.status === "FINISHED") {
    return { label: `Finalizado — ${p.gols_casa} × ${p.gols_fora}`, cls: "status-finished", aberto: false };
  }
  if (p.status === "IN_PLAY") {
    return { label: "AO VIVO", cls: "status-live", aberto: false };
  }
  if (p.palpite_expirado) {
    return { label: "Inscrições Encerradas", cls: "status-closed", aberto: false };
  }
  return { label: "Palpites Abertos", cls: "status-open", aberto: true };
}

function atualizarSelectCampeonatos() {
  const select = document.getElementById("selectCampeonato");
  if (!select) return;

  const valorAtual = select.value || "TODOS";
  const campeonatos = new Set();

  // Coleta dinamicamente os campeonatos que existem nas partidas do cache
  partidasCache.forEach(p => {
    if (p.campeonato) {
      campeonatos.add(p.campeonato);
    }
  });

  // Fallback: se nenhuma partida tiver o campo preenchido, define Copa do Mundo
  if (campeonatos.size === 0) {
    campeonatos.add("Copa do Mundo");
  }

  let htmlOptions = '<option value="TODOS">Todos os Campeonatos</option>';
  campeonatos.forEach(camp => {
    htmlOptions += `<option value="${camp}">${camp}</option>`;
  });

  select.innerHTML = htmlOptions;
  select.value = valorAtual; // Mantém o filtro selecionado após o reload
}

async function carregarPartidas() {
  try {
    // Busca os dados da API uma única vez e alimenta o cache local
    partidasCache = await api("/api/partidas");
    await carregarPalpitesDoUsuario();

    atualizarSelectCampeonatos();

    // Dispara a renderização visual dos cards
    renderizarPartidas();
  } catch (err) {
    $("#matchesList").innerHTML = `<div class="empty">Erro ao carregar jogos: ${err.message}</div>`;
  }
}

function renderizarPartidas() {
  const listaContainer = document.getElementById("matchesList");

  const inputFiltro = document.getElementById("inputFiltroSelecao");
  const termoBusca = inputFiltro ? inputFiltro.value.toLowerCase().trim() : "";

  const selectCampeonato = document.getElementById("selectCampeonato");
  const campeonatoSelecionado = selectCampeonato ? selectCampeonato.value : "TODOS";

  if (!partidasCache || !partidasCache.length) {
    listaContainer.innerHTML = '<div class="empty">Nenhum jogo disponível no momento.</div>';
    return;
  }

  // 1. Filtrar partidas de acordo com a busca e o campeonato selecionado
  const partidasFiltradas = partidasCache.filter(partida => {
    const correspondeTexto = partida.time_casa.toLowerCase().includes(termoBusca) || 
                             partida.time_fora.toLowerCase().includes(termoBusca);
    
    const campPartida = partida.campeonato || "Copa do Mundo";
    const correspondeCampeonato = campeonatoSelecionado === "TODOS" || 
                                  campPartida.toLowerCase() === campeonatoSelecionado.toLowerCase();

    return correspondeTexto && correspondeCampeonato;
  });

  if (!partidasFiltradas.length) {
    listaContainer.innerHTML = '<div class="empty">Nenhuma partida encontrada para esta seleção.</div>';
    return;
  }

  // 2. Identificar partidas que acontecem HOJE
  const hoje = new Date();
  const partidasDeHoje = partidasFiltradas.filter(partida => {
    const dataJogo = new Date(partida.data_hora_jogo);
    return dataJogo.getDate() === hoje.getDate() &&
           dataJogo.getMonth() === hoje.getMonth() &&
           dataJogo.getFullYear() === hoje.getFullYear();
  });

  // 3. Agrupar todas as partidas por dia para a listagem normal
  const gruposPorData = {};
  partidasFiltradas.forEach(partida => {
    const dataObjeto = new Date(partida.data_hora_jogo);
    let dataFormatada = dataObjeto.toLocaleDateString('pt-BR', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
    dataFormatada = dataFormatada.charAt(0).toUpperCase() + dataFormatada.slice(1);

    if (!gruposPorData[dataFormatada]) {
      gruposPorData[dataFormatada] = [];
    }
    gruposPorData[dataFormatada].push(partida);
  });

  // 4. Função interna auxiliar para gerar o HTML do Card (Evita repetição de código)
  const gerarCardHTML = (partida) => {
    const palpiteSalvo = palpitesDoUsuario.find(p => p.partida_id === partida.id);
    const jaPalpitou = !!palpiteSalvo;
    const golsCasaPalpite = jaPalpitou ? palpiteSalvo.palpite_gols_casa : "";
    const golsForaPalpite = jaPalpitou ? palpiteSalvo.palpite_gols_fora : "";

    const bloqueioTotal = partida.palpite_expirado || partida.status === "FINISHED" || partida.status === "IN_PLAY";
    const inputsDesabilitados = (jaPalpitou || bloqueioTotal) ? 'disabled' : '';

    const horarioJogo = new Date(partida.data_hora_jogo).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit'
    });

    let statusLabel = "Aberto";
    let statusBg = "#238636";

    if (partida.status === "FINISHED") {
      statusLabel = "Finalizado";
      statusBg = "#21262d"; 
    } else if (partida.status === "IN_PLAY") {
      statusLabel = "AO VIVO";
      statusBg = "#da3637"; 
    } else if (partida.palpite_expirado) {
      statusLabel = "Encerrado";
      statusBg = "#30363d";
    }

    const estiloCard = jaPalpitou
      ? "background: #161b22; border: 1px solid #238636; border-left: 5px solid #238636; padding: 15px; margin-bottom: 15px; border-radius: 8px; transition: all 0.2s;"
      : "background: #161b22; border: 1px solid #30363d; padding: 15px; margin-bottom: 15px; border-radius: 8px; transition: all 0.2s;";

    return `
      <article class="match-card" data-id="${partida.id}" style="${estiloCard}">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <span style="font-size: 0.85rem; color: #8b949e; font-weight: 500;">${horarioJogo} | ID: ${partida.id}</span>
          <span class="status-tag" style="padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: bold; background: ${statusBg}; color: #fff;">
            ${statusLabel}
          </span>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 5px;">
          <div style="font-weight: bold; font-size: 1rem; width: 38%; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ffffff;">
            ${partida.time_casa}
          </div>
          
          <div style="width: 24%; display: flex; justify-content: center; align-items: center; gap: 6px; min-width: 110px;">
            <input 
              type="number" 
              min="0" 
              class="gols-casa" 
              value="${golsCasaPalpite}" 
              data-partida="${partida.id}"
              ${inputsDesabilitados} 
              placeholder="-"
              style="width: 46px; height: 42px; text-align: center; background: #0b0e14; border: 1px solid ${jaPalpitou ? '#238636' : '#30363d'}; color: white; border-radius: 6px; font-weight: bold; font-size: 1.1rem; outline: none;"
            />
            <span style="color: #8b949e; font-weight: bold; font-size: 1rem;">×</span>
            <input 
              type="number" 
              min="0" 
              class="gols-fora" 
              value="${golsForaPalpite}" 
              data-partida="${partida.id}"
              ${inputsDesabilitados} 
              placeholder="-"
              style="width: 46px; height: 42px; text-align: center; background: #0b0e14; border: 1px solid ${jaPalpitou ? '#238636' : '#30363d'}; color: white; border-radius: 6px; font-weight: bold; font-size: 1.1rem; outline: none;"
            />
          </div>

          <div style="font-weight: bold; font-size: 1rem; width: 38%; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ffffff;">
            ${partida.time_fora}
          </div>
        </div>

        <div style="display: flex; justify-content: center; align-items: center; margin-top: 15px; width: 100%;">
          ${bloqueioTotal ?
          `<button class="btn" disabled style="opacity: 0.5; padding: 6px 16px; font-size: 0.85rem; background: #21262d; color: #8b949e; border: 1px solid #30363d; border-radius: 6px; width: 100%; max-width: 180px;">
              ${partida.status === 'IN_PLAY' ? '🔒 Ao Vivo' : '🔒 Bloqueado'}
             </button>` :
          (jaPalpitou ? `
              <div style="display: flex; justify-content: center; width: 100%;">
                <button type="button" class="btn btn-editar" 
                         style="padding: 6px 16px; font-size: 0.85rem; border-radius: 6px; font-weight: 600; cursor: pointer; background: #21262d; color: #c9d1d9; border: 1px solid #30363d; width: 100%; max-width: 180px;">
                  Editar Palpite
                 </button>
                <button type="button" class="btn btn-primary btn-salvar" 
                         style="display:none; padding: 6px 16px; font-size: 0.85rem; border-radius: 6px; font-weight: 600; cursor: pointer; background: #238636; color: #fff; border: 1px solid transparent; width: 100%; max-width: 180px;" 
                         onclick="salvarPalpiteFront(${partida.id}, this)">
                  Atualizar
                 </button>
              </div>
            ` : `
              <button type="button" class="btn btn-primary btn-salvar" 
                       style="padding: 6px 16px; font-size: 0.85rem; border-radius: 6px; font-weight: 600; cursor: pointer; background: #238636; color: #fff; border: 1px solid transparent; width: 100%; max-width: 180px;" 
                       onclick="salvarPalpiteFront(${partida.id}, this)">
                Salvar Palpite
               </button>
            `)
        }
        </div>

        ${partida.status === "FINISHED" ? `
          <div style="text-align: center; margin-top: 14px; color: #8b949e; font-size: 0.85rem; border-top: 1px dashed #30363d; padding-top: 8px;">
            Resultado Oficial: <strong style="color: #39ff14; font-size: 0.95rem;">${partida.gols_casa} × ${partida.gols_fora}</strong>
          </div>
        ` : ''}
      </article>
    `;
  };

  // 5. Construir o HTML final
  let htmlFinal = `
    <style>
      input.gols-casa::-webkit-outer-spin-button,
      input.gols-casa::-webkit-inner-spin-button,
      input.gols-fora::-webkit-outer-spin-button,
      input.gols-fora::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      input.gols-casa, input.gols-fora {
        -moz-appearance: textfield;
      }
    </style>
  `;

  // SEÇÃO NOVISSIMA: Se houver jogos hoje, renderiza no topo em destaque
  if (partidasDeHoje.length > 0) {
    htmlFinal += `
      <div class="date-group-header" style="margin: 1rem 0 1rem 0; padding-bottom: 8px; border-bottom: 2px solid var(--accent); color: var(--accent); font-weight: 800; font-size: 1.2rem; display: flex; align-items: center; gap: 8px; text-shadow: 0 0 10px rgba(57, 255, 20, 0.2);">
          JOGOS DE HOJE
      </div>
    `;
    htmlFinal += partidasDeHoje.map(partida => gerarCardHTML(partida)).join("");
  }

  // Listagem cronológica padrão abaixo
  for (const dataGrupo in gruposPorData) {
    htmlFinal += `
      <div class="date-group-header" style="margin: 2rem 0 1rem 0; padding-bottom: 8px; border-bottom: 2px solid #30363d; color: #8b949e; font-weight: bold; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;">
        <span></span> ${dataGrupo}
      </div>
    `;
    htmlFinal += gruposPorData[dataGrupo].map(partida => gerarCardHTML(partida)).join("");
  }

  listaContainer.innerHTML = htmlFinal;

  // Ouvinte do botão editar mapeando os inputs perfeitamente em qualquer seção
  listaContainer.querySelectorAll(".btn-editar").forEach(btn => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".match-card");
      card.querySelectorAll("input").forEach(i => i.disabled = false);
      btn.style.display = "none";
      card.querySelector(".btn-salvar").style.display = "inline-block";
    });
  });
}

async function salvarPalpiteFront(partidaId, botao) {
  // 1. Valida se o usuário está logado
  if (!exigirLogin()) return;

  // 2. Encontra o card e captura os valores dos inputs
  const card = botao.closest(".match-card");
  const golsCasaVal = card.querySelector(".gols-casa").value;
  const golsForaVal = card.querySelector(".gols-fora").value;

  if (golsCasaVal === "" || golsForaVal === "") {
    showToast("Por favor, preencha os dois placares antes de salvar.", "error");
    return;
  }

  // ✅ CORREÇÃO: Chaves alteradas para o padrão esperado pelo Pydantic do FastAPI
  const payload = {
    usuario_id: usuarioAtual.id,
    partida_id: partidaId,
    palpite_gols_casa: Number(golsCasaVal),
    palpite_gols_fora: Number(golsForaVal)
  };

  try {
    botao.disabled = true;
    const textoOriginal = botao.textContent;
    botao.textContent = "...";

    // 3. Envia para a API
    await api("/api/palpites", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    showToast("Palpite salvo com sucesso!");

    // 4. Recarrega as partidas para atualizar o cache e travar os campos com o botão "Editar"
    await carregarPartidas();

  } catch (err) {
    showToast(err.message, "error");
    // Se der erro, devolve o botão ao estado funcional
    botao.disabled = false;
    botao.textContent = "Atualizar";
  }
}

async function carregarMeusPalpitesExclusivos() {
  const lista = $("#myMatchesList");
  if (!usuarioAtual) {
    lista.innerHTML = '<div class="empty">Selecione ou cadastre um participante para ver os palpites salvos.</div>';
    return;
  }

  try {
    const partidas = await api("/api/partidas");
    await carregarPalpitesDoUsuario();

    if (!palpitesDoUsuario.length) {
      lista.innerHTML = '<div class="empty">Você ainda não realizou nenhum palpite. Vá na aba <strong>Jogos</strong> e faça as suas apostas!</div>';
      return;
    }

    const partidasPalpitadas = partidas.filter(p => palpitesDoUsuario.some(pt => pt.partida_id === p.id));

    lista.innerHTML = partidasPalpitadas.map((p) => {
      const st = statusPartida(p);
      const palpiteSalvo = palpitesDoUsuario.find(pt => pt.partida_id === p.id);

      return `
        <article class="match-card">
          <div class="match-header">
            <div>
              <div class="match-teams">${p.time_casa} <span style="color:var(--text-muted)">vs</span> ${p.time_fora}</div>
              <div class="match-meta">${formatarData(p.data_hora_jogo)}</div>
            </div>
            <span class="status-tag ${st.cls}">${st.label}</span>
          </div>
          <div style="display:flex; gap:2rem; align-items:center; flex-wrap:wrap;">
            <div>
              <span style="font-size:0.75rem; color:var(--text-muted); display:block; font-weight:600; text-transform:uppercase;">Seu Palpite</span>
              <div style="font-size:1.4rem; font-weight:800; color:var(--accent); text-shadow:var(--glow-green);">${palpiteSalvo.palpite_gols_casa} × ${palpiteSalvo.palpite_gols_fora}</div>
            </div>
            ${p.status === "FINISHED" ? `
            <div>
              <span style="font-size:0.75rem; color:var(--text-muted); display:block; font-weight:600; text-transform:uppercase;">Resultado Oficial</span>
              <div style="font-size:1.4rem; font-weight:800; color:var(--purple); text-shadow:var(--glow-purple);">${p.gols_casa} × ${p.gols_fora}</div>
            </div>` : ''}
          </div>
        </article>
      `;
    }).join("");

  } catch (err) {
    lista.innerHTML = `<div class="empty">Erro ao carregar seus palpites: ${err.message}</div>`;
  }
}

async function carregarRanking() {
  const tbody = $("#rankingBody");
  try {
    const ranking = await api("/api/ranking");
    if (!ranking.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">Nenhum participante ainda.</td></tr>';
      return;
    }

    tbody.innerHTML = ranking.map((r, i) => `
      <tr class="${i === 0 && r.pontos_totais > 0 ? "leader" : ""}">
        <td>${i + 1}º</td>
        <td>${r.nome}</td>
        <td class="pts">${r.pontos_totais}</td>
        <td>${r.acertos_cheios}</td>
        <td>${r.acertos_vencedor}</td>
      </tr>
    `).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">Erro: ${err.message}</td></tr>`;
  }
}

async function carregarPainelAdmin() {
  const lista = $("#adminMatchesList");
  if (!lista) return;
  try {
    const partidas = await api("/api/partidas");
    if (!partidas.length) {
      lista.innerHTML = '<div class="empty">Nenhum jogo cadastrado no sistema.</div>';
      return;
    }

    lista.innerHTML = partidas.map((p) => {
      return `
        <article class="match-card" data-admin-id="${p.id}">
          <div class="match-header" style="margin-bottom: 0.5rem;">
            <div class="match-teams">${p.time_casa} <span style="color:var(--text-muted)">vs</span> ${p.time_fora}</div>
            <div class="match-meta">${formatarData(p.data_hora_jogo)}</div>
          </div>
          <div class="form-row" style="background: var(--bg-elevated); padding: 0.75rem; border-radius: 8px; gap: 0.5rem;">
            <div class="field" style="min-width: 60px; flex: 1;">
              <label style="font-size: 0.75rem;">Gols Casa</label>
              <input type="number" class="admin-gols-casa" value="${p.gols_casa !== null ? p.gols_casa : ''}" min="0" style="padding: 0.4rem;">
            </div>
            <div class="field" style="min-width: 60px; flex: 1;">
              <label style="font-size: 0.75rem;">Gols Fora</label>
              <input type="number" class="admin-gols-fora" value="${p.gols_fora !== null ? p.gols_fora : ''}" min="0" style="padding: 0.4rem;">
            </div>
            <div class="field" style="flex: 2;">
              <label style="font-size: 0.75rem;">Status</label>
              <select class="admin-status" style="padding: 0.4rem; background: var(--bg-card); color: var(--text); border: 1px solid var(--border); border-radius: 6px; height: auto;">
                <option value="SCHEDULED" ${p.status === 'SCHEDULED' ? 'selected' : ''}>Agendado</option>
                <option value="IN_PLAY" ${p.status === 'IN_PLAY' ? 'selected' : ''}>Ao Vivo</option>
                <option value="FINISHED" ${p.status === 'FINISHED' ? 'selected' : ''}>Finalizado</option>
              </select>
            </div>
            <button class="btn btn-primary btn-admin-salvar" style="background: var(--danger); box-shadow: none; align-self: flex-end; padding: 0.5rem 1rem;">Salvar</button>
          </div>
        </article>
      `;
    }).join("");

    lista.querySelectorAll(".btn-admin-salvar").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".match-card");
        const partidaId = Number(card.dataset.adminId);
        const golsCasaVal = card.querySelector(".admin-gols-casa").value;
        const golsForaVal = card.querySelector(".admin-gols-fora").value;
        const status = card.querySelector(".admin-status").value;

        const payload = { status: status };
        payload.gols_casa = golsCasaVal !== "" ? Number(golsCasaVal) : null;
        payload.gols_fora = golsForaVal !== "" ? Number(golsForaVal) : null;

        try {
          btn.textContent = "...";
          btn.disabled = true;
          await api(`/api/admin/partidas/${partidaId}`, {
            method: "PUT",
            body: JSON.stringify(payload),
          });
          showToast("Partida updated com sucesso!");
        } catch (err) {
          showToast(err.message, "error");
        } finally {
          btn.textContent = "Salvar";
          btn.disabled = false;
        }
      });
    });

  } catch (err) {
    lista.innerHTML = `<div class="empty">Erro ao carregar painel admin: ${err.message}</div>`;
  }
}

// Controle de Abas
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("#panel-" + tab.dataset.tab).classList.add("active");

    if (tab.dataset.tab === "jogos") carregarPartidas();
    if (tab.dataset.tab === "meus-palpites") carregarMeusPalpitesExclusivos();
    if (tab.dataset.tab === "ranking") carregarRanking();
    if (tab.dataset.tab === "admin") carregarPainelAdmin();
  });
});

// Evento de Login
$("#btnSelecionar").addEventListener("click", async () => {
  const select = $("#selectUsuario");
  const id = select.value;
  const nome = select.selectedOptions[0]?.textContent;
  const senha = $("#inputSenhaLogin").value;

  if (!id) { showToast("Selecione um participante.", "error"); return; }
  if (!senha) { showToast("Digite a sua senha.", "error"); return; }

  try {
    const usuario = await api("/api/usuarios/login", {
      method: "POST",
      body: JSON.stringify({ nome, senha }),
    });
    await salvarUsuario(usuario);
    $("#inputSenhaLogin").value = "";
    showToast(`Bem-vindo, ${usuario.nome}!`);
  } catch (err) {
    showToast(err.message, "error");
  }
});

// Evento de Cadastro
$("#btnCadastrar").addEventListener("click", async () => {
  const nome = $("#inputNome").value.trim();
  const senha = $("#inputSenhaCadastro").value;

  if (!nome) { showToast("Digite seu nome.", "error"); return; }
  if (senha.length < 4) { showToast("A senha deve ter pelo menos 4 caracteres.", "error"); return; }

  try {
    const usuario = await api("/api/usuarios", {
      method: "POST",
      body: JSON.stringify({ nome, senha }),
    });
    await salvarUsuario(usuario);
    $("#inputNome").value = "";
    $("#inputSenhaCadastro").value = "";
    await carregarUsuarios();
    showToast(`Cadastro feito! Bem-vindo, ${nome}!`);
  } catch (err) {
    showToast(err.message, "error");
  }
});

// Logout
$("#btnLogout").addEventListener("click", async () => {
  usuarioAtual = null;
  localStorage.removeItem(STORAGE_KEY);
  await atualizarBarraUsuario();
  showToast("Você saiu do bolão.");
  document.querySelector('[data-tab="usuario"]').click();
});

async function importarCsvPadrao() {
  const btn = $("#btnImportarCsv");
  const hint = $("#syncHint");
  btn.disabled = true;
  btn.textContent = "Importando...";

  try {
    const res = await api("/api/admin/importar-copa", { method: "POST" });
    showToast(`${res.total} jogos importados de ${res.arquivo}!`);
    if (hint) hint.textContent = `Última importação: ${res.arquivo} — ${res.total} jogos no bolão.`;
    await carregarPartidas();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Importar CSV padrão";
  }
}

async function importarCsvArquivo(file) {
  const hint = $("#syncHint");
  const formData = new FormData();
  formData.append("arquivo", file);

  const res = await fetch("/api/admin/importar-copa/upload", {
    method: "POST",
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail;
    throw new Error(typeof detail === "string" ? detail : "Falha ao enviar CSV");
  }

  showToast(`${data.total} jogos importados de ${data.arquivo}!`);
  if (hint) hint.textContent = `Última importação: ${data.arquivo} — ${data.total} jogos no bolão.`;
  await carregarPartidas();
}

$("#btnImportarCsv").addEventListener("click", importarCsvPadrao);
$("#btnEnviarCsv").addEventListener("click", () => $("#inputCsv").click());
$("#inputCsv").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await importarCsvArquivo(file);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    e.target.value = "";
  }
});

$("#btnAtualizarJogos").addEventListener("click", carregarPartidas);
$("#btnAtualizarMeusPalpites").addEventListener("click", carregarMeusPalpitesExclusivos);
$("#btnAtualizarRanking").addEventListener("click", carregarRanking);
$("#btnAtualizarAdmin")?.addEventListener("click", carregarPainelAdmin);
$("#inputFiltroSelecao").addEventListener("input", renderizarPartidas);
$("#selectCampeonato")?.addEventListener("change", renderizarPartidas);

$("#btnAdminCriarJogo")?.addEventListener("click", async () => {
  const timeCasa = $("#adminNewTimeCasa").value.trim();
  const timeFora = $("#adminNewTimeFora").value.trim();
  const dataHoraRaw = $("#adminNewDataHora").value;

  if (!timeCasa || !timeFora || !dataHoraRaw) {
    showToast("Preencha todos os campos para criar o jogo.", "error");
    return;
  }

  const dataHoraIso = new Date(dataHoraRaw).toISOString();

  try {
    const btn = $("#btnAdminCriarJogo");
    btn.disabled = true;
    btn.textContent = "Adicionando...";

    await api("/api/admin/partidas", {
      method: "POST",
      body: JSON.stringify({
        time_casa: timeCasa,
        time_fora: timeFora,
        data_hora_jogo: dataHoraIso
      })
    });

    showToast("Novo jogo adicionado com sucesso!");
    $("#adminNewTimeCasa").value = "";
    $("#adminNewTimeFora").value = "";
    $("#adminNewDataHora").value = "";
    await carregarPainelAdmin();

  } catch (err) {
    showToast(err.message, "error");
  } finally {
    const btn = $("#btnAdminCriarJogo");
    btn.disabled = false;
    btn.textContent = "Adicionar";
  }
});

// Inicialização síncrona/assíncrona sequencial
async function init() {
  await atualizarBarraUsuario();
  await carregarUsuarios();
}
init();