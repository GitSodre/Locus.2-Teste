/*
 * LAYOUT.JS — só apresentação.
 *
 * Não altera nenhuma regra do sistema. Quem decide o que cada pessoa
 * pode acessar é o banco (níveis por módulo); o dashboard.js informa
 * o resultado por window.locusLayout.definirAcesso() e este arquivo
 * só espelha o estado na sidebar:
 *
 *  - todos os itens do menu aparecem sempre; sem permissão, o item fica
 *    bloqueado (cursor de proibido e "Sem acesso" ao passar o mouse)
 *  - badge de chamados em aberto repetido na sidebar
 *  - inicial do nome no avatar e o papel (Administrador/Usuário)
 *  - estado vazio da ficha enquanto nenhum convênio foi escolhido
 *  - cada item da sidebar mostra só a sua seção
 *  - confirmação visual ao copiar link, login ou senha
 */
(function () {
  const $ = id => document.getElementById(id);

  // Na ordem do menu
  const SECOES = ["secaoConvenios", "painelEquipe", "painelFaturamento", "painelCalendario", "painelChamados", "painelUsuarios"];
  const NAV = {
    secaoConvenios: "navConvenios",
    painelEquipe: "navEquipe",
    painelFaturamento: "navFaturamento",
    painelCalendario: "navCalendario",
    painelChamados: "navChamados",
    painelUsuarios: "navUsuarios"
  };

  let permitido = null; // {secao: true/false}; null enquanto o acesso não chegou

  /* ---------- Espelhar estado na sidebar ---------- */
  function sincronizar() {
    const titulo = ($("tituloChamados")?.textContent || "").trim();
    $("navChamadosTexto").textContent = titulo === "Meus chamados" ? "Meus chamados" : "Chamados";

    const badge = $("badgeChamados");
    const navBadge = $("navBadgeChamados");
    navBadge.textContent = badge.textContent;
    navBadge.hidden = badge.hidden || (permitido && permitido.painelChamados === false);

    const nome = ($("usuarioLogado").textContent || "").trim();
    $("avatarUsuario").textContent = nome ? nome.charAt(0).toUpperCase() : "";

    const convenio = ($("outConvenio").textContent || "").trim();
    $("dadosConvenio").classList.toggle("sem-selecao", !convenio || convenio === "—");
  }

  const observador = new MutationObserver(sincronizar);
  ["tituloChamados", "badgeChamados", "usuarioLogado", "outConvenio"]
    .forEach(id => {
      const el = $(id);
      if (el) {
        observador.observe(el, {
          attributes: true,
          attributeFilter: ["hidden"],
          childList: true,
          characterData: true,
          subtree: true
        });
      }
    });
  sincronizar();

  /* ---------- Acesso: itens bloqueados ---------- */
  function definirAcesso(mapa, info) {
    permitido = mapa || {};

    SECOES.forEach(id => {
      const nav = $(NAV[id]);
      if (!nav) return;
      const ok = permitido[id] !== false;
      nav.classList.toggle("nav-bloqueado", !ok);
      if (ok) {
        nav.removeAttribute("aria-disabled");
        nav.removeAttribute("title");
      } else {
        nav.setAttribute("aria-disabled", "true");
        nav.title = "Sem acesso";
      }
    });

    $("papelUsuario").textContent = info && info.administrador ? "Administrador" : "Usuário";
    sincronizar();

    // A seção aberta pode ter ficado sem permissão
    const atual = SECOES.find(s => !$(s)?.classList.contains("secao-inativa"));
    if (!atual || !secaoDisponivel(atual)) mostrarSecao(atual || "secaoConvenios");
    else atualizarSemAcesso();
  }
  window.locusLayout = { definirAcesso };

  // Aviso para quem não tem acesso a nenhum módulo
  const semAcesso = document.createElement("div");
  semAcesso.className = "sem-acesso-geral";
  semAcesso.hidden = true;
  const semAcessoTitulo = document.createElement("h1");
  semAcessoTitulo.className = "secao-titulo";
  semAcessoTitulo.textContent = "Sem acesso";
  const semAcessoTexto = document.createElement("p");
  semAcessoTexto.className = "painel-aviso";
  semAcessoTexto.textContent = "Você ainda não tem acesso a nenhum módulo do Locus. Fale com um administrador.";
  semAcesso.append(semAcessoTitulo, semAcessoTexto);
  document.querySelector(".dashboard-container")?.prepend(semAcesso);

  function atualizarSemAcesso() {
    semAcesso.hidden = !(permitido && SECOES.every(id => permitido[id] === false));
  }

  /* ---------- Navegação: uma seção por vez ---------- */
  const itens = Array.from(document.querySelectorAll(".nav-item"));

  function secaoDisponivel(id) {
    if (permitido && permitido[id] === false) return false;
    const el = $(id);
    return !!el && !el.hidden; // hidden = ainda carregando ou sem permissão
  }

  function mostrarSecao(id) {
    if (!secaoDisponivel(id)) id = SECOES.find(secaoDisponivel) || null;
    atualizarSemAcesso();

    SECOES.forEach(s => $(s)?.classList.toggle("secao-inativa", s !== id));
    itens.forEach(a => {
      const ativo = !!id && a.getAttribute("href") === "#" + id;
      a.classList.toggle("ativo", ativo);
      if (ativo) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    if (!id) return;

    // O endereço guarda a seção, para o F5 voltar ao mesmo lugar
    if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
    window.scrollTo(0, 0);
  }

  document.querySelectorAll('.sidebar a[href^="#"]').forEach(link => {
    link.addEventListener("click", e => {
      e.preventDefault();
      if (link.classList.contains("nav-bloqueado")) return; // sem acesso: não faz nada
      mostrarSecao(link.getAttribute("href").slice(1));
    });
  });

  // Os painéis são <details>, mas não devem mais recolher
  document.querySelectorAll("details.painel-admin > summary").forEach(summary => {
    summary.addEventListener("click", e => e.preventDefault());
  });

  // A seção aberta sumiu (ex.: perdeu o acesso), ou nada estava aberto e
  // uma seção acabou de carregar: abre a primeira disponível
  new MutationObserver(() => {
    const atual = SECOES.find(s => !$(s)?.classList.contains("secao-inativa"));
    if (!atual || !secaoDisponivel(atual)) mostrarSecao(atual || "secaoConvenios");
  }).observe(document.body, { attributes: true, attributeFilter: ["hidden"], subtree: true });

  // Abre na seção do endereço (ex: dashboard.html#painelChamados). Os
  // painéis só ficam visíveis depois que o acesso é conferido, então
  // espera um instante antes de desistir e cair na primeira disponível.
  const inicial = location.hash.slice(1);
  if (SECOES.includes(inicial) && inicial !== "secaoConvenios") {
    const tentar = (n) => {
      if (secaoDisponivel(inicial)) mostrarSecao(inicial);
      else if (n > 0 && !(permitido && permitido[inicial] === false)) setTimeout(() => tentar(n - 1), 250);
      else mostrarSecao("secaoConvenios");
    };
    tentar(12);
  } else {
    mostrarSecao("secaoConvenios");
  }

  /* ---------- Confirmação ao copiar ---------- */
  document.addEventListener("click", e => {
    const btn = e.target.closest(".btn-copy");
    if (!btn || btn.disabled) return;

    btn.classList.add("copiado");
    clearTimeout(btn._timerCopiado);
    btn._timerCopiado = setTimeout(() => btn.classList.remove("copiado"), 1400);
  });
})();
