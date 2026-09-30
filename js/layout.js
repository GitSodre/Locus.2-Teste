/*
 * LAYOUT.JS — só apresentação.
 *
 * Não altera nenhuma regra do sistema. Tudo o que decide o que cada
 * pessoa pode ver continua no dashboard.js; este arquivo apenas
 * observa a página e espelha o estado na sidebar:
 *
 *  - item "Chamados"/"Equipe"/"Usuários" some quando o painel está oculto
 *  - badge de chamados em aberto repetido na sidebar
 *  - inicial do nome no avatar e o papel (Administrador/Usuário)
 *  - estado vazio da ficha enquanto nenhum convênio foi escolhido
 *  - cada item da sidebar mostra só a sua seção
 *  - confirmação visual ao copiar link, login ou senha
 */
(function () {
  const $ = id => document.getElementById(id);

  /* ---------- Espelhar estado na sidebar ---------- */
  function sincronizar() {
    const painelChamados = $("painelChamados");
    const painelUsuarios = $("painelUsuarios");

    $("navChamados").hidden = painelChamados.hidden;
    $("navUsuarios").hidden = painelUsuarios.hidden;
    const painelEquipe = $("painelEquipe");
    if (painelEquipe) $("navEquipe").hidden = painelEquipe.hidden;

    const titulo = ($("tituloChamados")?.textContent || "").trim();
    $("navChamadosTexto").textContent = titulo === "Meus chamados" ? "Meus chamados" : "Chamados";

    const badge = $("badgeChamados");
    const navBadge = $("navBadgeChamados");
    navBadge.textContent = badge.textContent;
    navBadge.hidden = badge.hidden;

    const nome = ($("usuarioLogado").textContent || "").trim();
    $("avatarUsuario").textContent = nome ? nome.charAt(0).toUpperCase() : "";
    $("papelUsuario").textContent = nome
      ? (painelUsuarios.hidden ? "Usuário" : "Administrador")
      : "";

    const convenio = ($("outConvenio").textContent || "").trim();
    $("dadosConvenio").classList.toggle("sem-selecao", !convenio || convenio === "—");
  }

  const observador = new MutationObserver(sincronizar);
  ["painelChamados", "painelUsuarios", "painelEquipe", "tituloChamados", "badgeChamados", "usuarioLogado", "outConvenio"]
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

  /* ---------- Navegação: uma seção por vez ---------- */
  const SECOES = ["secaoConvenios", "painelChamados", "painelEquipe", "painelUsuarios"];
  const itens = Array.from(document.querySelectorAll(".nav-item"));

  function secaoDisponivel(id) {
    const el = $(id);
    return !!el && !el.hidden; // hidden = sem permissão (decidido pelo dashboard.js)
  }

  function mostrarSecao(id) {
    if (!secaoDisponivel(id)) id = "secaoConvenios";

    SECOES.forEach(s => $(s)?.classList.toggle("secao-inativa", s !== id));
    itens.forEach(a => {
      const ativo = a.getAttribute("href") === "#" + id;
      a.classList.toggle("ativo", ativo);
      if (ativo) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });

    // O endereço guarda a seção, para o F5 voltar ao mesmo lugar
    if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
    window.scrollTo(0, 0);
  }

  document.querySelectorAll('.sidebar a[href^="#"]').forEach(link => {
    link.addEventListener("click", e => {
      e.preventDefault();
      mostrarSecao(link.getAttribute("href").slice(1));
    });
  });

  // Os painéis são <details>, mas não devem mais recolher
  document.querySelectorAll("details.painel-admin > summary").forEach(summary => {
    summary.addEventListener("click", e => e.preventDefault());
  });

  // Se a pessoa estava em Usuários e deixou de ser admin, volta para Convênios
  new MutationObserver(() => {
    const atual = SECOES.find(s => !$(s)?.classList.contains("secao-inativa"));
    if (atual && !secaoDisponivel(atual)) mostrarSecao("secaoConvenios");
  }).observe(document.body, { attributes: true, attributeFilter: ["hidden"], subtree: true });

  // Abre na seção do endereço (ex: dashboard.html#painelChamados). Os
  // painéis só ficam visíveis depois que o dashboard.js confere o papel,
  // então espera um instante antes de desistir e cair em Convênios.
  const inicial = location.hash.slice(1);
  if (SECOES.includes(inicial) && inicial !== "secaoConvenios") {
    const tentar = (n) => {
      if (secaoDisponivel(inicial)) mostrarSecao(inicial);
      else if (n > 0) setTimeout(() => tentar(n - 1), 250);
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
