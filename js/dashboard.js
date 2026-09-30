/*********************************
 * DASHBOARD.JS – FINAL E ESTÁVEL
 * + COPIAR + SHOW/HIDE
 * + PAINEL ADMIN (editar convênio + acessos adicionais)
 * + CHAMADOS (login / senha / link) com revisão facilitada
 *********************************/

const ICON_COPY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon-copy" aria-hidden="true"><path d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z"/></svg>`;

// logout global
window.logout = async function () {
  if (canalChamados) {
    await supabaseClient.removeChannel(canalChamados);
    canalChamados = null;
  }
  if (canalConvenios) {
    await supabaseClient.removeChannel(canalConvenios);
    canalConvenios = null;
  }
  await supabaseClient.auth.signOut();
  window.location.href = "index.html";
};

let conveniosCache = [];
let isAdmin = false;
let currentUserEmail = "";
let currentUserName = "";
let convenioAtual = null;       // convênio selecionado nos filtros
let acessosExtraAtual = [];     // acessos adicionais do convênio selecionado
let acessosNovoConvenio = [];   // acessos adicionais digitados na criação de um convênio
let chamadoEmRevisao = null;    // id do chamado sendo revisado no formulário do admin
let modoEdicaoConvenio = false; // true = campos de edição do convênio destravados
let modoCriacaoAtivo = false;   // true = campos de criação de novo convênio destravados

/* Chamados: os dados são buscados uma vez e filtrados em memória,
   por isso os botões de filtro respondem sem nova consulta ao banco. */
let chamadosCache = [];          // chamados carregados (admin: todos / usuário: só os dele)
let acessosChamadosCache = {};   // acessos adicionais referenciados pelos chamados
let filtroChamados = "aberto";   // filtro ativo — o painel sempre abre em "Em aberto"

/* Realtime / atualização automática — escopo restrito à tabela `chamados`. */
let canalChamados = null;            // canal WebSocket assinado
let recarregarChamadosTimer = null;  // debounce dos eventos
let ultimaRecargaChamados = 0;       // throttle da recarga ao focar a aba
let ultimoTotalAbertos = null;       // para detectar CRESCIMENTO da fila (null = 1ª renderização)
let canalConvenios = null;           // canal WebSocket de convenios / convenio_acessos
let recarregarConveniosTimer = null; // debounce dos eventos de convênio
let redesenhoConveniosPendente = false; // mudou algo enquanto a tela estava ocupada

/* ================= INIT ================= */
document.addEventListener("DOMContentLoaded", async () => {
  const { data: sessionData, error: sessionError } =
    await supabaseClient.auth.getSession();

  if (sessionError || !sessionData.session) {
    window.location.href = "index.html";
    return;
  }

  /* Trava de primeiro acesso: quem ainda não definiu a própria senha é
     mandado de volta para a tela de troca antes de qualquer consulta.
     Isso é só a camada visual — o bloqueio de verdade está nas políticas
     de RLS do banco (ver supabase-bloqueio-primeiro-acesso.sql), que
     impedem a leitura dos dados mesmo por fora do site. */
  const emailSessao = sessionData.session.user?.email || "";
  const { data: linhaUsuario } = await supabaseClient
    .from("usuarios")
    .select("primeiro_acesso")
    .eq("email", emailSessao)
    .maybeSingle();

  if (linhaUsuario?.primeiro_acesso) {
    window.location.href = "primeiro-acesso.html";
    return;
  }

  limparDados();
  prepararBotoesDeCopia();
  prepararPainelAdmin();
  prepararModalChamado();
  prepararModalCadastro();
  prepararFiltrosChamados();
  prepararRecargaAoFocar();

  await verificarPapel();

  const { data, error } = await supabaseClient
    .from("convenios")
    .select("*");

  if (error) {
    console.error("Erro ao carregar convênios:", error);
    alert("Não foi possível carregar os convênios.");
    await window.logout();
    return;
  }

  conveniosCache = data || [];
  carregarEmpresas();

  /* carregarChamados() dispara junto com verificarPapel(), antes de conveniosCache
     existir — sem este redesenho o "valor atual" do diff sai como "—". */
  if (chamadosCache.length > 0) renderizarChamados();
});

/* =====================================================
   PAPEL DO USUÁRIO (ADMIN x FUNCIONÁRIO)
===================================================== */
async function verificarPapel() {
  const { data: userData } = await supabaseClient.auth.getUser();
  const user = userData?.user;

  currentUserEmail = user?.email || "";
  currentUserName = user?.user_metadata?.full_name || currentUserEmail;

  exibirUsuarioLogado(currentUserEmail);

  const { data: userRow, error } = await supabaseClient
    .from("usuarios")
    .select("tipo")
    .eq("email", currentUserEmail)
    .maybeSingle();

  if (error) console.error("Erro ao verificar papel do usuário:", error);

  isAdmin = (userRow?.tipo || "").toString().toLowerCase() === "admin";
  aplicarVisibilidadeAdmin();
}

function exibirUsuarioLogado(email) {
  const el = document.getElementById("usuarioLogado");
  if (!el) return;

  const nomeCurto = (email || "").split("@")[0] || "";
  el.textContent = nomeCurto; // a sidebar já mostra o contexto (avatar + papel)
}

function aplicarVisibilidadeAdmin() {
  const painelChamados = document.getElementById("painelChamados");
  const painelUsuarios = document.getElementById("painelUsuarios");

  if (painelUsuarios) painelUsuarios.hidden = !isAdmin;

  // Edição e criação de convênio não são mais painéis na página: viraram
  // modais, abertos pelos MESMOS dois botões que o usuário comum usa para
  // abrir chamado (ver aplicarBotoesContextuais).
  aplicarBotoesContextuais();

  // O painel de chamados agora aparece para todo mundo: o admin enxerga
  // a fila inteira e atende; o usuário comum acompanha só os próprios.
  if (painelChamados) painelChamados.hidden = false;

  const tituloChamados = document.getElementById("tituloChamados");
  if (tituloChamados) {
    tituloChamados.textContent = isAdmin ? "Chamados de alteração" : "Meus chamados";
  }

  carregarChamados();
  assinarChamadosRealtime();
  assinarConveniosRealtime();

  if (isAdmin) {
    carregarUsuarios();
  }
}

/* =====================================================
   BOTÕES CONTEXTUAIS (mesma posição, ação conforme o papel)

   Usuário comum abre chamado; admin não precisa de chamado —
   ele resolve direto, então os dois botões viram atalhos para
   os modais administrativos.

       posição                 | usuário                        | admin
       ------------------------|--------------------------------|---------------------
       dentro do card de dados | Solicitar alteração de acesso   | Editar convênio
       abaixo do card          | + Solicitar cadastro de convênio| + Criar novo convênio
===================================================== */
function aplicarBotoesContextuais() {
  const btnPrincipal = document.getElementById("btnChamado");
  if (btnPrincipal) {
    btnPrincipal.textContent = isAdmin ? "Editar convênio" : "Solicitar alteração de acesso";
    btnPrincipal.title = isAdmin
      ? "Editar os dados deste convênio"
      : "Pedir a um administrador que altere este acesso";
  }

  const btnSecundario = document.getElementById("btnCadastrarAcesso");
  if (btnSecundario) {
    btnSecundario.textContent = isAdmin ? "+ Criar novo convênio" : "+ Solicitar cadastro de convênio";
  }

  const dica = document.getElementById("cadastroDica");
  if (dica) {
    dica.textContent = isAdmin
      ? "Cadastre um convênio direto no Locus."
      : "Tem um login de convênio que ainda não está no Locus? Envie para aprovação.";
  }
}

/* =====================================================
   MODAL — EDITAR CONVÊNIO (admin)

   Abre já destravado: clicar no botão JÁ É a intenção de editar,
   então não existe mais um segundo passo "Editar convênio".
   manterRevisao = true quando o formulário acabou de ser preenchido
   por um chamado em revisão (não pode ser sobrescrito pelos valores
   originais do convênio).
===================================================== */
function abrirModalEdicao({ manterRevisao = false } = {}) {
  if (!isAdmin || !convenioAtual) return;

  const modal = document.getElementById("modalEdicao");
  if (!modal) return;

  if (!manterRevisao) {
    preencherFormularioEdicao(convenioAtual, { iniciarEditando: true });
  } else {
    modoEdicaoConvenio = true;
    aplicarModoEdicaoConvenio();
  }

  modal.hidden = false;
  document.getElementById("editConvenioNome")?.focus();
}

async function fecharModalEdicao() {
  const modal = document.getElementById("modalEdicao");
  if (modal) modal.hidden = true;

  modoEdicaoConvenio = false;

  // descarta destaques/aviso de revisão e devolve o formulário aos
  // valores originais do convênio selecionado
  cancelarRevisao();
  aplicarModoEdicaoConvenio();

  // descarta também as edições não salvas nos acessos adicionais,
  // que vivem em memória (acessosExtraAtual) e não no formulário
  if (convenioAtual) await carregarAcessosExtra(convenioAtual.id);

  aplicarRedesenhoPendente();
}

/* =====================================================
   MODAL — CRIAR NOVO CONVÊNIO (admin)
===================================================== */
function abrirModalNovoConvenio({ manterDados = false } = {}) {
  if (!isAdmin) return;

  const modal = document.getElementById("modalNovoConvenio");
  if (!modal) return;

  if (!manterDados) {
    limparFormularioCriacao();
  }

  modoCriacaoAtivo = true;
  aplicarModoCriacao();

  modal.hidden = false;
  document.getElementById("novoEmpresa")?.focus();
}

function fecharModalNovoConvenio() {
  const modal = document.getElementById("modalNovoConvenio");
  if (modal) modal.hidden = true;

  modoCriacaoAtivo = false;
  chamadoEmRevisao = null;
  aplicarModoCriacao();
  aplicarRedesenhoPendente();
}

/* =====================================================
   ATUALIZAÇÃO AUTOMÁTICA DOS CHAMADOS

   Escopo deliberadamente estreito: o único efeito de um evento é
   recarregar o painel de chamados (badge + contadores + lista).
   Convênios, formulário de edição, selects e modais NÃO são tocados,
   então quem está consultando um convênio não é interrompido.
===================================================== */
function assinarChamadosRealtime() {
  if (canalChamados) return;

  const assinatura = { event: "*", schema: "public", table: "chamados" };

  // Usuário comum só assina os próprios chamados — menos tráfego e
  // nenhum dado de terceiro chegando ao navegador dele.
  if (!isAdmin) {
    assinatura.filter = `usuario=eq.${currentUserEmail}`;
  }

  canalChamados = supabaseClient
    .channel("painel-chamados")
    .on("postgres_changes", assinatura, () => agendarRecargaChamados())
    .subscribe(status => {
      if (status === "SUBSCRIBED") {
        // pega o que mudou enquanto a conexão esteve fora do ar
        agendarRecargaChamados();
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        console.warn(
          "Realtime de chamados indisponível (" + status + "). " +
          "A lista continua sendo atualizada quando a aba volta ao foco."
        );
      }
    });
}

/* O payload do evento é ignorado de propósito: nada que vem pelo socket
   é renderizado. O que aparece na tela vem sempre de uma nova consulta,
   que já passa pelo RLS e pelo filtro por usuário. */
function agendarRecargaChamados() {
  clearTimeout(recarregarChamadosTimer);
  recarregarChamadosTimer = setTimeout(carregarChamados, 400);
}

/* Rede de segurança: se o WebSocket cair ou o realtime não estiver
   habilitado na tabela, a lista ainda atualiza quando a pessoa volta
   para a aba (no máximo uma consulta a cada 15s). */
function prepararRecargaAoFocar() {
  const aoVoltar = () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - ultimaRecargaChamados < 15000) return;
    carregarChamados();
  };

  document.addEventListener("visibilitychange", aoVoltar);
  window.addEventListener("focus", aoVoltar);
}

/* =====================================================
   ATUALIZAÇÃO AUTOMÁTICA DOS CONVÊNIOS

   Um convênio criado, editado ou excluído por qualquer pessoa aparece
   na hora para todo mundo — sem recarregar a página e SEM interromper
   quem está no meio de alguma coisa (ver telaOcupada()).
===================================================== */
function assinarConveniosRealtime() {
  if (canalConvenios) return;

  canalConvenios = supabaseClient
    .channel("painel-convenios")
    .on("postgres_changes", { event: "*", schema: "public", table: "convenios" },
        () => agendarSincronizacaoConvenios())
    .on("postgres_changes", { event: "*", schema: "public", table: "convenio_acessos" },
        () => agendarSincronizacaoConvenios())
    .subscribe(status => {
      if (status === "SUBSCRIBED") agendarSincronizacaoConvenios();
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        console.warn(
          "Realtime de convênios indisponível (" + status + "). " +
          "A lista continua sendo atualizada quando a aba volta ao foco."
        );
      }
    });
}

function agendarSincronizacaoConvenios() {
  clearTimeout(recarregarConveniosTimer);
  recarregarConveniosTimer = setTimeout(sincronizarConvenios, 400);
}

/* A tela está "ocupada" quando mexer nela faria a pessoa perder trabalho
   ou agir sobre um dado que ela ainda nem viu mudar. Nesses casos o cache
   é atualizado em silêncio e o redesenho fica pendente. */
function telaOcupada() {
  if (modoEdicaoConvenio || modoCriacaoAtivo || chamadoEmRevisao) return true;

  const modais = ["modalChamado", "modalCadastro", "modalEdicao", "modalNovoConvenio"];

  return modais.some(id => {
    const el = document.getElementById(id);
    return el && !el.hidden;
  });
}

async function sincronizarConvenios() {
  const { data, error } = await supabaseClient.from("convenios").select("*");

  if (error) {
    console.error("Erro ao sincronizar convênios:", error);
    return;
  }

  conveniosCache = data || [];

  if (telaOcupada()) {
    redesenhoConveniosPendente = true;
    mostrarAvisoAtualizacao();
    return;
  }

  redesenhoConveniosPendente = false;
  redesenharConvenios();
}

/* Chamado quando a edição/criação termina (aplicarModoEdicaoConvenio /
   aplicarModoCriacao) e quando um modal fecha. */
function aplicarRedesenhoPendente() {
  if (!redesenhoConveniosPendente || telaOcupada()) return;
  redesenhoConveniosPendente = false;
  redesenharConvenios();
}

/* Reconstrói os selects e a exibição PRESERVANDO a seleção da pessoa.
   Atribuir .value num <select> não dispara onchange, então nada é
   recarregado sem necessidade. */
function redesenharConvenios() {
  const selectEmpresa  = document.getElementById("selectEmpresa");
  const selectConvenio = document.getElementById("selectConvenio");
  if (!selectEmpresa || !selectConvenio) return;

  const empresaSelecionada  = selectEmpresa.value;
  const convenioSelecionado = selectConvenio.value;

  carregarEmpresas();
  selectEmpresa.value = empresaSelecionada;

  // a empresa que estava selecionada não existe mais em nenhum convênio
  if (empresaSelecionada && selectEmpresa.value !== empresaSelecionada) {
    limparDados();
    return;
  }

  if (!empresaSelecionada) return;

  carregarConvenios(empresaSelecionada);
  selectConvenio.value = convenioSelecionado;

  if (!convenioSelecionado) return;

  const atualizado = conveniosCache.find(
    x => x.empresa === empresaSelecionada && x.convenio === convenioSelecionado
  );

  // o convênio aberto na tela foi excluído ou renomeado por outra pessoa
  if (!atualizado) {
    limparDados();
    document.getElementById("outEmpresa").textContent = empresaSelecionada;
    mostrarAvisoAtualizacao("O convênio que estava aberto foi alterado ou removido por outro usuário.");
    return;
  }

  convenioAtual = atualizado;
  document.getElementById("outEmpresa").textContent = atualizado.empresa;
  document.getElementById("outConvenio").textContent = atualizado.convenio;
  atualizarExibicaoConvenio(atualizado);
  document.getElementById("btnChamado").disabled = false;

  carregarAcessosExtra(atualizado.id);

  if (isAdmin) preencherFormularioEdicao(atualizado);

  setCopyState();
}

/* Aviso discreto no canto da tela — nunca bloqueia nem rouba o foco */
function mostrarAvisoAtualizacao(texto) {
  const el = document.getElementById("avisoAtualizacao");
  if (!el) return;

  el.textContent = texto ||
    "Os convênios foram atualizados por outro usuário. As mudanças aparecem quando você terminar o que está fazendo.";
  el.hidden = false;

  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, 6000);
}

/* ================= EMPRESAS ================= */
function carregarEmpresas() {
  const selectEmpresa = document.getElementById("selectEmpresa");
  selectEmpresa.length = 1;

  const empresas = [...new Set(conveniosCache.map(c => c.empresa))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  empresas.forEach(emp => {
    const opt = document.createElement("option");
    opt.value = emp;
    opt.textContent = emp;
    selectEmpresa.appendChild(opt);
  });

  selectEmpresa.onchange = () => {
    limparDados();
    const empresa = selectEmpresa.value;
    document.getElementById("outEmpresa").textContent = empresa || "—";
    carregarConvenios(empresa);
  };
}

/* ================= CONVÊNIOS ================= */
function carregarConvenios(empresa) {
  const selectConvenio = document.getElementById("selectConvenio");
  selectConvenio.innerHTML = '<option value="">Selecione o convênio</option>';
  selectConvenio.disabled = !empresa;

  if (!empresa) {
    setCopyState();
    return;
  }

  const convenios = conveniosCache
    .filter(c => c.empresa === empresa)
    .map(c => c.convenio)
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  convenios.forEach(conv => {
    const opt = document.createElement("option");
    opt.value = conv;
    opt.textContent = conv;
    selectConvenio.appendChild(opt);
  });

  selectConvenio.onchange = () => {
    const selecionado = selectConvenio.value;
    const c = conveniosCache.find(
      x => x.empresa === empresa && x.convenio === selecionado
    );

    // Voltar para "Selecione o convênio" devolve a tela ao estado inicial
    // (rótulo, link, login, senha e observação zerados), mas a lista
    // continua aberta para escolher outro convênio.
    if (!c) {
      limparDados();
      return;
    }

    cancelarRevisao();
    selecionarConvenio(c);
  };
}

async function selecionarConvenio(c) {
  convenioAtual = c;
  // A empresa vem do próprio convênio. Antes ela só era escrita ao trocar
  // o select de empresa; depois de voltar para "Selecione o convênio"
  // (que limpa a ficha inteira), escolher outro convênio deixava "—".
  document.getElementById("outEmpresa").textContent = c.empresa;
  document.getElementById("outConvenio").textContent = c.convenio;
  atualizarExibicaoConvenio(c);
  document.getElementById("btnChamado").disabled = false;

  await carregarAcessosExtra(c.id);

  if (isAdmin) preencherFormularioEdicao(c);

  setCopyState();
}

/* Atualiza os campos Link / Login / Senha / Observação exibidos na tela */
function atualizarExibicaoConvenio(c) {
  const rotuloEl = document.getElementById("outRotuloPrincipal");
  if (rotuloEl) {
    if (c.rotulo && c.rotulo.trim() !== "") {
      rotuloEl.textContent = c.rotulo;
      rotuloEl.hidden = false;
    } else {
      rotuloEl.textContent = "";
      rotuloEl.hidden = true;
    }
  }

  const linkEl = document.getElementById("outLink");

  if (c.link && c.link.trim() !== "") {
    const url = c.link.startsWith("http") ? c.link : "https://" + c.link;
    linkEl.href = url;
    linkEl.target = "_blank";
    linkEl.rel = "noopener noreferrer";
    linkEl.textContent = url;
    linkEl.removeAttribute("aria-disabled");
    linkEl.classList.remove("link-desabilitado");
  } else {
    linkEl.textContent = "—";
    linkEl.removeAttribute("href");
    linkEl.removeAttribute("target");
    linkEl.setAttribute("aria-disabled", "true");
    linkEl.classList.add("link-desabilitado");
  }

  document.getElementById("outLogin").textContent = safeText(c.login);
  document.getElementById("outSenha").textContent = safeText(c.senha);
  document.getElementById("outObservacao").textContent = safeText(c.observacao);
}

/* =====================================================
   ACESSOS ADICIONAIS (convênios com mais de 1 link/login/senha)
===================================================== */
async function carregarAcessosExtra(convenioId) {
  const { data, error } = await supabaseClient
    .from("convenio_acessos")
    .select("*")
    .eq("convenio_id", convenioId)
    .order("ordem", { ascending: true });

  if (error) {
    console.error("Erro ao carregar acessos adicionais:", error);
    acessosExtraAtual = [];
  } else {
    acessosExtraAtual = (data || []).map(a => ({ ...a, _removido: false }));
  }

  renderizarOutrosAcessosView();
  if (isAdmin) renderizarAcessosExtraForm();
}

function renderizarOutrosAcessosView() {
  const container = document.getElementById("outrosAcessos");
  const lista = document.getElementById("listaOutrosAcessos");
  if (!container || !lista) return;

  const validos = acessosExtraAtual.filter(a => !a._removido && (a.link || a.login || a.senha));

  if (validos.length === 0) {
    container.hidden = true;
    lista.innerHTML = "";
    return;
  }

  container.hidden = false;
  lista.innerHTML = "";

  validos.forEach(a => {
    const card = document.createElement("div");
    card.className = "acesso-extra-card";

    const titulo = document.createElement("p");
    titulo.className = "acesso-extra-titulo";
    titulo.textContent = a.rotulo || "Acesso adicional";
    card.appendChild(titulo);

    if (a.link) card.appendChild(criarLinhaAcessoView("Link", a.link, true));
    if (a.login) card.appendChild(criarLinhaAcessoView("Login", a.login));
    if (a.senha) card.appendChild(criarLinhaAcessoView("Senha", a.senha));

    // Só o usuário comum abre chamado por aqui. O admin edita (ou remove)
    // os acessos adicionais dentro do próprio modal "Editar convênio",
    // na subseção "Acessos adicionais".
    if (!isAdmin) {
      const btnSolicitar = document.createElement("button");
      btnSolicitar.type = "button";
      btnSolicitar.className = "btn-verde btn-small btn-solicitar-extra";
      btnSolicitar.textContent = "Solicitar alteração deste acesso";
      btnSolicitar.onclick = () => abrirModalSolicitacao({
        acessoId: a.id,
        rotulo: a.rotulo || null,
        login: a.login,
        senha: a.senha,
        link: a.link
      });
      card.appendChild(btnSolicitar);
    }

    lista.appendChild(card);
  });
}

function criarLinhaAcessoView(rotulo, valor, ehLink) {
  const p = document.createElement("p");

  const strong = document.createElement("strong");
  strong.textContent = rotulo; // o layout em grade já separa rótulo e valor
  p.appendChild(strong);

  if (ehLink) {
    const url = valor.startsWith("http") ? valor : "https://" + valor;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = url;
    p.appendChild(a);
    p.appendChild(criarBotaoCopiar(url, "link"));
  } else {
    const span = document.createElement("span");
    span.textContent = valor;
    p.appendChild(span);
    p.appendChild(criarBotaoCopiar(valor, rotulo.toLowerCase()));
  }

  return p;
}

function criarBotaoCopiar(valor, label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-copy";
  btn.title = `Copiar ${label}`;
  btn.setAttribute("aria-label", `Copiar ${label}`);
  btn.innerHTML = ICON_COPY_SVG;
  btn.addEventListener("click", () => copyToClipboard(valor));
  return btn;
}

/* Formulário de administração dos acessos adicionais */
/* Edição dos acessos adicionais do convênio SELECIONADO (modal "Editar convênio") */
function renderizarAcessosExtraForm() {
  montarLinhasAcesso(
    "listaAcessosExtra",
    acessosExtraAtual,
    !!(convenioAtual && modoEdicaoConvenio),
    renderizarAcessosExtraForm
  );
}

/* Acessos adicionais digitados junto com um convênio NOVO (modal "Criar novo convênio").
   Ficam só em memória até o convênio existir — só aí eles ganham um convenio_id. */
function renderizarAcessosNovoConvenioForm() {
  montarLinhasAcesso(
    "listaAcessosNovo",
    acessosNovoConvenio,
    modoCriacaoAtivo,
    renderizarAcessosNovoConvenioForm
  );
}

/* Monta as linhas de rótulo/link/login/senha + botão remover.
   `itens` é o array em memória: digitar já atualiza o objeto da linha. */
function montarLinhasAcesso(listaId, itens, editavel, redesenhar) {
  const lista = document.getElementById(listaId);
  if (!lista) return;

  lista.innerHTML = "";

  itens.forEach((a, idx) => {
    if (a._removido) return;

    const linha = document.createElement("div");
    linha.className = "acesso-extra-linha";

    // Os inputs são criados via DOM e preenchidos por .value, que nunca interpreta
    // HTML. Isso dispensa qualquer função de escape manual.
    const CAMPOS_ACESSO = [
      { chave: "rotulo", classe: "ae-rotulo", placeholder: "Rótulo (ex: Acesso financeiro)" },
      { chave: "link",   classe: "ae-link",   placeholder: "Link" },
      { chave: "login",  classe: "ae-login",  placeholder: "Login" },
      { chave: "senha",  classe: "ae-senha",  placeholder: "Senha" }
    ];

    CAMPOS_ACESSO.forEach(({ chave, classe, placeholder }) => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = classe;
      input.placeholder = placeholder;
      input.value = a[chave] || "";
      input.disabled = !editavel;
      input.addEventListener("input", e => { a[chave] = e.target.value; });
      linha.appendChild(input);
    });

    const btnRemover = document.createElement("button");
    btnRemover.type = "button";
    btnRemover.className = "btn-vermelho btn-small";
    btnRemover.textContent = "Remover";
    btnRemover.disabled = !editavel;
    btnRemover.onclick = () => {
      // linha que já existe no banco é marcada para exclusão ao salvar;
      // linha nova some na hora
      if (a.id) {
        a._removido = true;
      } else {
        itens.splice(idx, 1);
      }
      redesenhar();
    };
    linha.appendChild(btnRemover);

    lista.appendChild(linha);
  });
}

/* =====================================================
   HELPERS DE DOM
   Constroem elementos em vez de montar HTML por string.
   Texto entra sempre por textContent, que o navegador trata
   como texto puro — não há o que escapar.
===================================================== */
function criarP(className, ...conteudo) {
  const p = document.createElement("p");
  if (className) p.className = className;
  conteudo.forEach(item => {
    if (item === null || item === undefined) return;
    p.appendChild(item instanceof Node ? item : document.createTextNode(String(item)));
  });
  return p;
}

function criarForte(texto) {
  const strong = document.createElement("strong");
  strong.textContent = texto ?? "";
  return strong;
}

async function salvarAcessosExtra(convenioId) {
  const paraExcluir = acessosExtraAtual.filter(a => a._removido && a.id);
  for (const a of paraExcluir) {
    await supabaseClient.from("convenio_acessos").delete().eq("id", a.id);
  }

  const paraAtualizar = acessosExtraAtual.filter(a => !a._removido && a.id);
  for (const a of paraAtualizar) {
    await supabaseClient.from("convenio_acessos")
      .update({ rotulo: a.rotulo || null, link: a.link || null, login: a.login || null, senha: a.senha || null })
      .eq("id", a.id);
  }

  const paraInserir = acessosExtraAtual
    .filter(a => !a._removido && !a.id && (a.rotulo || a.link || a.login || a.senha))
    .map((a, i) => ({
      convenio_id: convenioId,
      rotulo: a.rotulo || null,
      link: a.link || null,
      login: a.login || null,
      senha: a.senha || null,
      ordem: i
    }));

  if (paraInserir.length > 0) {
    await supabaseClient.from("convenio_acessos").insert(paraInserir);
  }

  await carregarAcessosExtra(convenioId);
}

/* ================= COPIAR (campos principais) ================= */
function prepararBotoesDeCopia() {
  const btnCopyLink  = document.getElementById("copyLink");
  const btnCopyLogin = document.getElementById("copyLogin");
  const btnCopySenha = document.getElementById("copySenha");

  if (btnCopyLink)  btnCopyLink.addEventListener("click", async () => { await copyToClipboard(getValueForCopyLink()); });
  if (btnCopyLogin) btnCopyLogin.addEventListener("click", async () => { await copyToClipboard(getTextFrom("outLogin")); });
  if (btnCopySenha) btnCopySenha.addEventListener("click", async () => { await copyToClipboard(getTextFrom("outSenha")); });
}

function setCopyState() {
  toggleCopyVisibility("copyLink",  !!getValueForCopyLink());
  toggleCopyVisibility("copyLogin", !!getTextFrom("outLogin"));
  toggleCopyVisibility("copySenha", !!getTextFrom("outSenha"));
}

function toggleCopyVisibility(btnId, show) {
  const btn = document.getElementById(btnId);
  if (!btn) return;

  if (show) {
    btn.disabled = false;
    btn.removeAttribute("hidden");
    btn.style.display = "inline-block";
  } else {
    btn.disabled = true;
    btn.setAttribute("hidden", "");
    btn.style.display = "none";
  }
}

function getValueForCopyLink() {
  const a = document.getElementById("outLink");
  const href = a.getAttribute("href");
  const disabled = a.getAttribute("aria-disabled") === "true";
  return (!disabled && href) ? href : "";
}

function getTextFrom(id) {
  const el = document.getElementById(id);
  const t = (el?.textContent || "").trim();
  return (t && t !== "—") ? t : "";
}

function safeText(v) {
  const t = (v ?? "").toString().trim();
  return t ? t : "—";
}

async function copyToClipboard(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (err) {
      console.error("Falha ao copiar:", err);
    }
  }
}

/* =====================================================
   PAINEL ADMIN — EDIÇÃO DO CONVÊNIO
===================================================== */
function prepararPainelAdmin() {
  document.getElementById("btnSalvarConvenio")?.addEventListener("click", salvarConvenio);
  document.getElementById("btnCancelarRevisao")?.addEventListener("click", cancelarRevisao);
  document.getElementById("btnCriarConvenio")?.addEventListener("click", criarConvenio);
  document.getElementById("btnCancelarEdicao")?.addEventListener("click", cancelarEdicaoConvenio);
  document.getElementById("btnExcluirConvenio")?.addEventListener("click", excluirConvenio);
  document.getElementById("btnCancelarNovoConvenio")?.addEventListener("click", cancelarNovoConvenio);

  // Fechar os modais administrativos (X, clique fora e tecla Esc)
  document.getElementById("btnFecharModalEdicao")?.addEventListener("click", fecharModalEdicao);
  document.getElementById("btnFecharModalNovoConvenio")?.addEventListener("click", fecharModalNovoConvenio);

  fecharAoClicarFora("modalEdicao", fecharModalEdicao);
  fecharAoClicarFora("modalNovoConvenio", fecharModalNovoConvenio);

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    const edicao = document.getElementById("modalEdicao");
    const criacao = document.getElementById("modalNovoConvenio");
    if (edicao && !edicao.hidden) return fecharModalEdicao();
    if (criacao && !criacao.hidden) return fecharModalNovoConvenio();
  });

  document.getElementById("btnAddAcesso")?.addEventListener("click", () => {
    acessosExtraAtual.push({ id: null, rotulo: "", link: "", login: "", senha: "", ordem: acessosExtraAtual.length, _removido: false });
    renderizarAcessosExtraForm();
  });

  document.getElementById("btnAddAcessoNovo")?.addEventListener("click", () => {
    acessosNovoConvenio.push({ id: null, rotulo: "", link: "", login: "", senha: "", ordem: acessosNovoConvenio.length, _removido: false });
    renderizarAcessosNovoConvenioForm();
  });

  // Nome do convênio sempre em maiúsculas (criação e edição), sem perder a posição do cursor
  forcarMaiusculas("novoConvenioNome");
  forcarMaiusculas("editConvenioNome");

  // Os dois formulários começam travados; só destravam quando o modal
  // correspondente é aberto pelo admin.
  aplicarModoEdicaoConvenio();
  aplicarModoCriacao();
}

/* Fecha o modal quando o clique acontece no fundo escuro, fora do card */
function fecharAoClicarFora(modalId, aoFechar) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  modal.addEventListener("click", e => {
    if (e.target === modal) aoFechar();
  });
}

/* Converte o valor do campo para maiúsculas a cada digitação, mantendo o cursor no lugar */
function forcarMaiusculas(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;

  input.addEventListener("input", () => {
    const posicaoCursor = input.selectionStart;
    input.value = input.value.toUpperCase();
    input.setSelectionRange(posicaoCursor, posicaoCursor);
  });
}

/* =====================================================
   PAINEL ADMIN — CRIAR NOVO CONVÊNIO
===================================================== */

/* Cancela a criação em andamento, limpando todos os campos do formulário */
const CAMPOS_CRIACAO_IDS = ["novoEmpresa", "novoConvenioNome", "novoRotulo", "novoLink", "novoLogin", "novoSenha", "novoObservacao"];

/* Aplica o estado visual/de bloqueio do painel de criação, conforme modoCriacaoAtivo */
function aplicarModoCriacao() {
  CAMPOS_CRIACAO_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !modoCriacaoAtivo;
  });

  const btnCriar = document.getElementById("btnCriarConvenio");
  if (btnCriar) { btnCriar.hidden = !modoCriacaoAtivo; btnCriar.disabled = !modoCriacaoAtivo; }

  const btnCancelar = document.getElementById("btnCancelarNovoConvenio");
  if (btnCancelar) { btnCancelar.hidden = !modoCriacaoAtivo; btnCancelar.disabled = !modoCriacaoAtivo; }

  const btnAddAcessoNovo = document.getElementById("btnAddAcessoNovo");
  if (btnAddAcessoNovo) btnAddAcessoNovo.disabled = !modoCriacaoAtivo;

  renderizarAcessosNovoConvenioForm();

  if (!modoCriacaoAtivo) aplicarRedesenhoPendente();
}

/* Esvazia os campos e a mensagem do formulário de criação */
function limparFormularioCriacao() {
  CAMPOS_CRIACAO_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  acessosNovoConvenio = [];
  renderizarAcessosNovoConvenioForm();

  const msg = document.getElementById("msgCriarConvenio");
  if (msg) { msg.textContent = ""; msg.classList.remove("erro"); }
}

/* Cancela a criação em andamento: limpa os campos e fecha o modal */
function cancelarNovoConvenio() {
  limparFormularioCriacao();
  fecharModalNovoConvenio();
}

async function criarConvenio() {
  const msg = document.getElementById("msgCriarConvenio");
  // guardado antes de cancelarRevisao(), que zera a variável global
  const idChamadoRevisao = chamadoEmRevisao;

  const empresa    = document.getElementById("novoEmpresa").value.trim();
  const convenio   = document.getElementById("novoConvenioNome").value.trim().toUpperCase();
  const rotulo     = document.getElementById("novoRotulo").value.trim();
  const link       = document.getElementById("novoLink").value.trim();
  const login      = document.getElementById("novoLogin").value.trim();
  const senha      = document.getElementById("novoSenha").value.trim();
  const observacao = document.getElementById("novoObservacao").value.trim();

  if (!empresa || !convenio) {
    msg.textContent = "Preencha ao menos Empresa e Convênio.";
    msg.classList.add("erro");
    return;
  }

  const jaExiste = conveniosCache.some(c =>
    c.empresa.toLowerCase() === empresa.toLowerCase() &&
    c.convenio.toLowerCase() === convenio.toLowerCase()
  );
  if (jaExiste) {
    msg.textContent = "Já existe um convênio com essa Empresa e Convênio. Edite o existente em vez de criar outro.";
    msg.classList.add("erro");
    return;
  }

  const { data, error } = await supabaseClient
    .from("convenios")
    .insert({
      empresa,
      convenio,
      rotulo: rotulo || null,
      link: link || null,
      login: login || null,
      senha: senha || null,
      observacao: observacao || null
    })
    .select()
    .single();

  if (error) {
    console.error("Erro ao criar convênio:", error);
    msg.textContent = "Erro ao criar convênio.";
    msg.classList.add("erro");
    return;
  }

  conveniosCache.push(data);

  // Acessos adicionais só podem ser gravados agora, porque só agora
  // existe o convenio_id para apontar.
  const acessosParaInserir = acessosNovoConvenio
    .filter(a => !a._removido && (a.rotulo || a.link || a.login || a.senha))
    .map((a, i) => ({
      convenio_id: data.id,
      rotulo: a.rotulo || null,
      link: a.link || null,
      login: a.login || null,
      senha: a.senha || null,
      ordem: i
    }));

  let avisoAcessos = "";

  if (acessosParaInserir.length > 0) {
    const { error: errAcessos } = await supabaseClient
      .from("convenio_acessos")
      .insert(acessosParaInserir);

    if (errAcessos) {
      console.error("Erro ao salvar os acessos adicionais do novo convênio:", errAcessos);
      avisoAcessos = " O convênio foi criado, mas os acessos adicionais não foram salvos — acrescente-os pelo \"Editar convênio\".";
    }
  }

  msg.classList.remove("erro");
  msg.textContent = "Convênio criado com sucesso!" + avisoAcessos;
  if (avisoAcessos) msg.classList.add("erro");

  CAMPOS_CRIACAO_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  acessosNovoConvenio = [];
  modoCriacaoAtivo = false;
  aplicarModoCriacao();

  // atualiza os selects e já abre o convênio recém-criado para conferência
  carregarEmpresas();
  const selectEmpresa = document.getElementById("selectEmpresa");
  selectEmpresa.value = data.empresa;
  carregarConvenios(data.empresa);
  document.getElementById("selectConvenio").value = data.convenio;

  cancelarRevisao();
  selecionarConvenio(data);

  if (idChamadoRevisao) {
    chamadoEmRevisao = null;
    await atualizarStatusChamado(idChamadoRevisao, "concluido");
    msg.classList.remove("erro");
    msg.textContent = "Convênio criado e chamado concluído!";
  }

  // dá tempo de ler a confirmação antes de o modal sair da frente;
  // se algo deu errado com os acessos, o modal fica aberto com o aviso
  if (!avisoAcessos) setTimeout(fecharModalNovoConvenio, 1300);
}

/* Seleciona a empresa no <select>; se o valor salvo não bater com nenhuma
   das opções fixas (dado antigo, digitado antes dessa lista existir),
   adiciona uma opção temporária em vez de simplesmente apagar o valor. */
function ajustarSelectEmpresa(selectEl, valor) {
  if (!selectEl) return;

  if (!valor) {
    selectEl.value = "";
    return;
  }

  const existe = Array.from(selectEl.options).some(o => o.value === valor);
  if (!existe) {
    const opt = document.createElement("option");
    opt.value = valor;
    opt.textContent = `${valor} (fora do padrão — selecione uma das opções para corrigir)`;
    selectEl.appendChild(opt);
  }

  selectEl.value = valor;
}

const CAMPOS_EDICAO_IDS = ["editEmpresa", "editConvenioNome", "editRotulo", "editLink", "editLogin", "editSenha", "editObservacao"];

/* Aplica o estado visual/de bloqueio do painel de edição, conforme
   modoEdicaoConvenio (destravado) e a existência de um convênio selecionado. */
function aplicarModoEdicaoConvenio() {
  const temConvenio = !!convenioAtual;
  const editando = temConvenio && modoEdicaoConvenio;

  CAMPOS_EDICAO_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !editando;
  });

  const btnAddAcesso = document.getElementById("btnAddAcesso");
  if (btnAddAcesso) btnAddAcesso.disabled = !editando;

  const btnSalvar = document.getElementById("btnSalvarConvenio");
  if (btnSalvar) {
    btnSalvar.hidden = !editando;
    btnSalvar.disabled = !editando;
  }

  const btnCancelar = document.getElementById("btnCancelarEdicao");
  if (btnCancelar) {
    btnCancelar.hidden = !editando;
    btnCancelar.disabled = !editando;
  }

  const btnExcluir = document.getElementById("btnExcluirConvenio");
  if (btnExcluir) {
    btnExcluir.hidden = !editando;
    btnExcluir.disabled = !editando;
  }

  // Reflete o mesmo estado (travado/editável) nos acessos adicionais
  if (isAdmin) renderizarAcessosExtraForm();

  if (!editando) aplicarRedesenhoPendente();
}

function preencherFormularioEdicao(c, { iniciarEditando = false } = {}) {
  const editLink = document.getElementById("editLink");
  if (!editLink) return;

  limparDestaquesRevisao();

  ajustarSelectEmpresa(document.getElementById("editEmpresa"), c.empresa);
  document.getElementById("editConvenioNome").value = c.convenio || "";
  document.getElementById("editRotulo").value = c.rotulo || "";
  editLink.value = c.link || "";
  document.getElementById("editLogin").value = c.login || "";
  document.getElementById("editSenha").value = c.senha || "";
  document.getElementById("editObservacao").value = c.observacao || "";

  modoEdicaoConvenio = iniciarEditando;
  aplicarModoEdicaoConvenio();

  const msg = document.getElementById("msgSalvarConvenio");
  if (msg) { msg.textContent = ""; msg.classList.remove("erro"); }
}

function limparFormularioEdicao() {
  const editLink = document.getElementById("editLink");
  if (!editLink) return;

  document.getElementById("editEmpresa").value = "";
  document.getElementById("editConvenioNome").value = "";
  document.getElementById("editRotulo").value = "";
  editLink.value = "";
  document.getElementById("editLogin").value = "";
  document.getElementById("editSenha").value = "";
  document.getElementById("editObservacao").value = "";

  modoEdicaoConvenio = false;
  aplicarModoEdicaoConvenio();

  const listaAcessos = document.getElementById("listaAcessosExtra");
  if (listaAcessos) listaAcessos.innerHTML = "";

  const msg = document.getElementById("msgSalvarConvenio");
  if (msg) { msg.textContent = ""; msg.classList.remove("erro"); }
}

/* Cancela as alterações feitas no formulário (que ainda não foram salvas) e
   volta os campos para os valores originais do convênio, inclusive nos
   acessos adicionais (recarrega do banco, descartando edições locais). */
/* "Cancelar alterações": descarta o que não foi salvo e fecha o modal.
   Todo o descarte (valores originais do convênio, destaques de revisão e
   edições nos acessos adicionais) já acontece dentro de fecharModalEdicao. */
async function cancelarEdicaoConvenio() {
  if (!isAdmin) return;

  const msg = document.getElementById("msgSalvarConvenio");
  if (msg) { msg.textContent = ""; msg.classList.remove("erro"); }

  await fecharModalEdicao();
}

/* Exclui definitivamente o convênio selecionado (e seus acessos adicionais) */
async function excluirConvenio() {
  if (!isAdmin || !convenioAtual) return;

  const nomeConvenio = convenioAtual.convenio;
  const empresaConvenio = convenioAtual.empresa;
  const idConvenio = convenioAtual.id;

  const confirmou = confirm(
    `Tem certeza que deseja excluir o convênio "${nomeConvenio}" (${empresaConvenio})?\n\n` +
    `Essa ação não pode ser desfeita e também vai remover os acessos adicionais cadastrados nele.`
  );
  if (!confirmou) return;

  const msg = document.getElementById("msgSalvarConvenio");

  // remove primeiro os acessos adicionais, que dependem do convênio (chave estrangeira)
  const { error: errAcessos } = await supabaseClient
    .from("convenio_acessos")
    .delete()
    .eq("convenio_id", idConvenio);

  if (errAcessos) {
    console.error("Erro ao excluir acessos adicionais do convênio:", errAcessos);
    msg.textContent = (errAcessos.code === "23503")
      ? "Não foi possível excluir: existem chamados vinculados a acessos adicionais deste convênio. Resolva ou exclua esses chamados antes."
      : "Erro ao excluir os acessos adicionais deste convênio.";
    msg.classList.add("erro");
    return;
  }

  const { error } = await supabaseClient
    .from("convenios")
    .delete()
    .eq("id", idConvenio);

  if (error) {
    console.error("Erro ao excluir convênio:", error);
    msg.textContent = (error.code === "23503")
      ? "Não foi possível excluir: existem chamados vinculados a este convênio. Resolva ou exclua esses chamados antes."
      : "Erro ao excluir o convênio.";
    msg.classList.add("erro");
    return;
  }

  conveniosCache = conveniosCache.filter(c => c.id !== idConvenio);

  await fecharModalEdicao();
  limparDados();
  document.getElementById("selectEmpresa").value = "";
  carregarEmpresas();
  document.getElementById("selectConvenio").innerHTML = '<option value="">Selecione o convênio</option>';
  document.getElementById("selectConvenio").disabled = true;

  alert(`Convênio "${nomeConvenio}" excluído com sucesso.`);
}

async function salvarConvenio() {
  if (!isAdmin || !convenioAtual) return;

  const msg = document.getElementById("msgSalvarConvenio");
  const novaEmpresa = document.getElementById("editEmpresa").value.trim();
  const novoConvenioNome = document.getElementById("editConvenioNome").value.trim().toUpperCase();
  const novoRotulo = document.getElementById("editRotulo").value.trim();
  const novoLink  = document.getElementById("editLink").value.trim();
  const novoLogin = document.getElementById("editLogin").value.trim();
  const novaSenha = document.getElementById("editSenha").value.trim();
  const novaObs   = document.getElementById("editObservacao").value.trim();

  if (!novaEmpresa || !novoConvenioNome) {
    msg.textContent = "Empresa e Convênio não podem ficar em branco.";
    msg.classList.add("erro");
    return;
  }

  const duplicado = conveniosCache.some(c =>
    c.id !== convenioAtual.id &&
    c.empresa.toLowerCase() === novaEmpresa.toLowerCase() &&
    c.convenio.toLowerCase() === novoConvenioNome.toLowerCase()
  );
  if (duplicado) {
    msg.textContent = "Já existe outro convênio com essa combinação de Empresa e Convênio.";
    msg.classList.add("erro");
    return;
  }

  const { error } = await supabaseClient
    .from("convenios")
    .update({
      empresa: novaEmpresa,
      convenio: novoConvenioNome,
      rotulo: novoRotulo,
      link: novoLink,
      login: novoLogin,
      senha: novaSenha,
      observacao: novaObs
    })
    .eq("id", convenioAtual.id);

  if (error) {
    console.error("Erro ao salvar convênio:", error);
    msg.textContent = "Erro ao salvar alterações.";
    msg.classList.add("erro");
    return;
  }

  convenioAtual.empresa = novaEmpresa;
  convenioAtual.convenio = novoConvenioNome;
  convenioAtual.rotulo = novoRotulo;
  convenioAtual.link = novoLink;
  convenioAtual.login = novoLogin;
  convenioAtual.senha = novaSenha;
  convenioAtual.observacao = novaObs;

  const idx = conveniosCache.findIndex(x => x.id === convenioAtual.id);
  if (idx !== -1) conveniosCache[idx] = { ...conveniosCache[idx], ...convenioAtual };

  await salvarAcessosExtra(convenioAtual.id);

  document.getElementById("outEmpresa").textContent = novaEmpresa;
  document.getElementById("outConvenio").textContent = novoConvenioNome;
  atualizarExibicaoConvenio(convenioAtual);
  setCopyState();

  // atualiza os selects (empresa/convênio podem ter sido renomeados)
  carregarEmpresas();
  const selectEmpresa = document.getElementById("selectEmpresa");
  selectEmpresa.value = novaEmpresa;
  carregarConvenios(novaEmpresa);
  document.getElementById("selectConvenio").value = novoConvenioNome;

  msg.classList.remove("erro");
  msg.textContent = "Alterações salvas com sucesso.";

  if (chamadoEmRevisao) {
    const idParaConcluir = chamadoEmRevisao;
    chamadoEmRevisao = null;

    const aviso = document.getElementById("avisoRevisao");
    if (aviso) aviso.hidden = true;

    await atualizarStatusChamado(idParaConcluir, "concluido");
    msg.textContent = "Alterações salvas e chamado concluído.";
  }

  // Depois de salvar, o formulário volta ao estado travado e o modal se fecha
  modoEdicaoConvenio = false;
  aplicarModoEdicaoConvenio();

  setTimeout(fecharModalEdicao, 1300);
}

/* =====================================================
   MODAL — SOLICITAR ALTERAÇÃO DE ACESSO (usuário normal)
   Serve tanto para o acesso principal quanto para os adicionais.
===================================================== */
let contextoSolicitacao = null; // { acessoId: null|id, rotulo, login, senha, link }

function abrirModalSolicitacao(contexto) {
  if (!convenioAtual) return;
  contextoSolicitacao = contexto;

  document.getElementById("modalEmpresa").textContent = convenioAtual.empresa;
  document.getElementById("modalConvenio").textContent = convenioAtual.convenio;

  const tituloAcesso = document.getElementById("modalAcessoTitulo");
  if (tituloAcesso) {
    tituloAcesso.textContent = contexto.rotulo ? `Acesso: ${contexto.rotulo}` : "Acesso principal";
  }

  document.getElementById("modalLoginAtual").textContent = safeText(contexto.login);
  document.getElementById("modalSenhaAtual").textContent = safeText(contexto.senha);
  document.getElementById("modalLinkAtual").textContent = safeText(contexto.link);

  ["chkAlterarLogin", "chkAlterarSenha", "chkAlterarLink"].forEach(id => {
    document.getElementById(id).checked = false;
  });
  ["modalNovoLogin", "modalNovaSenha", "modalNovoLink"].forEach(id => {
    const el = document.getElementById(id);
    el.value = "";
    el.disabled = true;
  });

  const msg = document.getElementById("msgModalChamado");
  msg.textContent = "";
  msg.classList.remove("erro");

  document.getElementById("modalChamado").hidden = false;
}

function prepararModalChamado() {
  const btnChamado = document.getElementById("btnChamado");
  const modal = document.getElementById("modalChamado");
  const btnCancelar = document.getElementById("btnCancelarChamado");
  const btnConfirmar = document.getElementById("btnConfirmarChamado");

  if (!btnChamado || !modal) return;

  ligarCheckboxCampo("chkAlterarLogin", "modalNovoLogin");
  ligarCheckboxCampo("chkAlterarSenha", "modalNovaSenha");
  ligarCheckboxCampo("chkAlterarLink",  "modalNovoLink");

  btnChamado.addEventListener("click", () => {
    if (!convenioAtual) return;

    // Admin não abre chamado para si mesmo: edita direto.
    if (isAdmin) return abrirModalEdicao();

    abrirModalSolicitacao({
      acessoId: null,
      rotulo: convenioAtual.rotulo || null,
      login: convenioAtual.login,
      senha: convenioAtual.senha,
      link: convenioAtual.link
    });
  });

  btnCancelar?.addEventListener("click", () => { modal.hidden = true; aplicarRedesenhoPendente(); });

  btnConfirmar?.addEventListener("click", async () => {
    if (!convenioAtual || !contextoSolicitacao) return;

    const alterarLogin = document.getElementById("chkAlterarLogin").checked;
    const alterarSenha = document.getElementById("chkAlterarSenha").checked;
    const alterarLink  = document.getElementById("chkAlterarLink").checked;

    const novoLogin = document.getElementById("modalNovoLogin").value.trim();
    const novaSenha = document.getElementById("modalNovaSenha").value.trim();
    const novoLink  = document.getElementById("modalNovoLink").value.trim();

    const msg = document.getElementById("msgModalChamado");

    if (!alterarLogin && !alterarSenha && !alterarLink) {
      msg.textContent = "Marque ao menos um campo para alterar.";
      msg.classList.add("erro");
      return;
    }
    if ((alterarLogin && !novoLogin) || (alterarSenha && !novaSenha) || (alterarLink && !novoLink)) {
      msg.textContent = "Preencha o novo valor dos campos marcados.";
      msg.classList.add("erro");
      return;
    }

    const { error } = await supabaseClient.from("chamados").insert({
      usuario: currentUserEmail,
      usuario_nome: currentUserName,
      empresa: convenioAtual.empresa,
      convenio: convenioAtual.convenio,
      convenio_id: convenioAtual.id,
      acesso_id: contextoSolicitacao.acessoId,
      acesso_rotulo: contextoSolicitacao.rotulo,
      login: contextoSolicitacao.login,
      novo_login: alterarLogin ? novoLogin : null,
      nova_senha: alterarSenha ? novaSenha : null,
      novo_link: alterarLink ? novoLink : null,
      status: "aberto"
    });

    if (error) {
      console.error("Erro ao enviar chamado:", error);
      msg.textContent = "Erro ao enviar solicitação.";
      msg.classList.add("erro");
      return;
    }

    msg.classList.remove("erro");
    msg.textContent = "Solicitação enviada com sucesso!";
    setTimeout(() => { modal.hidden = true; aplicarRedesenhoPendente(); }, 1200);
  });
}

function ligarCheckboxCampo(checkboxId, inputId) {
  const chk = document.getElementById(checkboxId);
  const input = document.getElementById(inputId);
  if (!chk || !input) return;

  chk.addEventListener("change", () => {
    input.disabled = !chk.checked;
    if (!chk.checked) input.value = "";
    else input.focus();
  });
}

/* =====================================================
   PAINEL ADMIN — LISTA DE CHAMADOS
===================================================== */
async function carregarChamados() {
  let consulta = supabaseClient
    .from("chamados")
    .select("*")
    .order("data_abertura", { ascending: false });

  /* Usuário comum só enxerga os chamados que ele mesmo abriu.
     ATENÇÃO: este filtro é conveniência de interface. A barreira real
     é a policy de RLS da tabela `chamados` no Supabase. */
  if (!isAdmin) {
    consulta = consulta.eq("usuario", currentUserEmail);
  }

  ultimaRecargaChamados = Date.now();

  const { data, error } = await consulta;

  if (error) {
    console.error("Erro ao carregar chamados:", error);
    return;
  }

  const chamados = data || [];

  const idsAcesso = [...new Set(chamados.filter(c => c.acesso_id).map(c => c.acesso_id))];
  let acessosMap = {};

  if (idsAcesso.length > 0) {
    const { data: acessosData, error: errAcessos } = await supabaseClient
      .from("convenio_acessos")
      .select("*")
      .in("id", idsAcesso);

    if (errAcessos) {
      console.error("Erro ao carregar acessos referenciados pelos chamados:", errAcessos);
    } else {
      (acessosData || []).forEach(a => { acessosMap[a.id] = a; });
    }
  }

  chamadosCache = chamados;
  acessosChamadosCache = acessosMap;

  renderizarChamados();
}

/* =====================================================
   FILTROS DO PAINEL DE CHAMADOS
===================================================== */
function prepararFiltrosChamados() {
  const barra = document.getElementById("filtrosChamados");
  if (!barra) return;

  barra.querySelectorAll(".filtro-chamado").forEach(btn => {
    btn.addEventListener("click", () => {
      filtroChamados = btn.dataset.filtro || "aberto";
      marcarFiltroAtivo();
      renderizarChamados();
    });
  });

  marcarFiltroAtivo();
}

function marcarFiltroAtivo() {
  document.querySelectorAll("#filtrosChamados .filtro-chamado").forEach(btn => {
    const ativo = btn.dataset.filtro === filtroChamados;
    btn.classList.toggle("ativo", ativo);
    btn.setAttribute("aria-pressed", ativo ? "true" : "false");
  });
}

function atualizarContadoresFiltro(contagens) {
  document.querySelectorAll("#filtrosChamados .filtro-contador").forEach(el => {
    el.textContent = contagens[el.dataset.contador] ?? 0;
  });
}

/* Mensagem de lista vazia — precisa dizer POR QUE está vazia, senão
   quem tem chamados concluídos acha que o sistema perdeu tudo. */
function mensagemListaVazia() {
  if (chamadosCache.length === 0) {
    return isAdmin
      ? "Nenhum chamado no momento."
      : "Você ainda não abriu nenhum chamado.";
  }
  if (filtroChamados === "aberto") {
    return "Nenhum chamado em aberto. Use os filtros acima para ver os já atendidos.";
  }
  if (filtroChamados === "concluido") return "Nenhum chamado concluído até agora.";
  if (filtroChamados === "recusado")  return "Nenhum chamado rejeitado.";
  return "Nenhum chamado no momento.";
}

function renderizarChamados() {
  const lista = document.getElementById("listaChamados");
  const badge = document.getElementById("badgeChamados");
  if (!lista) return;

  /* Contagens sempre sobre o conjunto COMPLETO, nunca sobre a lista filtrada:
     se fossem calculadas depois do filtro, o badge zeraria ao clicar em "Concluídos". */
  const contagens = { aberto: 0, concluido: 0, recusado: 0, todos: chamadosCache.length };
  chamadosCache.forEach(c => { contagens[normalizarStatus(c.status)]++; });
  atualizarContadoresFiltro(contagens);

  if (badge) {
    if (contagens.aberto > 0) { badge.textContent = contagens.aberto; badge.hidden = false; }
    else badge.hidden = true;
  }

  sinalizarNovidade(contagens.aberto, badge);

  const visiveis = filtroChamados === "todos"
    ? chamadosCache
    : chamadosCache.filter(c => normalizarStatus(c.status) === filtroChamados);

  lista.innerHTML = "";

  if (visiveis.length === 0) {
    lista.appendChild(criarP("painel-aviso", mensagemListaVazia()));
    return;
  }

  visiveis.forEach(c => {
    const status = normalizarStatus(c.status);
    const convenioRef = conveniosCache.find(x => c.convenio_id && x.id === c.convenio_id)
      || conveniosCache.find(x => x.empresa === c.empresa && x.convenio === c.convenio);

    const referencia = c.acesso_id ? acessosChamadosCache[c.acesso_id] : convenioRef;
    const tipoChamado = c.tipo || "edicao";

    const tituloAcesso = tipoChamado !== "edicao"
      ? (c.novo_rotulo ? `Acesso: ${c.novo_rotulo}` : "Acesso principal")
      : (c.acesso_id
          ? `Acesso: ${c.acesso_rotulo || "adicional"}`
          : (convenioRef?.rotulo ? `Acesso: ${convenioRef.rotulo}` : "Acesso principal"));

    const item = document.createElement("div");
    item.className = "chamado-item";

    const info = document.createElement("div");
    info.className = "chamado-info";

    const diff = montarDiffChamado(c, referencia);

    info.appendChild(criarP(
      null,
      criarForte(c.usuario_nome || c.usuario),
      ` — ${c.empresa} / ${c.convenio}`
    ));
    const selo = criarP("chamado-tipo-selo tipo-" + tipoChamado, rotuloTipo(tipoChamado));
    info.appendChild(selo);

    info.appendChild(criarP("chamado-acesso-titulo", tituloAcesso));
    info.appendChild(criarP("chamado-diff", diff));

    if (c.justificativa) {
      info.appendChild(criarP("chamado-justificativa", "Justificativa: ", c.justificativa));
    }
    if (c.motivo_recusa) {
      info.appendChild(criarP("chamado-recusa", "Motivo da recusa: ", c.motivo_recusa));
    }

    info.appendChild(criarP("chamado-data", `Aberto em: ${formatarData(c.data_abertura)}`));

    const acoes = document.createElement("div");
    acoes.className = "chamado-acoes";

    const statusSpan = document.createElement("span");
    statusSpan.className = `status-badge status-${status}`;
    statusSpan.textContent = rotuloStatus(status);
    acoes.appendChild(statusSpan);

    /* Ações de atendimento: SOMENTE admin. O usuário comum vê o mesmo card,
       com o status, mas sem nenhum botão — é uma tela de acompanhamento. */
    if (isAdmin && status === "aberto") {
      const btnRevisar = document.createElement("button");
      btnRevisar.className = "btn-verde btn-small";
      btnRevisar.textContent = "Revisar no formulário";
      btnRevisar.onclick = () => revisarChamado(c);
      acoes.appendChild(btnRevisar);

      const btnConcluir = document.createElement("button");
      btnConcluir.className = "btn-verde btn-small";
      btnConcluir.textContent = "Concluir direto";
      btnConcluir.onclick = () => concluirChamado(c);
      acoes.appendChild(btnConcluir);

      const btnRecusar = document.createElement("button");
      btnRecusar.className = "btn-vermelho btn-small";
      btnRecusar.textContent = "Recusar chamado";
      btnRecusar.title = "Encerra o chamado sem aplicar nenhuma alteração";
      btnRecusar.onclick = () => recusarChamado(c);
      acoes.appendChild(btnRecusar);
    }

    item.appendChild(info);
    item.appendChild(acoes);
    lista.appendChild(item);
  });
}

/* Avisa que a fila cresceu, sem interromper nada: uma pulsada no badge
   e a contagem no título da aba (o admin costuma deixar o Locus em
   segundo plano, onde o badge não é visível). */
function sinalizarNovidade(abertos, badge) {
  const TITULO_BASE = "Dashboard - Locus";
  document.title = abertos > 0 ? `(${abertos}) ${TITULO_BASE}` : TITULO_BASE;

  const cresceu = ultimoTotalAbertos !== null && abertos > ultimoTotalAbertos;
  ultimoTotalAbertos = abertos;

  if (cresceu && badge) {
    badge.classList.remove("badge-novo");
    void badge.offsetWidth;          // força o reinício da animação
    badge.classList.add("badge-novo");
  }
}

function rotuloTipo(tipo) {
  if (tipo === "novo_convenio") return "Convênio novo";
  if (tipo === "novo_acesso")   return "Acesso adicional";
  return "Alteração";
}

/* Devolve um fragmento de DOM (não uma string de HTML) com o conteúdo do chamado.
   Nos chamados de criação não existe "valor atual", então lista o que foi proposto. */
function montarDiffChamado(c, convenioRef) {
  if ((c.tipo || "edicao") !== "edicao") {
    const propostos = [];
    if (c.novo_link)       propostos.push(["Link", c.novo_link]);
    if (c.novo_login)      propostos.push(["Login", c.novo_login]);
    if (c.nova_senha)      propostos.push(["Senha", c.nova_senha]);
    if (c.nova_observacao) propostos.push(["Observação", c.nova_observacao]);

    const fragNovo = document.createDocumentFragment();
    if (propostos.length === 0) {
      fragNovo.appendChild(document.createTextNode("Nenhum dado informado."));
      return fragNovo;
    }
    propostos.forEach(([rotulo, valor], i) => {
      if (i > 0) fragNovo.appendChild(document.createElement("br"));
      fragNovo.appendChild(document.createTextNode(`${rotulo}: `));
      fragNovo.appendChild(criarForte(valor));
    });
    return fragNovo;
  }

  const linhas = [];
  if (c.novo_login) linhas.push(["Login", convenioRef?.login, c.novo_login]);
  if (c.nova_senha) linhas.push(["Senha", convenioRef?.senha, c.nova_senha]);
  if (c.novo_link)  linhas.push(["Link",  convenioRef?.link,  c.novo_link]);

  const frag = document.createDocumentFragment();

  if (linhas.length === 0) {
    frag.appendChild(document.createTextNode("Nenhuma alteração especificada."));
    return frag;
  }

  linhas.forEach(([rotulo, atual, novo], i) => {
    if (i > 0) frag.appendChild(document.createElement("br"));
    frag.appendChild(document.createTextNode(`${rotulo}: ${atual || "—"} → `));
    frag.appendChild(criarForte(novo));
  });

  return frag;
}

function normalizarStatus(status) {
  const s = (status || "").toString().replace(/'/g, "").trim().toLowerCase();
  if (s.includes("conclu")) return "concluido";
  if (s.includes("recus")) return "recusado";
  return "aberto";
}

function rotuloStatus(status) {
  if (status === "concluido") return "Concluído";
  if (status === "recusado") return "Rejeitado";
  /* Para o admin é uma fila de trabalho ("Aberto");
     para quem abriu o chamado, a espera é de outra pessoa ("Aguardando"). */
  return isAdmin ? "Aberto" : "Aguardando";
}

function formatarData(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return "—";
  }
}

/* Revisar no formulário: seleciona o convênio e pré-preenche com o que foi pedido */
function revisarChamado(c) {
  const tipo = c.tipo || "edicao";
  if (tipo === "novo_convenio") return revisarNovoConvenio(c);
  if (tipo === "novo_acesso")   return revisarNovoAcesso(c);

  const convenio = conveniosCache.find(x => c.convenio_id && x.id === c.convenio_id)
    || conveniosCache.find(x => x.empresa === c.empresa && x.convenio === c.convenio);

  if (!convenio) {
    alert("Não foi possível localizar o convênio deste chamado.");
    return;
  }

  const selectEmpresa = document.getElementById("selectEmpresa");
  const selectConvenio = document.getElementById("selectConvenio");

  selectEmpresa.value = convenio.empresa;
  carregarConvenios(convenio.empresa);
  selectConvenio.value = convenio.convenio;

  selecionarConvenio(convenio).then(() => {
    // Atender um chamado já abre o formulário destravado para edição direta
    modoEdicaoConvenio = true;
    aplicarModoEdicaoConvenio();

    limparDestaquesRevisao();
    const camposAlterados = [];

    if (c.acesso_id) {
      const linha = acessosExtraAtual.find(a => a.id === c.acesso_id);
      if (!linha) {
        alert("O acesso adicional referenciado por este chamado não existe mais. Revise manualmente na seção de acessos adicionais.");
        return;
      }
      if (c.novo_login) { linha.login = c.novo_login; camposAlterados.push("Login"); }
      if (c.nova_senha) { linha.senha = c.nova_senha; camposAlterados.push("Senha"); }
      if (c.novo_link)  { linha.link = c.novo_link; camposAlterados.push("Link"); }
      renderizarAcessosExtraForm();
      destacarLinhaAcessoExtra(c.acesso_id, c);
    } else {
      if (c.novo_login) { document.getElementById("editLogin").value = c.novo_login; camposAlterados.push("Login"); destacarCampo("editLogin"); }
      if (c.nova_senha) { document.getElementById("editSenha").value = c.nova_senha; camposAlterados.push("Senha"); destacarCampo("editSenha"); }
      if (c.novo_link)  { document.getElementById("editLink").value = c.novo_link; camposAlterados.push("Link"); destacarCampo("editLink"); }
    }

    chamadoEmRevisao = c.id;
    mostrarAvisoRevisao(c, camposAlterados);

    abrirModalEdicao({ manterRevisao: true });
  });
}

/* Revisão de chamado "convênio novo": abre o modal de criação já preenchido.
   Ao clicar em "Criar convênio", o chamado é concluído automaticamente. */
function revisarNovoConvenio(c) {
  if (!document.getElementById("modalNovoConvenio")) return;

  abrirModalNovoConvenio();

  ajustarSelectEmpresa(document.getElementById("novoEmpresa"), c.empresa);
  document.getElementById("novoConvenioNome").value = c.convenio || "";
  document.getElementById("novoRotulo").value       = c.novo_rotulo || "";
  document.getElementById("novoLink").value         = c.novo_link || "";
  document.getElementById("novoLogin").value        = c.novo_login || "";
  document.getElementById("novoSenha").value        = c.nova_senha || "";
  document.getElementById("novoObservacao").value   = c.nova_observacao || "";

  chamadoEmRevisao = c.id;

  const msg = document.getElementById("msgCriarConvenio");
  if (msg) {
    msg.classList.remove("erro");
    msg.textContent = `Revisando solicitação de ${c.usuario_nome || c.usuario}. ` +
      `Ao clicar em "Criar convênio", o chamado será concluído.`;
  }
}

/* Revisão de chamado "acesso adicional": abre o convênio existente e acrescenta
   a linha proposta na seção de acessos adicionais, sem id (será inserida ao salvar). */
function revisarNovoAcesso(c) {
  const convenio = conveniosCache.find(x => c.convenio_id && x.id === c.convenio_id)
    || conveniosCache.find(x =>
         normalizarTexto(x.empresa) === normalizarTexto(c.empresa) &&
         normalizarTexto(x.convenio) === normalizarTexto(c.convenio));

  if (!convenio) {
    alert("O convênio deste chamado não existe mais. Recuse o chamado ou trate como convênio novo.");
    return;
  }

  const selectEmpresa = document.getElementById("selectEmpresa");
  selectEmpresa.value = convenio.empresa;
  carregarConvenios(convenio.empresa);
  document.getElementById("selectConvenio").value = convenio.convenio;

  selecionarConvenio(convenio).then(() => {
    modoEdicaoConvenio = true;
    aplicarModoEdicaoConvenio();
    limparDestaquesRevisao();

    acessosExtraAtual.push({
      rotulo: c.novo_rotulo || c.acesso_rotulo || "",
      link:   c.novo_link || "",
      login:  c.novo_login || "",
      senha:  c.nova_senha || ""
    });
    renderizarAcessosExtraForm();

    chamadoEmRevisao = c.id;
    mostrarAvisoRevisao(c, ["novo acesso adicional"]);

    abrirModalEdicao({ manterRevisao: true });
  });
}

/* Marca visualmente (borda laranja) o campo do formulário principal que o chamado quer alterar */
function destacarCampo(inputId) {
  const input = document.getElementById(inputId);
  const campo = input?.closest(".campo");
  if (campo) campo.classList.add("campo-alterando");
}

/* Marca visualmente a linha de acesso adicional correspondente ao chamado */
function destacarLinhaAcessoExtra(acessoId, c) {
  const linhas = document.querySelectorAll("#listaAcessosExtra .acesso-extra-linha");
  const idx = acessosExtraAtual.filter(a => !a._removido).findIndex(a => a.id === acessoId);
  if (idx === -1 || !linhas[idx]) return;

  const linha = linhas[idx];
  if (c.novo_login) linha.querySelector(".ae-login")?.classList.add("ae-alterando");
  if (c.nova_senha) linha.querySelector(".ae-senha")?.classList.add("ae-alterando");
  if (c.novo_link)  linha.querySelector(".ae-link")?.classList.add("ae-alterando");
}

/* Remove os destaques de "campo sendo alterado por chamado" do formulário */
function limparDestaquesRevisao() {
  document.querySelectorAll(".campo.campo-alterando").forEach(el => el.classList.remove("campo-alterando"));
  document.querySelectorAll(".ae-alterando").forEach(el => el.classList.remove("ae-alterando"));
}

function mostrarAvisoRevisao(c, camposAlterados) {
  const aviso = document.getElementById("avisoRevisao");
  if (!aviso) return;
  document.getElementById("avisoRevisaoNome").textContent = c.usuario_nome || c.usuario;
  const camposEl = document.getElementById("avisoRevisaoCampos");
  if (camposEl) camposEl.textContent = (camposAlterados && camposAlterados.length) ? camposAlterados.join(", ") : "nenhum campo específico";
  aviso.hidden = false;
}

function cancelarRevisao() {
  chamadoEmRevisao = null;
  const aviso = document.getElementById("avisoRevisao");
  if (aviso) aviso.hidden = true;
  limparDestaquesRevisao();
  if (convenioAtual && isAdmin) preencherFormularioEdicao(convenioAtual);
}

/* Concluir direto: aplica as alterações sem passar pelo formulário */
async function concluirChamado(c) {
  const tipo = c.tipo || "edicao";
  if (tipo === "novo_convenio") return concluirNovoConvenio(c);
  if (tipo === "novo_acesso")   return concluirNovoAcesso(c);

  const payload = {};
  if (c.novo_login) payload.login = c.novo_login;
  if (c.nova_senha) payload.senha = c.nova_senha;
  if (c.novo_link)  payload.link = normalizarLink(c.novo_link);

  if (Object.keys(payload).length > 0) {
    if (c.acesso_id) {
      // acesso adicional: atualiza direto em convenio_acessos
      const { error: errAcesso } = await supabaseClient
        .from("convenio_acessos")
        .update(payload)
        .eq("id", c.acesso_id);

      if (errAcesso) {
        console.error("Erro ao aplicar alterações no acesso adicional:", errAcesso);
        alert("Não foi possível aplicar as alterações neste acesso adicional.");
        return;
      }

      // se o convênio dono desse acesso é o que está aberto na tela, recarrega a exibição
      if (convenioAtual && c.convenio_id === convenioAtual.id) {
        await carregarAcessosExtra(convenioAtual.id);
      }
    } else {
      // acesso principal: atualiza em convenios
      let query = supabaseClient.from("convenios").update(payload);
      query = c.convenio_id ? query.eq("id", c.convenio_id) : query.eq("empresa", c.empresa).eq("convenio", c.convenio);
      const { error: errConvenio } = await query;

      if (errConvenio) {
        console.error("Erro ao aplicar alterações no convênio:", errConvenio);
        alert("Não foi possível aplicar as alterações no convênio.");
        return;
      }

      const idx = conveniosCache.findIndex(x => (c.convenio_id && x.id === c.convenio_id) || (x.empresa === c.empresa && x.convenio === c.convenio));
      if (idx !== -1) {
        Object.assign(conveniosCache[idx], payload);
        if (convenioAtual && convenioAtual.id === conveniosCache[idx].id) {
          Object.assign(convenioAtual, payload);
          atualizarExibicaoConvenio(convenioAtual);
          if (isAdmin) preencherFormularioEdicao(convenioAtual);
          setCopyState();
        }
      }
    }
  }

  await atualizarStatusChamado(c.id, "concluido");
}

/* Concluir direto um chamado de convênio novo: cria o registro em convenios */
async function concluirNovoConvenio(c) {
  const jaExiste = conveniosCache.some(x =>
    normalizarTexto(x.empresa) === normalizarTexto(c.empresa) &&
    normalizarTexto(x.convenio) === normalizarTexto(c.convenio));

  if (jaExiste) {
    alert("Esse convênio já existe para essa empresa. Use \"Revisar no formulário\" para conferir, ou recuse o chamado.");
    return;
  }

  if (!confirm(`Criar o convênio ${c.empresa} / ${c.convenio} com os dados solicitados?`)) return;

  const { data, error } = await supabaseClient
    .from("convenios")
    .insert({
      empresa: c.empresa,
      convenio: (c.convenio || "").trim().toUpperCase(),
      rotulo: c.novo_rotulo || null,
      link: c.novo_link ? normalizarLink(c.novo_link) : null,
      login: c.novo_login || null,
      senha: c.nova_senha || null,
      observacao: c.nova_observacao || null
    })
    .select()
    .single();

  if (error) {
    console.error("Erro ao criar convênio a partir do chamado:", error);
    alert("Não foi possível criar o convênio.");
    return;
  }

  conveniosCache.push(data);
  carregarEmpresas();

  await atualizarStatusChamado(c.id, "concluido");
}

/* Concluir direto um chamado de acesso adicional: insere em convenio_acessos */
async function concluirNovoAcesso(c) {
  const convenio = conveniosCache.find(x => c.convenio_id && x.id === c.convenio_id)
    || conveniosCache.find(x =>
         normalizarTexto(x.empresa) === normalizarTexto(c.empresa) &&
         normalizarTexto(x.convenio) === normalizarTexto(c.convenio));

  if (!convenio) {
    alert("O convênio deste chamado não existe mais. Recuse o chamado ou trate como convênio novo.");
    return;
  }

  if (!confirm(`Adicionar este acesso ao convênio ${convenio.empresa} / ${convenio.convenio}?`)) return;

  const { error } = await supabaseClient
    .from("convenio_acessos")
    .insert({
      convenio_id: convenio.id,
      rotulo: c.novo_rotulo || c.acesso_rotulo || null,
      link: c.novo_link ? normalizarLink(c.novo_link) : null,
      login: c.novo_login || null,
      senha: c.nova_senha || null
    });

  if (error) {
    console.error("Erro ao criar acesso adicional a partir do chamado:", error);
    alert("Não foi possível adicionar esse acesso.");
    return;
  }

  if (convenioAtual && convenioAtual.id === convenio.id) {
    await carregarAcessosExtra(convenio.id);
  }

  await atualizarStatusChamado(c.id, "concluido");
}

/* Recusar chamado: encerra a solicitação sem aplicar nenhuma alteração nos dados */
async function recusarChamado(c) {
  const motivo = prompt(
    "Motivo da recusa (o solicitante vai ler esta mensagem):"
  );
  if (motivo === null) return;               // cancelou

  if (!motivo.trim()) {
    alert("É necessário informar o motivo da recusa.");
    return;
  }

  await atualizarStatusChamado(c.id, "recusado", { motivo_recusa: motivo.trim() });
}

function normalizarLink(link) {
  return link.startsWith("http") ? link : "https://" + link;
}

async function atualizarStatusChamado(id, status, extras = {}) {
  const { error } = await supabaseClient
    .from("chamados")
    .update({
      status,
      data_conclusao: new Date().toISOString(),
      admin_concluiu_email: currentUserEmail,
      admin_concluiu_nome: currentUserName,
      visto_pelo_usuario: false,   // volta a contar como novidade para o solicitante
      ...extras
    })
    .eq("id", id);

  if (error) {
    console.error("Erro ao atualizar status do chamado:", error);
    alert("Não foi possível atualizar o chamado.");
    return;
  }

  if (chamadoEmRevisao === id) {
    chamadoEmRevisao = null;
    const aviso = document.getElementById("avisoRevisao");
    if (aviso) aviso.hidden = true;
    limparDestaquesRevisao();
  }

  carregarChamados();
}

/* =====================================================
   PAINEL ADMIN — GERENCIAR USUÁRIOS
   Usa funções (RPC) no Supabase que só administradores podem chamar:
   admin_listar_usuarios / admin_definir_tipo_usuario
===================================================== */
async function carregarUsuarios() {
  const lista = document.getElementById("listaUsuarios");
  if (!lista) return;

  const { data, error } = await supabaseClient.rpc("admin_listar_usuarios");

  if (error) {
    console.error("Erro ao carregar usuários:", error);
    lista.innerHTML = '<p class="msg-feedback erro">Não foi possível carregar os usuários. Verifique se as funções admin_listar_usuarios / admin_definir_tipo_usuario foram criadas no Supabase.</p>';
    return;
  }

  // Quem participa do Pré-faturamento (tem coluna na aba). Se a coluna
  // participa_equipe ainda não existir no banco, a caixinha só não aparece.
  let participacao = null;
  const { data: part, error: errPart } = await supabaseClient
    .from("usuarios")
    .select("email,participa_equipe");
  if (errPart) {
    console.warn("Participação na Equipe indisponível (rode sql/equipe-participacao.sql):", errPart.message);
  } else {
    participacao = new Map((part || []).map(u => [(u.email || "").toLowerCase(), u.participa_equipe !== false]));
  }

  renderizarUsuarios(data || [], participacao);
}

function renderizarUsuarios(usuarios, participacao) {
  const lista = document.getElementById("listaUsuarios");
  if (!lista) return;

  if (usuarios.length === 0) {
    lista.innerHTML = '<p class="painel-aviso">Nenhum usuário cadastrado.</p>';
    return;
  }

  lista.innerHTML = "";

  usuarios
    .slice()
    .sort((a, b) => (a.email || "").localeCompare(b.email || "", "pt-BR"))
    .forEach(u => {
      const item = document.createElement("div");
      item.className = "chamado-item";
      item.dataset.busca = normalizarTexto(u.email);

      const info = document.createElement("div");
      info.className = "chamado-info";
      info.appendChild(criarP(null, criarForte(u.email)));

      const acoes = document.createElement("div");
      acoes.className = "chamado-acoes";

      const select = document.createElement("select");
      select.className = "select-tipo-usuario";
      [
        { valor: "usuario", rotulo: "Usuário" },
        { valor: "admin", rotulo: "Admin" }
      ].forEach(({ valor, rotulo }) => {
        const opt = document.createElement("option");
        opt.value = valor;
        opt.textContent = rotulo;
        if ((u.tipo || "").toString().toLowerCase() === valor) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener("change", () => alterarTipoUsuario(u.email, select.value));

      if (participacao) {
        const rotulo = document.createElement("label");
        rotulo.className = "usuario-equipe";
        rotulo.title = "Marcado: tem coluna na aba Pré-faturamento e pode receber hospitais";
        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = participacao.get((u.email || "").toLowerCase()) !== false;
        chk.setAttribute("aria-label", `${u.email} faz parte do Pré-faturamento`);
        chk.addEventListener("change", () => alterarParticipacaoEquipe(u.email, chk));
        rotulo.append(chk, document.createTextNode("Pré-faturamento"));
        acoes.appendChild(rotulo);
      }

      acoes.appendChild(select);

      item.appendChild(info);
      item.appendChild(acoes);
      lista.appendChild(item);
    });

  // A lista é redesenhada depois de cada alteração: reaplica a busca
  filtrarUsuarios();
}

/* Busca do painel Usuários: conforme digita, só ficam os que batem.
 * Procura em qualquer parte do email, sem ligar para acento ou maiúscula. */
function filtrarUsuarios() {
  const lista = document.getElementById("listaUsuarios");
  const campo = document.getElementById("buscaUsuarios");
  const qtd = document.getElementById("buscaUsuariosQtd");
  if (!lista || !campo) return;

  const termo = normalizarTexto(campo.value);
  const itens = Array.from(lista.querySelectorAll(".chamado-item"));
  let visiveis = 0;
  let primeiro = true;

  itens.forEach(item => {
    const mostra = !termo || (item.dataset.busca || "").includes(termo);
    item.hidden = !mostra;
    // Sem linha divisória em cima do primeiro que sobrou
    item.classList.toggle("primeiro-visivel", mostra && primeiro);
    if (mostra) { visiveis++; primeiro = false; }
  });

  let vazio = document.getElementById("buscaUsuariosVazio");
  if (termo && itens.length && !visiveis) {
    if (!vazio) {
      vazio = document.createElement("p");
      vazio.id = "buscaUsuariosVazio";
      vazio.className = "painel-aviso";
      lista.appendChild(vazio);
    }
    vazio.textContent = `Nenhum usuário encontrado para "${campo.value.trim()}".`;
  } else {
    vazio?.remove();
  }

  if (qtd) qtd.textContent = termo && itens.length ? `${visiveis} de ${itens.length}` : "";
}

function prepararBuscaUsuarios() {
  const campo = document.getElementById("buscaUsuarios");
  if (!campo) return;

  // Garantia extra contra preenchimento automático do navegador: a busca
  // sempre começa vazia (inclusive ao voltar pelo histórico).
  const limparSeNaoDigitou = () => {
    if (document.activeElement !== campo && campo.value) {
      campo.value = "";
      filtrarUsuarios();
    }
  };
  limparSeNaoDigitou();
  window.addEventListener("load", () => setTimeout(limparSeNaoDigitou, 300));
  window.addEventListener("pageshow", limparSeNaoDigitou);
  campo.addEventListener("input", filtrarUsuarios);
  // Esc limpa a busca
  campo.addEventListener("keydown", e => {
    if (e.key === "Escape" && campo.value) {
      campo.value = "";
      filtrarUsuarios();
    }
  });
}
prepararBuscaUsuarios();

/* Altera o tipo (admin/usuario) de um usuário via função RPC restrita a admins */
async function alterarTipoUsuario(email, novoTipo) {
  const rotulo = novoTipo === "admin" ? "Admin" : "Usuário";
  const confirmou = confirm(`Definir "${email}" como ${rotulo}?`);

  if (!confirmou) {
    await carregarUsuarios(); // desfaz a seleção visualmente
    return;
  }

  const { error } = await supabaseClient.rpc("admin_definir_tipo_usuario", {
    p_email: email,
    p_tipo: novoTipo
  });

  if (error) {
    console.error("Erro ao alterar tipo do usuário:", error);
    alert("Não foi possível alterar o tipo deste usuário.");
    await carregarUsuarios();
    return;
  }

  // Se o admin alterou o próprio tipo, atualiza a visibilidade dos painéis na hora
  if (email === currentUserEmail) {
    isAdmin = novoTipo === "admin";
    aplicarVisibilidadeAdmin();
  }

  await carregarUsuarios();
}

/* Entra / sai do Pré-faturamento (coluna na aba Pré-faturamento) via RPC restrita a admins */
async function alterarParticipacaoEquipe(email, chk) {
  const participa = chk.checked;

  if (!participa) {
    // Avisa se a pessoa ainda responde por algum hospital
    const { count } = await supabaseClient
      .from("hospital_responsavel")
      .select("hospital_id", { count: "exact", head: true })
      .eq("responsavel_email", (email || "").toLowerCase());

    if (count > 0) {
      const ok = confirm(
        `${email} ainda é responsável por ${count} ${count === 1 ? "hospital" : "hospitais"}.\n\n` +
        "A coluna dela continua no Pré-faturamento, marcada como \"Fora do Pré-faturamento\", até você mover esses hospitais. " +
        "Ela não recebe hospitais novos.\n\nTirar do Pré-faturamento mesmo assim?"
      );
      if (!ok) { chk.checked = true; return; }
    }
  }

  chk.disabled = true;
  const { error } = await supabaseClient.rpc("equipe_definir_participacao", {
    p_email: email,
    p_participa: participa
  });
  chk.disabled = false;

  if (error) {
    console.error("Erro ao alterar participação no Pré-faturamento:", error);
    alert("Não foi possível alterar a participação desta pessoa no Pré-faturamento.");
    chk.checked = !participa;
    return;
  }

  // A aba Pré-faturamento recarrega para a coluna aparecer ou sumir
  document.dispatchEvent(new CustomEvent("equipe:recarregar"));
}

/* ================= LIMPEZA ================= */
function limparDados() {
  convenioAtual = null;
  acessosExtraAtual = [];

  document.getElementById("outEmpresa").textContent = "—";
  document.getElementById("outConvenio").textContent = "—";

  const linkEl = document.getElementById("outLink");
  linkEl.textContent = "—";
  linkEl.removeAttribute("href");
  linkEl.removeAttribute("target");
  linkEl.setAttribute("aria-disabled", "true");
  linkEl.classList.add("link-desabilitado");

  document.getElementById("outLogin").textContent = "—";
  document.getElementById("outSenha").textContent = "—";
  document.getElementById("outObservacao").textContent = "—";

  const rotuloEl = document.getElementById("outRotuloPrincipal");
  if (rotuloEl) { rotuloEl.textContent = ""; rotuloEl.hidden = true; }

  document.getElementById("btnChamado").disabled = true;

  // O select de convênio só fica travado quando NÃO há empresa escolhida.
  // Antes ele era travado sempre, então voltar para "Selecione o convênio"
  // deixava a lista inutilizável até trocar de empresa e voltar.
  const selectEmpresa = document.getElementById("selectEmpresa");
  document.getElementById("selectConvenio").disabled = !(selectEmpresa && selectEmpresa.value);

  const outros = document.getElementById("outrosAcessos");
  if (outros) outros.hidden = true;

  limparFormularioEdicao();
  cancelarRevisao();
  setCopyState();
}

/* =====================================================
   MODAL — CADASTRAR ACESSO EXISTENTE (usuário normal)
   Gera chamados de dois tipos, detectados automaticamente:
     - novo_convenio : o par empresa + convênio ainda não existe
     - novo_acesso   : o convênio já existe naquela empresa
===================================================== */

/* Normaliza só para COMPARAR. O valor gravado é sempre o que
   o usuário escreveu (convertido para maiúsculas no envio). */
function normalizarTexto(str) {
  return (str ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")  // ignora acentos
    .replace(/\s+/g, " ")             // colapsa espaços repetidos
    .trim()
    .toLowerCase();
}

/* Procura o par empresa + convênio no cache já carregado no login.
   Não consulta o banco. */
function buscarConvenioNoCache(empresa, convenio) {
  const alvoConv = normalizarTexto(convenio);
  const alvoEmp = normalizarTexto(empresa);
  if (!alvoConv || !alvoEmp) return null;

  return conveniosCache.find(c =>
    normalizarTexto(c.convenio) === alvoConv &&
    normalizarTexto(c.empresa) === alvoEmp
  ) || null;
}

// Convênio detectado na digitação atual (null = será um convênio novo)
let convenioDetectadoCadastro = null;

function atualizarDeteccaoCadastro() {
  const empresa = document.getElementById("cadEmpresa").value;
  const convenio = document.getElementById("cadConvenio").value;
  const aviso = document.getElementById("cadDeteccao");

  convenioDetectadoCadastro = buscarConvenioNoCache(empresa, convenio);

  aviso.className = "cad-deteccao";

  if (!empresa || !convenio.trim()) {
    aviso.hidden = true;
    return;
  }

  aviso.hidden = false;

  if (convenioDetectadoCadastro) {
    aviso.classList.add("cad-existente");
    aviso.textContent =
      `${empresa} / ${convenioDetectadoCadastro.convenio} já está cadastrado. ` +
      `Sua solicitação será registrada como um acesso adicional desse convênio.`;
  } else {
    aviso.classList.add("cad-novo");
    aviso.textContent =
      `Esse convênio ainda não existe para ${empresa}. ` +
      `Será solicitado o cadastro de um convênio novo.`;
  }
}

function limparModalCadastro() {
  ["cadConvenio", "cadRotulo", "cadLink", "cadLogin",
   "cadSenha", "cadObservacao", "cadJustificativa"].forEach(id => {
    document.getElementById(id).value = "";
  });
  document.getElementById("cadEmpresa").value = "";

  const aviso = document.getElementById("cadDeteccao");
  aviso.hidden = true;
  aviso.className = "cad-deteccao";

  const msg = document.getElementById("msgModalCadastro");
  msg.textContent = "";
  msg.classList.remove("erro");

  convenioDetectadoCadastro = null;
}

function prepararModalCadastro() {
  const btnAbrir = document.getElementById("btnCadastrarAcesso");
  const modal = document.getElementById("modalCadastro");
  const btnCancelar = document.getElementById("btnCancelarCadastro");
  const btnConfirmar = document.getElementById("btnConfirmarCadastro");

  if (!btnAbrir || !modal) return;

  // A detecção roda em cima do cache em memória, então pode
  // rodar a cada tecla sem custo de rede.
  document.getElementById("cadConvenio")
    .addEventListener("input", atualizarDeteccaoCadastro);
  document.getElementById("cadEmpresa")
    .addEventListener("change", atualizarDeteccaoCadastro);

  btnAbrir.addEventListener("click", () => {
    // Admin cria o convênio direto, sem passar pela fila de aprovação.
    if (isAdmin) return abrirModalNovoConvenio();

    limparModalCadastro();
    modal.hidden = false;
  });

  document.getElementById("btnFecharModalCadastro")
    ?.addEventListener("click", () => { modal.hidden = true; aplicarRedesenhoPendente(); });

  btnCancelar?.addEventListener("click", () => { modal.hidden = true; aplicarRedesenhoPendente(); });

  btnConfirmar?.addEventListener("click", async () => {
    const msg = document.getElementById("msgModalCadastro");
    const marcarErro = texto => {
      msg.textContent = texto;
      msg.classList.add("erro");
    };

    const empresa = document.getElementById("cadEmpresa").value;
    // Maiúsculas aplicadas aqui, no valor que vai para o banco
    const convenio = document.getElementById("cadConvenio").value.trim().toUpperCase();
    const rotulo = document.getElementById("cadRotulo").value.trim();
    const link = document.getElementById("cadLink").value.trim();
    const login = document.getElementById("cadLogin").value.trim();
    const senha = document.getElementById("cadSenha").value.trim();
    const observacao = document.getElementById("cadObservacao").value.trim();
    const justificativa = document.getElementById("cadJustificativa").value.trim();

    if (!empresa)  return marcarErro("Selecione a empresa.");
    if (!convenio) return marcarErro("Informe o nome do convênio.");
    if (!link && !login) {
      return marcarErro("Informe ao menos o link ou o login do acesso.");
    }
    if (!justificativa) {
      return marcarErro("Explique brevemente de onde vem esse acesso.");
    }

    // Revalida a detecção no momento do envio, e não só na digitação
    const existente = buscarConvenioNoCache(empresa, convenio);

    btnConfirmar.disabled = true;

    const { error } = await supabaseClient.from("chamados").insert({
      usuario: currentUserEmail,
      usuario_nome: currentUserName,
      tipo: existente ? "novo_acesso" : "novo_convenio",
      empresa: empresa,
      convenio: existente ? existente.convenio : convenio,
      convenio_id: existente ? existente.id : null,
      acesso_id: null,
      acesso_rotulo: rotulo || null,
      novo_rotulo: rotulo || null,
      novo_login: login || null,
      nova_senha: senha || null,
      novo_link: link || null,
      nova_observacao: observacao || null,
      justificativa: justificativa,
      status: "aberto"
    });

    btnConfirmar.disabled = false;

    if (error) {
      console.error("Erro ao enviar cadastro:", error);
      // 23505 = índice único chamados_aberto_unico
      if (error.code === "23505") {
        return marcarErro(
          "Você já tem uma solicitação em aberto para esse convênio. " +
          "Aguarde a análise de um administrador."
        );
      }
      return marcarErro("Erro ao enviar solicitação.");
    }

    msg.classList.remove("erro");
    msg.textContent = "Solicitação enviada para aprovação!";
    setTimeout(() => { modal.hidden = true; aplicarRedesenhoPendente(); }, 1400);
  });
}
