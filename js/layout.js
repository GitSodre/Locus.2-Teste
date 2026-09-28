/*
 * LAYOUT.JS — só apresentação.
 *
 * Não altera nenhuma regra do sistema. Tudo o que decide o que cada
 * pessoa pode ver continua no dashboard.js; este arquivo apenas
 * observa a página e espelha o estado na sidebar:
 *
 *  - item "Chamados"/"Usuários" some quando o painel está oculto
 *  - badge de chamados em aberto repetido na sidebar
 *  - inicial do nome no avatar e o papel (Administrador/Usuário)
 *  - estado vazio da ficha enquanto nenhum convênio foi escolhido
 *  - clique na sidebar abre o painel recolhido e rola até ele
 *  - confirmação visual ao copiar link, login ou senha
 */
(function () {
  const $ = id => document.getElementById(id);
  const semMovimento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Espelhar estado na sidebar ---------- */
  function sincronizar() {
    const painelChamados = $("painelChamados");
    const painelUsuarios = $("painelUsuarios");

    $("navChamados").hidden = painelChamados.hidden;
    $("navUsuarios").hidden = painelUsuarios.hidden;

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
  ["painelChamados", "painelUsuarios", "tituloChamados", "badgeChamados", "usuarioLogado", "outConvenio"]
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

  /* ---------- Navegação da sidebar ---------- */
  const itens = Array.from(document.querySelectorAll(".nav-item"));

  function marcarAtivo(href) {
    itens.forEach(a => a.classList.toggle("ativo", a.getAttribute("href") === href));
  }

  document.querySelectorAll('.sidebar a[href^="#"]').forEach(link => {
    link.addEventListener("click", e => {
      const href = link.getAttribute("href");
      const alvo = document.querySelector(href);
      if (!alvo) return;
      e.preventDefault();

      if (alvo.tagName === "DETAILS") alvo.open = true;
      alvo.scrollIntoView({ behavior: semMovimento ? "auto" : "smooth", block: "start" });
      marcarAtivo(href);
    });
  });

  // Destaca na sidebar a seção que está na tela
  if ("IntersectionObserver" in window) {
    const espiao = new IntersectionObserver(entradas => {
      entradas.forEach(entrada => {
        if (entrada.isIntersecting) marcarAtivo("#" + entrada.target.id);
      });
    }, { rootMargin: "-15% 0px -70% 0px" });

    ["secaoConvenios", "painelChamados", "painelUsuarios"].forEach(id => {
      const el = $(id);
      if (el) espiao.observe(el);
    });
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
