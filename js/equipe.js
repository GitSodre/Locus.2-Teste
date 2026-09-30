/*
 * EQUIPE.JS — quem responde por cada hospital.
 *
 * Admin   : quadro com uma coluna por pessoa. Com a edição destravada,
 *           arrasta hospitais (ou marca vários e usa "Mover para...")
 *           e escolhe se a troca é permanente ou temporária.
 * Usuário : vê só os hospitais dele (fixos, cobrindo e com outra pessoa).
 *
 * As regras de verdade ficam no banco (sql/equipe.sql): a leitura é
 * filtrada por RLS e toda alteração passa por funções que conferem se
 * quem chamou é admin. O cadeado daqui só evita arrastes acidentais.
 *
 * Nada aqui usa estilo inline nem HTML com dados do banco: os textos
 * entram sempre por textContent (a CSP do vercel.json bloqueia inline).
 */
(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const TRAVA_MS = 5 * 60 * 1000;          // trava sozinha após 5 min sem uso
  const RECARGA_MIN_MS = 30 * 1000;        // recarga ao voltar para a aba
  const MOTIVOS = ["Férias", "Licença", "Folga", "Outro"];

  const ICONES = {
    busca: '<path d="M20 20l-4.2-4.2"/><circle cx="11" cy="11" r="6.5"/>',
    seta: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    volta: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-2"/>'
  };

  const st = {
    email: "",
    admin: false,
    hoje: "",
    hospitais: [],           // [{id, nome}]
    donos: new Map(),        // hospital_id -> email do responsável fixo
    coberturas: [],          // em andamento ou agendadas
    pessoas: [],             // emails (só admin)
    porId: new Map(),        // hospital_id -> dados montados
    selecionados: new Set(),
    busca: "",
    filtro: "todos",
    destravado: false,
    ultimoUso: 0,
    timerTrava: null,
    arrastando: null,        // ids sendo arrastados
    faixaAutoAberta: false,
    acao: null,              // o que o modal aberto vai confirmar
    ultimaCarga: 0,
    carregando: false,
    pronto: false
  };

  /* =====================================================
     UTILITÁRIOS
  ===================================================== */
  function hojeSP() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
  }

  function somarDias(iso, n) {
    const [a, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
  }

  function ddmm(iso) {
    if (!iso) return "";
    const [, m, d] = iso.split("-");
    return `${d}/${m}`;
  }

  const curto = email => (email || "").split("@")[0];

  function norm(txt) {
    return (txt || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  }

  function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }

  function icone(nome) {
    const span = document.createElement("span");
    span.className = "eq-icone";
    // SVG fixo, sem nenhum dado do banco
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[nome]}</svg>`;
    return span;
  }

  function plural(n, um, varios) {
    return `${n} ${n === 1 ? um : varios}`;
  }

  function avisar(texto) {
    const a = $("eqAviso");
    a.textContent = texto;
    a.hidden = false;
    clearTimeout(a._timer);
    a._timer = setTimeout(() => { a.hidden = true; }, 4000);
  }

  function modalAberto() {
    return !!document.querySelector(".eq-modal:not([hidden])");
  }

  /* =====================================================
     INÍCIO
  ===================================================== */
  document.addEventListener("DOMContentLoaded", async () => {
    const { data } = await supabaseClient.auth.getSession();
    const sessao = data?.session;
    if (!sessao) return; // o dashboard.js já manda para o login

    st.email = (sessao.user?.email || "").toLowerCase();

    const { data: ehAdmin, error } = await supabaseClient.rpc("equipe_eh_admin");
    if (error) {
      // Funções ainda não criadas no Supabase: a seção fica escondida
      console.warn("Equipe indisponível (rode sql/equipe.sql):", error.message);
      return;
    }
    st.admin = ehAdmin === true;

    prepararTela();
    const ok = await carregar();
    if (!ok) return;

    $("navEquipeTexto").textContent = st.admin ? "Equipe" : "Meus hospitais";
    $("tituloEquipe").textContent = st.admin ? "Equipe" : "Meus hospitais";
    $("painelEquipe").hidden = false;
    $("navEquipe").hidden = false;
    st.pronto = true;
  });

  function prepararTela() {
    $("eqAcoesAdmin").hidden = !st.admin;
    $("eqAdmin").hidden = !st.admin;
    $("eqUsuario").hidden = st.admin;
    $("eqSubtitulo").textContent = st.admin
      ? "Quem responde por cada hospital. Destrave a edição para arrastar os cards."
      : "Os hospitais pelos quais você responde hoje. Só um administrador pode alterar esta lista.";

    prepararModais();

    // Recarrega ao voltar para a aba (outra pessoa pode ter mexido)
    const talvezRecarregar = () => {
      if (!st.pronto || document.hidden || modalAberto() || st.arrastando) return;
      if (Date.now() - st.ultimaCarga > RECARGA_MIN_MS) carregar();
    };
    window.addEventListener("focus", talvezRecarregar);
    document.addEventListener("visibilitychange", talvezRecarregar);

    if (!st.admin) return;

    $("eqBusca").addEventListener("input", e => { st.busca = norm(e.target.value); renderAdmin(); });

    document.querySelectorAll(".eq-filtro").forEach(b => {
      b.addEventListener("click", () => { st.filtro = b.dataset.filtro; renderAdmin(); });
    });

    $("eqFaixaToggle").addEventListener("click", () => {
      st.faixaAutoAberta = false;
      abrirFaixa($("eqFaixaDestinos").hidden);
    });

    $("eqCadeado").addEventListener("click", () => {
      if (st.destravado) travar();
      else abrirModal("eqModalDestravar", () => $("eqPin").focus());
    });

    $("eqBtnAusencia").addEventListener("click", () => abrirAusencia());

    $("eqSelDestino").addEventListener("change", e => {
      const v = e.target.value;
      e.target.value = "";
      if (!v) return;
      pedirMovimento([...st.selecionados], v === "__sem__" ? null : v);
    });
    $("eqSelLimpar").addEventListener("click", () => { st.selecionados.clear(); renderAdmin(); });

    prepararArraste();

    // Qualquer uso da tela adia a trava
    ["pointerdown", "keydown"].forEach(ev =>
      document.addEventListener(ev, () => { if (st.destravado) st.ultimoUso = Date.now(); }, true));
  }

  /* =====================================================
     DADOS
  ===================================================== */
  async function carregar() {
    if (st.carregando) return true;
    st.carregando = true;
    st.hoje = hojeSP();

    const consultas = [
      supabaseClient.from("hospitais").select("id,nome").eq("ativo", true).order("nome"),
      supabaseClient.from("hospital_responsavel").select("hospital_id,responsavel_email"),
      supabaseClient.from("hospital_coberturas")
        .select("id,hospital_id,de_email,para_email,inicio,fim,motivo")
        .is("encerrada_em", null)
        .gte("fim", st.hoje)
    ];
    if (st.admin) consultas.push(supabaseClient.rpc("equipe_listar_pessoas"));

    const res = await Promise.all(consultas);
    st.carregando = false;
    st.ultimaCarga = Date.now();

    const falha = res.find(r => r.error);
    if (falha) {
      console.error("Erro ao carregar a equipe:", falha.error);
      $("eqMsg").textContent = "Não foi possível carregar a equipe. Tente recarregar a página.";
      return false;
    }
    $("eqMsg").textContent = "";

    st.hospitais = res[0].data || [];
    st.donos = new Map((res[1].data || []).map(r => [r.hospital_id, r.responsavel_email.toLowerCase()]));
    st.coberturas = (res[2].data || []).map(c => ({
      ...c, de_email: c.de_email.toLowerCase(), para_email: c.para_email.toLowerCase()
    }));

    if (st.admin) {
      const pessoas = new Set((res[3].data || []).map(p => (p.email || "").toLowerCase()).filter(Boolean));
      // Quem é dono de hospital mas saiu da lista de usuários continua com coluna,
      // senão os hospitais dele sumiriam da tela.
      st.donos.forEach(email => pessoas.add(email));
      st.pessoas = [...pessoas].sort();
    }

    montar();
    render();
    return true;
  }

  function montar() {
    st.porId.clear();
    for (const h of st.hospitais) {
      st.porId.set(h.id, { id: h.id, nome: h.nome, dono: st.donos.get(h.id) || null, cob: null, futura: null });
    }
    for (const c of st.coberturas) {
      const info = st.porId.get(c.hospital_id);
      if (!info) continue;
      if (c.inicio <= st.hoje && c.fim >= st.hoje) info.cob = c;
      else if (c.inicio > st.hoje && (!info.futura || c.inicio < info.futura.inicio)) info.futura = c;
    }
    // Seleção de hospitais que não existem mais
    st.selecionados.forEach(id => { if (!st.porId.has(id)) st.selecionados.delete(id); });
  }

  function render() {
    if (st.admin) renderAdmin();
    else renderUsuario();
  }

  /* =====================================================
     QUADRO DO ADMIN
  ===================================================== */
  function visivel(info) {
    if (st.busca && !norm(info.nome).includes(st.busca)) return false;
    if (st.filtro === "cobertura" && !info.cob) return false;
    if (st.filtro === "sem" && info.dono) return false;
    return true;
  }

  function renderAdmin() {
    const infos = [...st.porId.values()];

    // Filtros e contadores
    const cont = {
      todos: infos.length,
      cobertura: infos.filter(i => i.cob).length,
      sem: infos.filter(i => !i.dono).length
    };
    document.querySelectorAll(".eq-filtro").forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.filtro === st.filtro));
      b.querySelector(".eq-filtro-qtd").textContent = cont[b.dataset.filtro];
    });

    // Sem responsável (fixa à esquerda)
    const semCol = $("eqSemResp");
    semCol.replaceChildren();
    const sem = infos.filter(i => !i.dono);
    const cabSem = el("div", "eq-col-cab");
    const linhaSem = el("div", "eq-col-cab-linha");
    linhaSem.append(el("h2", "eq-col-nome", "Sem responsável"), el("span", "eq-qtd eq-qtd-alerta", sem.length));
    cabSem.append(linhaSem);
    const corpoSem = el("div", "eq-col-corpo");
    const semVisiveis = sem.filter(visivel);
    semVisiveis.forEach(i => corpoSem.append(card(i, "sem")));
    if (!semVisiveis.length) {
      corpoSem.append(el("p", "eq-vazio", sem.length
        ? "Nenhum hospital com este filtro."
        : "Hospitais novos entram aqui. Arraste para uma pessoa para atribuir."));
    }
    semCol.append(cabSem, corpoSem);

    // Uma coluna por pessoa
    const colunas = $("eqColunas");
    const rolagem = colunas.scrollLeft;
    colunas.replaceChildren();
    const chips = $("eqFaixaDestinos");
    chips.replaceChildren();

    for (const p of st.pessoas) {
      const fixos = infos.filter(i => i.dono === p && !i.cob);
      const fora = infos.filter(i => i.dono === p && i.cob);
      const cobrindo = infos.filter(i => i.cob && i.cob.para_email === p);
      colunas.append(coluna(p, fixos, fora, cobrindo));

      const chip = el("button", "eq-chip");
      chip.type = "button";
      chip.dataset.destino = p;
      chip.append(el("span", null, curto(p)), el("span", "eq-chip-qtd", fixos.length + fora.length));
      chip.addEventListener("click", () => {
        if (st.selecionados.size) pedirMovimento([...st.selecionados], p);
        else $("eqCol-" + curto(p))?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
      });
      chips.append(chip);
    }
    colunas.scrollLeft = rolagem;

    atualizarCadeado();
    atualizarBarraSelecao();
  }

  function coluna(p, fixos, fora, cobrindo) {
    const col = el("section", "eq-col");
    col.id = "eqCol-" + curto(p);
    col.dataset.destino = p;
    col.setAttribute("aria-label", curto(p));
    if (fora.length) col.classList.add("eq-col-ausente");

    const cab = el("div", "eq-col-cab");
    const linha = el("div", "eq-col-cab-linha");
    const avatar = el("span", "avatar eq-avatar", curto(p).charAt(0).toUpperCase());
    avatar.setAttribute("aria-hidden", "true");
    const nome = el("h2", "eq-col-nome", curto(p));
    nome.title = p;
    const qtd = el("span", "eq-qtd", fixos.length + fora.length);
    qtd.title = plural(fixos.length + fora.length, "hospital fixo", "hospitais fixos");
    linha.append(avatar, nome, qtd);
    if (cobrindo.length) {
      const extra = el("span", "eq-qtd eq-qtd-cobrindo", "+" + cobrindo.length);
      extra.title = plural(cobrindo.length, "hospital em cobertura", "hospitais em cobertura");
      linha.append(extra);
    }
    cab.append(linha);

    if (fora.length) {
      const volta = fora.reduce((m, i) => (i.cob.fim > m ? i.cob.fim : m), "");
      const aus = el("div", "eq-ausencia");
      const motivo = fora[0].cob.motivo || "Ausente";
      aus.append(el("span", "eq-selo-ausente", `${motivo} até ${ddmm(volta)}`));
      if (st.destravado) {
        const b = el("button", "eq-link", "Encerrar");
        b.type = "button";
        b.addEventListener("click", () => confirmarEncerrarAusencia(p, fora.length));
        aus.append(b);
      }
      cab.append(aus);
    }

    const corpo = el("div", "eq-col-corpo");
    const grupos = [
      [cobrindo, "cobrindo", "Cobrindo"],
      [fora, "fora", "Com outra pessoa"],
      [fixos, "fixo", "Fixos"]
    ];
    const comSubtitulo = cobrindo.length > 0 || fora.length > 0;
    let algum = false;
    for (const [lista, tipo, titulo] of grupos) {
      const vis = lista.filter(visivel);
      if (!vis.length) continue;
      algum = true;
      if (comSubtitulo) corpo.append(el("h3", "eq-subtitulo eq-subtitulo-" + tipo, `${titulo} · ${vis.length}`));
      vis.forEach(i => corpo.append(card(i, tipo)));
    }
    if (!algum) {
      const total = fixos.length + fora.length + cobrindo.length;
      corpo.append(el("p", "eq-vazio", total ? "Nenhum hospital com este filtro." : "Nenhum hospital ainda"));
      if (total && (st.busca || st.filtro !== "todos")) col.classList.add("eq-col-apagada");
    }

    col.append(cab, corpo);
    return col;
  }

  function card(info, tipo) {
    const c = el("div", "eq-card eq-card-" + tipo);
    c.dataset.id = info.id;
    const selecionado = st.selecionados.has(info.id);
    if (selecionado) c.classList.add("eq-selecionado");

    if (st.admin && st.destravado) {
      c.draggable = true;
      const chk = el("input", "eq-check");
      chk.type = "checkbox";
      chk.checked = selecionado;
      chk.dataset.id = info.id;
      chk.setAttribute("aria-label", "Selecionar " + info.nome);
      chk.addEventListener("change", () => {
        if (chk.checked) st.selecionados.add(info.id);
        else st.selecionados.delete(info.id);
        document.querySelectorAll(`.eq-card[data-id="${info.id}"]`).forEach(x => {
          x.classList.toggle("eq-selecionado", chk.checked);
          const outro = x.querySelector(".eq-check");
          if (outro) outro.checked = chk.checked;
        });
        atualizarBarraSelecao();
      });
      c.append(chk);
    }

    const texto = el("div", "eq-card-texto");
    texto.append(el("span", "eq-card-nome", info.nome));

    if (tipo === "cobrindo" && info.cob) {
      const volta = el("span", "eq-card-info eq-info-cobertura");
      volta.append(icone("volta"), document.createTextNode(
        `Volta para ${curto(info.cob.de_email)} em ${ddmm(somarDias(info.cob.fim, 1))}`));
      texto.append(volta);
    } else if (tipo === "fora" && info.cob) {
      texto.append(el("span", "eq-card-info eq-info-fora",
        `Com ${curto(info.cob.para_email)} até ${ddmm(info.cob.fim)}`));
    }
    if (info.futura && tipo !== "cobrindo") {
      texto.append(el("span", "eq-card-info eq-info-agendado",
        `Agendado: com ${curto(info.futura.para_email)} de ${ddmm(info.futura.inicio)} a ${ddmm(info.futura.fim)}`));
    }

    c.append(texto);
    return c;
  }

  function atualizarBarraSelecao() {
    const barra = $("eqBarraSelecao");
    const n = st.selecionados.size;
    barra.hidden = !(st.destravado && n > 0);
    if (barra.hidden) return;

    $("eqSelTexto").textContent = plural(n, "selecionado", "selecionados");
    const sel = $("eqSelDestino");
    sel.replaceChildren(new Option("Mover para…", ""), new Option("Sem responsável", "__sem__"));
    st.pessoas.forEach(p => sel.append(new Option(curto(p), p)));
  }

  function abrirFaixa(abrir) {
    $("eqFaixaDestinos").hidden = !abrir;
    const t = $("eqFaixaToggle");
    t.setAttribute("aria-expanded", String(abrir));
    t.setAttribute("aria-label", abrir ? "Recolher a faixa de destinos" : "Abrir a faixa de destinos");
  }

  /* =====================================================
     ARRASTAR E SOLTAR
  ===================================================== */
  function prepararArraste() {
    const painel = $("eqAdmin");
    let alvoAtual = null;

    const marcarAlvo = alvo => {
      if (alvoAtual === alvo) return;
      alvoAtual?.classList.remove("eq-alvo");
      alvoAtual = alvo;
      alvoAtual?.classList.add("eq-alvo");
    };

    painel.addEventListener("dragstart", e => {
      const c = e.target.closest?.(".eq-card");
      if (!c || !st.destravado) return;
      const id = Number(c.dataset.id);
      const ids = st.selecionados.has(id) ? [...st.selecionados] : [id];
      st.arrastando = ids;
      st.ultimoUso = Date.now();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", ids.join(","));

      // Mexer no layout só depois que o navegador "pegou" o card
      setTimeout(() => {
        document.body.classList.add("eq-arrastando");
        ids.forEach(i => document.querySelectorAll(`.eq-card[data-id="${i}"]`)
          .forEach(x => x.classList.add("eq-sendo-arrastado")));
        if ($("eqFaixaDestinos").hidden) {
          st.faixaAutoAberta = true;
          abrirFaixa(true);
        }
      }, 0);
    });

    document.addEventListener("dragend", () => {
      if (!st.arrastando) return;
      st.arrastando = null;
      marcarAlvo(null);
      document.body.classList.remove("eq-arrastando");
      document.querySelectorAll(".eq-sendo-arrastado").forEach(x => x.classList.remove("eq-sendo-arrastado"));
      if (st.faixaAutoAberta) {
        st.faixaAutoAberta = false;
        abrirFaixa(false);
      }
    });

    painel.addEventListener("dragover", e => {
      if (!st.arrastando) return;
      rolarNaBorda(e);
      const alvo = e.target.closest("[data-destino]");
      marcarAlvo(alvo);
      if (!alvo) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    painel.addEventListener("drop", e => {
      const alvo = e.target.closest("[data-destino]");
      if (!alvo || !st.arrastando) return;
      e.preventDefault();
      const ids = st.arrastando;
      marcarAlvo(null);
      pedirMovimento(ids, alvo.dataset.destino || null);
    });
  }

  // Perto da borda do quadro, as colunas rolam sozinhas para o lado
  function rolarNaBorda(e) {
    const sc = $("eqColunas");
    const r = sc.getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom) return;
    if (e.clientX > r.right - 70) sc.scrollLeft += 18;
    else if (e.clientX < r.left + 70 && e.clientX > r.left) sc.scrollLeft -= 18;
  }

  /* =====================================================
     MOVER (permanente ou temporário)
  ===================================================== */
  function pedirMovimento(ids, destino) {
    if (!st.destravado) return;
    let infos = ids.map(id => st.porId.get(Number(id))).filter(Boolean);

    // O que já está exatamente onde foi solto não precisa mudar
    infos = infos.filter(i => destino === null ? !!i.dono : !(i.dono === destino && !i.cob));
    if (!infos.length) return;

    // Soltar na coluna do próprio dono = devolver antes da hora
    if (destino && infos.every(i => i.dono === destino && i.cob)) {
      abrirConfirmar({
        titulo: infos.length === 1 ? "Devolver hospital" : `Devolver ${infos.length} hospitais`,
        texto: `Encerrar a cobertura agora e devolver para ${curto(destino)}?`,
        nomes: infos.map(i => i.nome),
        botao: "Devolver",
        executar: () => supabaseClient.rpc("equipe_encerrar_cobertura", { p_hospitais: infos.map(i => i.id) }),
        sucesso: `Devolvido para ${curto(destino)}.`,
        limparSelecao: infos.map(i => i.id)
      });
      return;
    }

    abrirMover(infos, destino);
  }

  function abrirMover(infos, destino) {
    const n = infos.length;
    $("eqMoverTitulo").textContent = n === 1 ? "Mover hospital" : `Mover ${n} hospitais`;
    preencherNomes($("eqMoverLista"), infos.map(i => i.nome));

    const origens = [...new Set(infos.map(i => (i.cob ? i.cob.para_email : i.dono) || ""))];
    const rota = $("eqMoverRota");
    rota.replaceChildren(
      el("strong", null, origens.length > 1 ? "Vários responsáveis" : (curto(origens[0]) || "Sem responsável")),
      icone("seta"),
      el("strong", null, destino ? curto(destino) : "Sem responsável")
    );

    const temCob = infos.some(i => i.cob || i.futura);
    const donos = [...new Set(infos.map(i => i.dono).filter(Boolean))];
    const podeTemp = destino && infos.every(i => i.dono && i.dono !== destino);

    const radios = document.querySelectorAll('input[name="eqTipo"]');
    radios.forEach(r => { r.checked = false; });
    $("eqTipoTemp").disabled = !podeTemp;
    $("eqOpcoesTipo").hidden = destino === null;

    $("eqTxtPermanente").textContent = destino
      ? `${curto(destino)} passa a ser ${n === 1 ? "o responsável fixo" : "responsável fixo de todos"}.` +
        (temCob ? " As coberturas desses hospitais são encerradas." : "")
      : "";
    $("eqTxtTemporario").textContent = podeTemp
      ? (donos.length === 1
          ? `Volta sozinho para ${curto(donos[0])} depois da data final.`
          : "Cada hospital volta sozinho para o seu responsável fixo depois da data final.")
      : (destino && infos.some(i => !i.dono)
          ? "Indisponível: há hospital sem responsável fixo. Faça primeiro uma troca permanente."
          : "Indisponível: esta pessoa já é a responsável fixa de algum desses hospitais.");

    $("eqMoverSemResp").hidden = destino !== null;
    $("eqMoverSemResp").textContent = "Os hospitais voltam para a caixa Sem responsável" +
      (temCob ? " e as coberturas deles são encerradas." : ".");

    $("eqMoverInicio").value = st.hoje;
    $("eqMoverInicio").min = st.hoje;
    $("eqMoverFim").value = "";
    $("eqMoverFim").min = st.hoje;
    $("eqMoverMotivo").value = "";
    $("eqMoverMsg").textContent = "";

    st.acao = { tipo: "mover", ids: infos.map(i => i.id), destino, donos };
    atualizarMover();
    abrirModal("eqModalMover");
  }

  function atualizarMover() {
    const a = st.acao;
    if (!a || a.tipo !== "mover") return;
    const tipo = document.querySelector('input[name="eqTipo"]:checked')?.value || (a.destino === null ? "permanente" : "");
    const temp = tipo === "temporario";
    $("eqMoverDatas").hidden = !temp;

    const fim = $("eqMoverFim").value;
    const dica = $("eqMoverDica");
    dica.hidden = !(temp && fim);
    if (temp && fim) {
      const quem = a.donos.length === 1 ? curto(a.donos[0]) : "cada responsável fixo";
      dica.textContent = `Em ${ddmm(somarDias(fim, 1))} ${a.ids.length === 1 ? "o hospital volta" : "os hospitais voltam"} para ${quem}, sem precisar fazer nada.`;
    }
    $("eqMoverFim").min = $("eqMoverInicio").value || st.hoje;
    $("eqMoverConfirmar").disabled = !tipo || (temp && !fim);
  }

  async function confirmarMover() {
    const a = st.acao;
    const tipo = document.querySelector('input[name="eqTipo"]:checked')?.value || (a.destino === null ? "permanente" : "");
    const msg = $("eqMoverMsg");
    msg.textContent = "";

    let chamada;
    if (tipo === "temporario") {
      const inicio = $("eqMoverInicio").value;
      const fim = $("eqMoverFim").value;
      if (!inicio || !fim) { msg.textContent = "Informe o início e a data final."; return; }
      if (fim < inicio) { msg.textContent = "A data final não pode ser antes do início."; return; }
      chamada = supabaseClient.rpc("equipe_cobrir", {
        p_hospitais: a.ids, p_para: a.destino, p_inicio: inicio, p_fim: fim,
        p_motivo: $("eqMoverMotivo").value || null
      });
    } else if (tipo === "permanente") {
      chamada = supabaseClient.rpc("equipe_atribuir", { p_hospitais: a.ids, p_email: a.destino });
    } else {
      msg.textContent = "Escolha se a mudança é permanente ou temporária.";
      return;
    }

    await executar("eqMoverConfirmar", msg, chamada, "eqModalMover",
      a.destino ? `Movido para ${curto(a.destino)}.` : "Movido para Sem responsável.", a.ids);
  }

  /* =====================================================
     AUSÊNCIA DE UMA PESSOA
  ===================================================== */
  function hospitaisDe(p) {
    return [...st.porId.values()].filter(i => i.dono === p);
  }

  function abrirAusencia(pessoa) {
    const sel = $("eqAusPessoa");
    sel.replaceChildren(new Option("Escolha a pessoa…", ""));
    st.pessoas.forEach(p => {
      const n = hospitaisDe(p).length;
      if (n) sel.append(new Option(`${curto(p)} · ${plural(n, "hospital", "hospitais")}`, p));
    });
    sel.value = pessoa || "";
    $("eqAusInicio").value = st.hoje;
    $("eqAusInicio").min = st.hoje;
    $("eqAusFim").value = "";
    $("eqAusFim").min = st.hoje;
    $("eqAusMotivo").value = "Férias";
    document.querySelector('input[name="eqAusModo"][value="uma"]').checked = true;
    $("eqAusMsg").textContent = "";
    st.acao = { tipo: "ausencia" };
    montarAusencia();
    abrirModal("eqModalAusencia");
  }

  function opcoesCobertura(select, exceto, vazio) {
    select.replaceChildren(new Option(vazio, ""));
    st.pessoas.filter(p => p !== exceto).forEach(p => select.append(new Option(curto(p), p)));
  }

  function montarAusencia() {
    const p = $("eqAusPessoa").value;
    const modo = document.querySelector('input[name="eqAusModo"]:checked').value;

    const uma = $("eqAusPara");
    const escolhida = uma.value;
    opcoesCobertura(uma, p, "Escolher…");
    if (escolhida && escolhida !== p) uma.value = escolhida;
    uma.disabled = modo !== "uma";

    const lista = $("eqAusLista");
    lista.hidden = modo !== "dividir" || !p;
    lista.replaceChildren();
    if (modo === "dividir" && p) {
      hospitaisDe(p).forEach(i => {
        const linha = el("label", "eq-dist-linha");
        const s = el("select");
        s.dataset.id = i.id;
        opcoesCobertura(s, p, "Sem cobertura");
        linha.append(el("span", null, i.nome), s);
        lista.append(linha);
      });
    }
    $("eqAusFim").min = $("eqAusInicio").value || st.hoje;
  }

  async function confirmarAusencia() {
    const msg = $("eqAusMsg");
    msg.textContent = "";
    const p = $("eqAusPessoa").value;
    const inicio = $("eqAusInicio").value;
    const fim = $("eqAusFim").value;
    const modo = document.querySelector('input[name="eqAusModo"]:checked').value;

    if (!p) { msg.textContent = "Escolha quem vai se ausentar."; return; }
    if (!inicio || !fim) { msg.textContent = "Informe o início e a data final."; return; }
    if (fim < inicio) { msg.textContent = "A data final não pode ser antes do início."; return; }

    let distribuicao;
    if (modo === "uma") {
      const para = $("eqAusPara").value;
      if (!para) { msg.textContent = "Escolha quem vai cobrir."; return; }
      distribuicao = hospitaisDe(p).map(i => ({ hospital_id: i.id, para }));
    } else {
      distribuicao = [...$("eqAusLista").querySelectorAll("select")]
        .filter(s => s.value)
        .map(s => ({ hospital_id: Number(s.dataset.id), para: s.value }));
      if (!distribuicao.length) { msg.textContent = "Escolha quem cobre pelo menos um hospital."; return; }
    }

    const chamada = supabaseClient.rpc("equipe_registrar_ausencia", {
      p_email: p, p_inicio: inicio, p_fim: fim, p_motivo: $("eqAusMotivo").value || null,
      p_distribuicao: distribuicao
    });
    await executar("eqAusConfirmar", msg, chamada, "eqModalAusencia",
      `Ausência de ${curto(p)} registrada até ${ddmm(fim)}.`);
  }

  function confirmarEncerrarAusencia(p, n) {
    abrirConfirmar({
      titulo: "Encerrar ausência",
      texto: `${curto(p)} voltou antes? ${plural(n, "hospital volta", "hospitais voltam")} para ${curto(p)} agora.`,
      botao: "Encerrar ausência",
      executar: () => supabaseClient.rpc("equipe_encerrar_ausencia", { p_email: p }),
      sucesso: `Hospitais devolvidos para ${curto(p)}.`
    });
  }

  /* =====================================================
     CADEADO
  ===================================================== */
  async function confirmarDestravar() {
    const pin = $("eqPin").value.trim();
    const msg = $("eqPinMsg");
    msg.textContent = "";
    if (!/^\d{6}$/.test(pin)) { msg.textContent = "Digite os 6 números da sua senha."; return; }

    const btn = $("eqPinConfirmar");
    btn.disabled = true;
    // Confere a senha no próprio Supabase: é o mesmo login de sempre
    const { error } = await supabaseClient.auth.signInWithPassword({ email: st.email, password: pin });
    btn.disabled = false;

    if (error) {
      msg.textContent = "Senha incorreta.";
      $("eqPin").select();
      return;
    }

    fecharModal("eqModalDestravar");
    st.destravado = true;
    st.ultimoUso = Date.now();
    clearInterval(st.timerTrava);
    st.timerTrava = setInterval(checarTrava, 15000);
    renderAdmin();
  }

  function checarTrava() {
    if (!st.destravado) return;
    if (modalAberto() || st.arrastando) { st.ultimoUso = Date.now(); return; }
    if (Date.now() - st.ultimoUso >= TRAVA_MS) travar();
    else atualizarCadeado();
  }

  function travar() {
    st.destravado = false;
    clearInterval(st.timerTrava);
    st.selecionados.clear();
    renderAdmin();
  }

  function atualizarCadeado() {
    const b = $("eqCadeado");
    b.classList.toggle("aberto", st.destravado);
    b.setAttribute("aria-pressed", String(st.destravado));
    $("eqBtnAusencia").disabled = !st.destravado;
    const resto = $("eqCadeadoResto");
    if (st.destravado) {
      const min = Math.max(1, Math.ceil((TRAVA_MS - (Date.now() - st.ultimoUso)) / 60000));
      $("eqCadeadoTexto").textContent = "Edição liberada";
      resto.textContent = `· trava em ${min} min`;
      resto.hidden = false;
      b.title = "Clique para travar agora";
    } else {
      $("eqCadeadoTexto").textContent = "Edição travada";
      resto.hidden = true;
      b.title = "Clique e digite sua senha para editar";
    }
  }

  /* =====================================================
     VISÃO DO USUÁRIO
  ===================================================== */
  function renderUsuario() {
    const raiz = $("eqUsuario");
    raiz.replaceChildren();
    const me = st.email;
    const infos = [...st.porId.values()];

    const cobrindo = infos.filter(i => i.cob && i.cob.para_email === me);
    const fixos = infos.filter(i => i.dono === me && !i.cob);
    const fora = infos.filter(i => i.dono === me && i.cob);
    const agendadas = st.coberturas.filter(c => c.inicio > st.hoje && c.para_email === me);

    if (!cobrindo.length && !fixos.length && !fora.length && !agendadas.length) {
      raiz.append(el("p", "eq-vazio eq-vazio-grande", "Nenhum hospital atribuído a você ainda."));
      return;
    }

    // Cobrindo: agrupado por quem está fora e até quando
    const grupos = new Map();
    cobrindo.forEach(i => {
      const k = i.cob.de_email + "|" + i.cob.fim;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(i);
    });
    grupos.forEach((lista, k) => {
      const [de, fim] = k.split("|");
      const motivo = lista[0].cob.motivo ? ` (${lista[0].cob.motivo.toLowerCase()})` : "";
      raiz.append(bloco(
        `Cobrindo temporariamente · ${lista.length}`,
        `De ${curto(de)}${motivo} até ${ddmm(fim)}. Em ${ddmm(somarDias(fim, 1))} ${lista.length === 1 ? "volta" : "voltam"} para ${curto(de)}.`,
        lista, "cobrindo", "eq-bloco-cobertura"));
    });

    if (agendadas.length) {
      const lista = agendadas.map(c => ({
        ...(st.porId.get(c.hospital_id) || { nome: "Hospital" }),
        agendaTxt: `De ${curto(c.de_email)}, de ${ddmm(c.inicio)} a ${ddmm(c.fim)}`
      }));
      raiz.append(bloco(`Coberturas agendadas · ${lista.length}`, "Você vai cobrir estes hospitais nas datas abaixo.", lista, "agenda"));
    }

    raiz.append(bloco(`Meus hospitais fixos · ${fixos.length}`, null, fixos, "fixo"));

    raiz.append(fora.length
      ? bloco("Seus hospitais com outra pessoa", "Enquanto você está fora, quem responde por eles é:", fora, "fora")
      : bloco("Seus hospitais com outra pessoa", "Nenhum no momento. Quando você tiver uma ausência registrada, aparece aqui quem está cobrindo cada hospital.", [], "fora"));
  }

  function bloco(titulo, desc, lista, tipo, classeExtra) {
    const s = el("section", "eq-bloco" + (classeExtra ? " " + classeExtra : ""));
    s.append(el("h2", null, titulo));
    if (desc) s.append(el("p", "eq-bloco-desc", desc));
    if (lista.length) {
      const grade = el("div", "eq-grade");
      lista.forEach(i => {
        if (tipo === "agenda") {
          const c = el("div", "eq-card eq-card-fixo");
          const t = el("div", "eq-card-texto");
          t.append(el("span", "eq-card-nome", i.nome), el("span", "eq-card-info eq-info-agendado", i.agendaTxt));
          c.append(t);
          grade.append(c);
        } else {
          grade.append(card(i, tipo === "fixo" ? "fixo" : tipo));
        }
      });
      s.append(grade);
    }
    return s;
  }

  /* =====================================================
     MODAIS
  ===================================================== */
  function preencherNomes(ul, nomes) {
    ul.replaceChildren();
    nomes.slice(0, 6).forEach(n => ul.append(el("li", null, n)));
    if (nomes.length > 6) ul.append(el("li", "eq-lista-mais", `e mais ${nomes.length - 6}`));
    ul.hidden = !nomes.length;
  }

  function abrirConfirmar(op) {
    $("eqConfTitulo").textContent = op.titulo;
    $("eqConfTexto").textContent = op.texto;
    preencherNomes($("eqConfLista"), op.nomes || []);
    $("eqConfBotao").textContent = op.botao;
    $("eqConfMsg").textContent = "";
    st.acao = { tipo: "confirmar", ...op };
    abrirModal("eqModalConfirmar");
  }

  async function confirmarGenerico() {
    const a = st.acao;
    await executar("eqConfBotao", $("eqConfMsg"), a.executar(), "eqModalConfirmar", a.sucesso, a.limparSelecao);
  }

  // Roda a chamada ao banco, mostra o erro no próprio modal ou fecha e recarrega
  async function executar(btnId, msg, promessa, modalId, textoSucesso, idsSelecao) {
    const btn = $(btnId);
    btn.disabled = true;
    const { error } = await promessa;
    btn.disabled = false;
    if (error) {
      console.error("Erro na equipe:", error);
      msg.textContent = error.message || "Não foi possível salvar. Tente novamente.";
      return;
    }
    (idsSelecao || []).forEach(id => st.selecionados.delete(id));
    fecharModal(modalId);
    await carregar();
    avisar(textoSucesso);
  }

  function abrirModal(id, aoAbrir) {
    const m = $(id);
    m._focoAnterior = document.activeElement;
    m.hidden = false;
    (aoAbrir || (() => m.querySelector("input, select, button:not(.modal-fechar)")?.focus()))();
  }

  function fecharModal(id) {
    const m = $(id);
    if (m.hidden) return;
    m.hidden = true;
    if (id === "eqModalDestravar") $("eqPin").value = "";
    st.acao = null;
    m._focoAnterior?.focus?.();
  }

  function prepararModais() {
    document.querySelectorAll(".eq-modal").forEach(m => {
      m.addEventListener("click", e => {
        if (e.target === m || e.target.closest("[data-fechar]")) fecharModal(m.id);
      });
    });
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      const aberto = document.querySelector(".eq-modal:not([hidden])");
      if (aberto) fecharModal(aberto.id);
    });

    // Motivos
    ["eqMoverMotivo", "eqAusMotivo"].forEach(id => {
      const s = $(id);
      if (id === "eqMoverMotivo") s.append(new Option("Sem motivo", ""));
      MOTIVOS.forEach(m => s.append(new Option(m, m)));
    });

    // Mover
    document.querySelectorAll('input[name="eqTipo"]').forEach(r => r.addEventListener("change", atualizarMover));
    $("eqMoverInicio").addEventListener("input", atualizarMover);
    $("eqMoverFim").addEventListener("input", atualizarMover);
    $("eqMoverConfirmar").addEventListener("click", confirmarMover);

    // Destravar
    $("eqPin").addEventListener("input", e => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });
    $("eqPin").addEventListener("keydown", e => { if (e.key === "Enter") confirmarDestravar(); });
    $("eqPinConfirmar").addEventListener("click", confirmarDestravar);

    // Ausência
    $("eqAusPessoa").addEventListener("change", montarAusencia);
    $("eqAusInicio").addEventListener("input", montarAusencia);
    document.querySelectorAll('input[name="eqAusModo"]').forEach(r => r.addEventListener("change", montarAusencia));
    $("eqAusConfirmar").addEventListener("click", confirmarAusencia);

    // Confirmação genérica
    $("eqConfBotao").addEventListener("click", confirmarGenerico);
  }
})();
