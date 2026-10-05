/*
 * QUADRO.JS — quem responde por cada item, num quadro de colunas.
 *
 * O mesmo código monta dois quadros (configurações no fim do arquivo):
 *  - Pré-faturamento : itens são hospitais (instituições)  · ids eq*  · funções equipe_*
 *  - Faturamento     : itens são convênios (nome livre)    · ids fat* · funções fat_*
 *
 * Pelo nível no módulo (sql/permissoes.sql, sql/faturamento.sql):
 * Gestor   : quadro com uma coluna por pessoa. Com a edição destravada,
 *            arrasta itens (ou marca vários e usa "Mover para...")
 *            e escolhe se a troca é permanente ou temporária. Também
 *            cria itens novos (com ou sem responsável) e, com a edição
 *            destravada, renomeia ou exclui pelo lápis do card.
 * Operador : vê os itens dele em destaque (fixos, cobrindo e com outra
 *            pessoa) e, abaixo, todos os itens com o responsável de cada
 *            um, só para consulta.
 * Consulta : só a lista de todos os itens com o responsável.
 *
 * As regras de verdade ficam no banco: a leitura é filtrada por RLS e
 * toda alteração passa por funções que conferem se quem chamou é gestor.
 * O cadeado daqui só evita arrastes acidentais.
 *
 * Faturamento ↔ Calendário (só no Faturamento, cfg.agenda):
 *  cada convênio pode apontar para um convênio do Calendário de entrega
 *  (a "agenda"). Dois nomes diferentes, ex.: "AMIL (Clínica)" e
 *  "AMIL (CTN)", podem usar a mesma agenda "AMIL". A agenda é escolhida
 *  ao criar ou depois, no lápis. Clicar no card mostra a agenda e leva
 *  para a próxima data de entrega no calendário (calendario.js).
 *
 * Só visualização (não mexe no banco):
 *  - "Pessoas" escolhe quais colunas aparecem; começa com todas marcadas.
 *  - "Sem responsável" começa recolhida na lateral e abre no clique.
 *  - A busca esconde as colunas sem nenhum item encontrado.
 *  - A faixa de destinos só abre ao arrastar um card por cima dela.
 *
 * Quem tem coluna: nível Operador ou Gestor no módulo (tela Usuários).
 * Quem saiu do módulo mas ainda tem item continua com coluna, marcada
 * "Fora do <módulo>", até os itens serem movidos; não recebe item novo.
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
    volta: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-2"/>',
    recolher: '<path d="M15 6l-6 6 6 6"/>',
    editar: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    agenda: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'
  };

  /* =====================================================
     UTILITÁRIOS (iguais para os dois quadros)
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

  function ddmmaaaa(iso) {
    if (!iso) return "";
    const [a, m, d] = iso.split("-");
    return `${d}/${m}/${a}`;
  }

  const curto = email => (email || "").split("@")[0];

  function norm(txt) {
    return (txt || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
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

  function modalAberto() {
    return !!document.querySelector(".eq-modal:not([hidden])");
  }

  /* =====================================================
     UM QUADRO
  ===================================================== */
  function criarQuadro(cfg) {
    const P = cfg.prefixo;                 // "eq" ou "fat"
    const id = nome => $(P + nome);        // ids do HTML deste quadro
    const T = cfg.textos;                  // um, varios, Um, Varios, modulo
    const rpc = (nome, args) => supabaseClient.rpc(cfg.rpc + nome, args);
    const ids = lista => ({ [cfg.argIds]: lista });
    const MODAIS = ["ModalMover", "ModalDestravar", "ModalAusencia", "ModalConfirmar", "ModalCriar", "ModalEditar", "ModalImprimir"]
      .concat(cfg.agenda ? ["ModalTag"] : []).map(m => P + m);

    const st = {
      email: "",
      admin: false,            // gestor do módulo: quadro editável
      operador: false,         // tem itens (os seus em destaque)
      hoje: "",
      itens: [],               // [{id, nome, cal_convenio_id?}]
      agendas: null,           // id -> nome dos convênios do Calendário (null = indisponível)
      depoisDestravar: null,   // o que fazer quando a edição for destravada
      donos: new Map(),        // item_id -> email do responsável fixo
      coberturas: [],          // em andamento ou agendadas
      pessoas: [],             // emails com coluna (só admin)
      foraEquipe: new Set(),   // têm coluna só porque ainda têm item
      porId: new Map(),        // item_id -> dados montados
      selecionados: new Set(),
      busca: "",
      filtro: "todos",
      destravado: false,
      ultimoUso: 0,
      timerTrava: null,
      arrastando: null,        // ids sendo arrastados
      faixaAutoAberta: false,
      semAberta: false,        // "Sem responsável" começa recolhida na lateral
      ocultas: new Set(),      // pessoas desmarcadas em "Pessoas" (só visualização)
      chavePessoas: "",        // evita remontar a lista de pessoas sem necessidade
      acao: null,              // o que o modal aberto vai confirmar
      consulta: null,          // todos os itens e responsáveis (não gestor; null = indisponível)
      consultaBusca: "",
      consultaFiltro: "todos",
      ultimaCarga: 0,
      carregando: false,
      pronto: false
    };

    function avisar(texto) {
      const a = id("Aviso");
      a.textContent = texto;
      a.hidden = false;
      clearTimeout(a._timer);
      a._timer = setTimeout(() => { a.hidden = true; }, 4000);
    }

    /* =====================================================
       INÍCIO
    ===================================================== */
    document.addEventListener("DOMContentLoaded", async () => {
      const { data } = await supabaseClient.auth.getSession();
      const sessao = data?.session;
      if (!sessao) return; // o dashboard.js já manda para o login

      st.email = (sessao.user?.email || "").toLowerCase();

      // Nível no módulo (o dashboard.js busca uma vez para todos)
      const acesso = window.locusAcesso ? await window.locusAcesso : null;
      if (acesso) {
        const nivel = acesso[cfg.modulo];
        if (!window.locusNivel(nivel, "consulta")) return; // sem acesso: item bloqueado
        st.admin = nivel === "gestor";
        const proprio = acesso[cfg.modulo + "_proprio"];
        st.operador = proprio === "operador" || proprio === "gestor";
      } else {
        const { data: ehAdmin, error } = await rpc("eh_admin");
        if (error) {
          console.warn(`${T.modulo} indisponível:`, error.message);
          return;
        }
        st.admin = ehAdmin === true;
        st.operador = true;
      }

      prepararTela();
      $(cfg.painel).hidden = false;
      st.pronto = true;
      await carregar();
    });

    function prepararTela() {
      id("AcoesAdmin").hidden = !st.admin;
      id("Admin").hidden = !st.admin;
      id("Usuario").hidden = st.admin;
      id("Subtitulo").textContent = st.admin
        ? `Quem responde por cada ${T.um}. Destrave a edição para arrastar, renomear ou excluir os cards.`
        : st.operador
          ? `Os ${T.varios} pelos quais você responde hoje e, abaixo, quem responde pelos demais. Só um gestor pode alterar.`
          : `Quem responde por cada ${T.um}. Só um gestor pode alterar.`;

      prepararModais();

      // Recarrega ao voltar para a aba (outra pessoa pode ter mexido)
      const talvezRecarregar = () => {
        if (!st.pronto || document.hidden || modalAberto() || st.arrastando) return;
        if (Date.now() - st.ultimaCarga > RECARGA_MIN_MS) carregar();
      };
      window.addEventListener("focus", talvezRecarregar);
      // O painel Usuários avisa quando alguém entra ou sai do módulo
      document.addEventListener(cfg.evento, () => { if (st.pronto) carregar(); });
      document.addEventListener("visibilitychange", talvezRecarregar);

      if (!st.admin) return;

      id("Busca").addEventListener("input", e => {
        st.busca = norm(e.target.value);
        renderAdmin();
        // As colunas que sobraram vêm para a frente: volta a rolagem para o início
        id("Colunas").scrollLeft = 0;
      });

      id("Admin").querySelectorAll(".eq-filtro[data-filtro]").forEach(b => {
        b.addEventListener("click", () => {
          st.filtro = b.dataset.filtro;
          if (st.filtro === "sem") st.semAberta = true; // senão o filtro mostraria uma coluna fechada
          renderAdmin();
        });
      });

      prepararSeletorPessoas();

      id("FaixaToggle").addEventListener("click", () => {
        st.faixaAutoAberta = false;
        abrirFaixa(id("FaixaDestinos").hidden);
      });

      id("Cadeado").addEventListener("click", () => {
        if (st.destravado) travar();
        else abrirModal(P + "ModalDestravar", () => id("Pin").focus());
      });

      id("BtnAusencia").addEventListener("click", () => abrirAusencia());
      id("BtnCriar").addEventListener("click", () => abrirCriar());
      id("BtnImprimir").addEventListener("click", () => abrirImprimir());

      id("SelDestino").addEventListener("change", e => {
        const v = e.target.value;
        e.target.value = "";
        if (!v) return;
        pedirMovimento([...st.selecionados], v === "__sem__" ? null : v);
      });
      id("SelLimpar").addEventListener("click", () => { st.selecionados.clear(); renderAdmin(); });

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
      const K = cfg.chave;

      const consultas = [
        supabaseClient.from(cfg.tabelas.itens).select(cfg.agenda ? "id,nome,cal_convenio_id" : "id,nome")
          .eq("ativo", true).order("nome"),
        supabaseClient.from(cfg.tabelas.resp).select(`${K},responsavel_email`),
        supabaseClient.from(cfg.tabelas.cob)
          .select(`id,${K},de_email,para_email,inicio,fim,motivo`)
          .is("encerrada_em", null)
          .gte("fim", st.hoje)
      ];
      if (st.admin) consultas.push(rpc("listar_pessoas"));

      // Consulta de responsáveis (somente leitura). Fica fora do Promise.all
      // de cima: se a função não existir no banco, a tela continua
      // funcionando, só sem a lista de todos os itens.
      const pConsulta = st.admin ? null : rpc("consultar_responsaveis");
      // Agendas do Calendário: mesma ideia, sem elas o quadro funciona igual
      const pAgendas = cfg.agenda ? rpc("listar_agendas") : null;

      const res = await Promise.all(consultas);
      st.carregando = false;
      st.ultimaCarga = Date.now();

      const falha = res.find(r => r.error);
      if (falha) {
        console.error(`Erro ao carregar o ${T.modulo}:`, falha.error);
        id("Msg").textContent = `Não foi possível carregar o ${T.modulo}. Tente recarregar a página.`;
        return false;
      }
      id("Msg").textContent = "";

      st.itens = res[0].data || [];
      st.donos = new Map((res[1].data || []).map(r => [r[K], r.responsavel_email.toLowerCase()]));
      st.coberturas = (res[2].data || []).map(c => ({
        ...c, item_id: c[K], de_email: c.de_email.toLowerCase(), para_email: c.para_email.toLowerCase()
      }));

      if (st.admin) {
        // Quem tem nível Operador ou Gestor no módulo
        const equipe = new Set((res[3].data || []).map(p => (p.email || "").toLowerCase()).filter(Boolean));
        const pessoas = new Set(equipe);
        // Quem saiu do módulo (ou do Locus) mas ainda é dono de item ou está
        // cobrindo um agora continua com coluna, senão esses itens sumiriam.
        st.donos.forEach(email => pessoas.add(email));
        st.coberturas.forEach(c => { if (c.inicio <= st.hoje) pessoas.add(c.para_email); });
        st.foraEquipe = new Set([...pessoas].filter(p => !equipe.has(p)));
        st.pessoas = [...pessoas].sort();
      }

      // Empresas de cada convênio: consulta à parte, sem ela o quadro funciona igual
      st.empresas = new Map();
      if (cfg.empresas) {
        const { data: emp, error: errEmp } = await supabaseClient.from(cfg.tabelas.itens).select("id,empresas").eq("ativo", true);
        if (errEmp) console.warn("Empresas dos convênios indisponíveis (rode sql/faturamento-empresas.sql):", errEmp.message);
        else (emp || []).forEach(r => st.empresas.set(r.id, listaEmpresas(r.empresas)));
      }

      if (pAgendas) {
        const { data: ags, error: errAg } = await pAgendas;
        if (errAg) console.warn("Agendas do Calendário indisponíveis (rode sql/faturamento-calendario-vinculo.sql):", errAg.message);
        st.agendas = errAg ? null : new Map((ags || []).map(a => [a.id, a.nome]));
      }

      if (pConsulta) {
        const { data: todos, error: errConsulta } = await pConsulta;
        if (errConsulta) {
          console.warn("Consulta de responsáveis indisponível:", errConsulta.message);
          st.consulta = null;
        } else {
          st.consulta = (todos || []).map(h => ({
            id: h[K],
            nome: h.nome,
            dono: (h.responsavel_email || "").toLowerCase() || null,
            cobrindo: (h.cobrindo_email || "").toLowerCase() || null,
            fim: h.cobertura_fim,
            agenda: h.cal_convenio_id || null,
            empresas: st.empresas.get(h[K]) || []
          }));
        }
      }

      montar();
      render();
      return true;
    }

    function montar() {
      st.porId.clear();
      for (const h of st.itens) {
        st.porId.set(h.id, {
          id: h.id, nome: h.nome, dono: st.donos.get(h.id) || null, cob: null, futura: null,
          agenda: h.cal_convenio_id || null,
          empresas: (st.empresas && st.empresas.get(h.id)) || []
        });
      }
      for (const c of st.coberturas) {
        const info = st.porId.get(c.item_id);
        if (!info) continue;
        if (c.inicio <= st.hoje && c.fim >= st.hoje) info.cob = c;
        else if (c.inicio > st.hoje && (!info.futura || c.inicio < info.futura.inicio)) info.futura = c;
      }
      // Seleção de itens que não existem mais
      st.selecionados.forEach(i => { if (!st.porId.has(i)) st.selecionados.delete(i); });
    }

    // Quem pode receber item (o banco recusa quem está fora do módulo)
    function destinos() {
      return st.pessoas.filter(p => !st.foraEquipe.has(p));
    }

    function render() {
      if (st.admin) renderAdmin();
      else renderUsuario();
    }

    /* =====================================================
       QUADRO DO GESTOR
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
      id("Admin").querySelectorAll(".eq-filtro[data-filtro]").forEach(b => {
        b.setAttribute("aria-pressed", String(b.dataset.filtro === st.filtro));
        b.querySelector(".eq-filtro-qtd").textContent = cont[b.dataset.filtro];
      });

      // Sem responsável: fixa à esquerda, recolhível para a lateral.
      // Mesmo recolhida continua aceitando cards soltos (data-destino="").
      const semCol = id("SemResp");
      semCol.replaceChildren();
      semCol.classList.toggle("eq-col-sem-recolhida", !st.semAberta);
      const sem = infos.filter(i => !i.dono);
      const semVisiveis = sem.filter(visivel);

      // Com busca, o número mostra quantos foram encontrados ali
      const qtdSem = el("span", "eq-qtd eq-qtd-alerta", st.busca ? semVisiveis.length : sem.length);
      if (st.busca && semVisiveis.length) qtdSem.classList.add("eq-qtd-achou");

      const tglSem = el("button", "eq-sem-toggle");
      tglSem.type = "button";
      tglSem.setAttribute("aria-expanded", String(st.semAberta));
      tglSem.title = st.semAberta ? "Recolher para a lateral" : `Mostrar os ${T.varios} sem responsável`;
      tglSem.append(icone("recolher"), el("span", "eq-sem-rotulo", "Sem responsável"), qtdSem);
      tglSem.addEventListener("click", () => { st.semAberta = !st.semAberta; renderAdmin(); });

      const cabSem = el("div", "eq-col-cab");
      cabSem.append(tglSem);
      semCol.append(cabSem);

      if (st.semAberta) {
        const corpoSem = el("div", "eq-col-corpo");
        semVisiveis.forEach(i => corpoSem.append(card(i, "sem")));
        if (!semVisiveis.length) {
          corpoSem.append(el("p", "eq-vazio", sem.length
            ? `Nenhum ${T.um} com este filtro.`
            : `${T.Varios} novos entram aqui. Arraste para uma pessoa para atribuir.`));
        }
        semCol.append(corpoSem);
      }

      // Uma coluna por pessoa
      const colunas = id("Colunas");
      const rolagem = colunas.scrollLeft;
      colunas.replaceChildren();
      const chips = id("FaixaDestinos");
      chips.replaceChildren();

      let mostradas = 0;
      for (const p of st.pessoas) {
        const fixos = infos.filter(i => i.dono === p && !i.cob);
        const fora = infos.filter(i => i.dono === p && i.cob);
        const cobrindo = infos.filter(i => i.cob && i.cob.para_email === p);

        // Coluna aparece se a pessoa está marcada e, com busca, se tem algum item encontrado
        const oculta = st.ocultas.has(p);
        const achou = !st.busca || [...fixos, ...fora, ...cobrindo].some(visivel);
        if (!oculta && achou) {
          colunas.append(coluna(p, fixos, fora, cobrindo));
          mostradas++;
        }

        // Os chips continuam todos: dá para mandar item para quem está com a coluna oculta.
        // Quem está fora do módulo não recebe item, então não vira chip.
        if (st.foraEquipe.has(p)) continue;
        const chip = el("button", "eq-chip");
        chip.type = "button";
        chip.dataset.destino = p;
        if (oculta) {
          chip.classList.add("eq-chip-oculto");
          chip.title = "Coluna oculta em Pessoas";
        }
        chip.append(el("span", null, curto(p)), el("span", "eq-chip-qtd", fixos.length + fora.length));
        chip.addEventListener("click", () => {
          if (st.selecionados.size) pedirMovimento([...st.selecionados], p);
          else $(P + "Col-" + curto(p))?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
        });
        chips.append(chip);
      }
      if (!mostradas) {
        let txt = "Nenhuma pessoa para mostrar.";
        if (st.busca) txt = semVisiveis.length
          ? `Nenhuma coluna tem esse ${T.um}. Ele está em Sem responsável.`
          : `Nenhum ${T.um} encontrado com essa busca.`;
        else if (st.pessoas.length && st.ocultas.size) txt = "Todas as pessoas estão desmarcadas em Pessoas.";
        colunas.append(el("p", "eq-vazio eq-vazio-colunas", txt));
      }
      colunas.scrollLeft = rolagem;

      atualizarSeletorPessoas(infos);
      atualizarCadeado();
      atualizarBarraSelecao();
    }

    function coluna(p, fixos, fora, cobrindo) {
      const col = el("section", "eq-col");
      col.id = P + "Col-" + curto(p);
      const foraDaEquipe = st.foraEquipe.has(p);
      if (!foraDaEquipe) col.dataset.destino = p; // fora do módulo: não aceita soltar
      else col.classList.add("eq-col-fora-equipe");
      col.setAttribute("aria-label", curto(p));
      if (fora.length) col.classList.add("eq-col-ausente");

      const cab = el("div", "eq-col-cab");
      const linha = el("div", "eq-col-cab-linha");
      const avatar = el("span", "avatar eq-avatar", curto(p).charAt(0).toUpperCase());
      avatar.setAttribute("aria-hidden", "true");
      const nome = el("h2", "eq-col-nome", curto(p));
      nome.title = p;
      const qtd = el("span", "eq-qtd", fixos.length + fora.length);
      qtd.title = plural(fixos.length + fora.length, `${T.um} fixo`, `${T.varios} fixos`);
      linha.append(avatar, nome, qtd);
      if (cobrindo.length) {
        const extra = el("span", "eq-qtd eq-qtd-cobrindo", "+" + cobrindo.length);
        extra.title = plural(cobrindo.length, `${T.um} em cobertura`, `${T.varios} em cobertura`);
        linha.append(extra);
      }
      cab.append(linha);

      if (foraDaEquipe) {
        const selo = el("span", "eq-selo-fora-equipe", `Fora do ${T.modulo}`);
        selo.title = `Não recebe ${T.varios} novos. Mova estes ${T.varios} para outra pessoa.`;
        cab.append(selo);
      }

      if (fora.length) {
        const volta = fora.reduce((m, i) => (i.cob.fim > m ? i.cob.fim : m), "");
        const aus = el("div", "eq-ausencia");
        const motivo = fora[0].cob.motivo || "Ausente";
        aus.append(el("span", "eq-selo-ausente", `${motivo} até ${ddmm(volta)}`));
        // Lista para repassar à equipe: com quem ficou cada item
        const imp = el("button", "eq-link", "Imprimir");
        imp.type = "button";
        imp.title = `Imprimir com quem ficou cada ${T.um} de ${curto(p)}`;
        imp.addEventListener("click", () => abrirImprimir(p));
        aus.append(imp);
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
        corpo.append(el("p", "eq-vazio", total ? `Nenhum ${T.um} com este filtro.` : `Nenhum ${T.um} ainda`));
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
          id("Admin").querySelectorAll(`.eq-card[data-id="${info.id}"]`).forEach(x => {
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
      const flags = flagsEmpresas(info.empresas);
      if (flags) texto.append(flags);

      c.append(texto);

      // Coluna da direita: lápis (se liberado) e, logo abaixo, o ícone do calendário
      const acoes = el("div", "eq-card-acoes");
      const tag = tagAgenda(info);

      // Clique no card (fora da caixinha e do lápis): agenda e atalho para o calendário
      if (cfg.agenda) {
        c.classList.add("eq-card-clicavel");
        c.tabIndex = 0;
        c.setAttribute("aria-label", `${info.nome}: ver agenda no calendário`);
        c.addEventListener("click", e => {
          if (e.target.closest(".eq-check, .eq-card-editar")) return;
          abrirTag(info);
        });
        c.addEventListener("keydown", e => {
          if (e.target !== c || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          abrirTag(info);
        });
      }

      // Lápis: renomear ou excluir (só gestor, com a edição destravada)
      if (st.admin && st.destravado && tipo !== "agenda") {
        const ed = el("button", "eq-card-editar");
        ed.type = "button";
        const oQue = cfg.agenda ? "Renomear, associar agenda ou excluir" : "Renomear ou excluir";
        ed.title = `${oQue} ${info.nome}`;
        ed.setAttribute("aria-label", `${oQue} ${info.nome}`);
        ed.append(icone("editar"));
        ed.addEventListener("click", e => { e.stopPropagation(); abrirEditar(info); });
        acoes.append(ed);
      }
      if (tag) acoes.append(tag);
      if (acoes.childElementCount) c.append(acoes);
      return c;
    }

    /* =====================================================
       AGENDA NO CALENDÁRIO (só Faturamento)
    ===================================================== */
    function nomeAgenda(agendaId) {
      return (agendaId && st.agendas && st.agendas.get(agendaId)) || null;
    }

    // Só o ícone: azul com agenda vinculada, cinza sem (o nome fica no tooltip e no modal)
    function tagAgenda(info) {
      if (!cfg.agenda || !st.agendas) return null;
      const nome = nomeAgenda(info.agenda);
      if (!nome && !st.admin) return null;
      const t = el("span", "eq-card-agenda-ico eq-info-agenda" + (nome ? "" : " eq-info-sem-agenda"));
      t.append(icone("agenda"));
      t.title = nome ? `No Calendário de entrega: ${nome}` : "Sem agenda no calendário. Clique no card para associar";
      return t;
    }

    /* =====================================================
       EMPRESAS (só Faturamento): CH / CTS / CTN
    ===================================================== */
    function listaEmpresas(v) {
      const arr = Array.isArray(v) ? v : [];
      return (cfg.empresas || []).filter(e => arr.includes(e));
    }

    // Siglas separadas por "/" sob o nome do convênio
    function flagsEmpresas(lista) {
      if (!cfg.empresas || !lista || !lista.length) return null;
      const s = el("span", "eq-card-empresas", lista.join(" / "));
      s.title = "Empresas que o faturista fecha neste convênio";
      return s;
    }

    function montarEmpresas(caixaId, marcadas) {
      const caixa = id(caixaId);
      caixa.replaceChildren();
      cfg.empresas.forEach(e => {
        const l = el("label", "fat-empresa");
        const chk = el("input");
        chk.type = "checkbox";
        chk.value = e;
        chk.checked = marcadas.includes(e);
        l.append(chk, el("span", null, e));
        caixa.append(l);
      });
    }

    function lerEmpresas(caixaId) {
      return [...id(caixaId).querySelectorAll("input:checked")].map(i => i.value);
    }

    const mesmasEmpresas = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

    // Lista de agendas num <select>, com "sem agenda" no topo
    function opcoesAgenda(sel, valor) {
      sel.replaceChildren(new Option("Sem agenda (associar depois)", ""));
      [...st.agendas].sort((a, b) => a[1].localeCompare(b[1], "pt-BR"))
        .forEach(([agId, nome]) => sel.append(new Option(nome, String(agId))));
      sel.value = valor && st.agendas.has(valor) ? String(valor) : "";
    }

    // "AMIL (Clínica)" -> agenda "AMIL": a de nome mais longo que começa o texto
    function sugerirAgenda(nome) {
      const n = norm(nome);
      if (!n || !st.agendas) return null;
      let melhor = null, tam = 0;
      st.agendas.forEach((ag, agId) => {
        const a = norm(ag);
        if (a.length > tam && (n === a || n.startsWith(a + " ") || n.startsWith(a + "("))) { melhor = agId; tam = a.length; }
      });
      return melhor;
    }

    function calendarioDisponivel() {
      const painel = $("painelCalendario");
      return !!painel && !painel.hidden;
    }

    function abrirTag(info) {
      const agendaId = info.agenda;
      const nome = nomeAgenda(agendaId);
      id("TagTitulo").textContent = info.nome;
      id("TagMsg").textContent = "";

      const dl = id("TagCorpo");
      dl.replaceChildren();
      const linha = (rotulo, valor) => dl.append(el("dt", null, rotulo), el("dd", null, valor));
      linha("Calendário", nome || (st.agendas ? "Sem agenda associada" : "Indisponível"));
      // Outros nomes que usam a mesma agenda (ex.: a outra empresa)
      if (nome) {
        const outros = [...st.porId.values(), ...(st.consulta || [])]
          .filter(i => i.agenda === agendaId && i.id !== info.id)
          .map(i => i.nome);
        const unicos = [...new Set(outros)].sort((a, b) => a.localeCompare(b, "pt-BR"));
        if (unicos.length) linha("Mesma agenda", unicos.join(", "));
      }
      if (cfg.empresas && info.empresas && info.empresas.length) linha("Empresas", info.empresas.join(" / "));
      const quem = info.cob ? info.cob.para_email : (info.cobrindo || info.dono);
      linha("Faturista", quem ? curto(quem) : "Sem responsável");

      const ir = id("TagIr");
      ir.hidden = !nome;
      ir.disabled = !calendarioDisponivel();
      ir.title = ir.disabled ? "Você não tem acesso ao Calendário de entrega" : "";
      const editar = id("TagEditar");
      editar.hidden = !(st.admin && st.porId.has(info.id));
      editar.textContent = nome ? "Editar / trocar agenda" : "Associar a uma agenda";

      st.acao = { tipo: "tag", info };
      const foco = nome && !ir.disabled ? ir : (!editar.hidden ? editar : null);
      abrirModal(P + "ModalTag", () => foco?.focus());
    }

    function irParaEntrega() {
      const a = st.acao;
      if (!a || a.tipo !== "tag" || !a.info.agenda) return;
      if (!calendarioDisponivel()) { id("TagMsg").textContent = "Você não tem acesso ao Calendário de entrega."; return; }
      const agendaId = a.info.agenda;
      fecharModal(P + "ModalTag");
      // O calendario.js navega até a próxima data e destaca o convênio
      document.dispatchEvent(new CustomEvent("calendario:ir-para", { detail: { id: agendaId } }));
    }

    function editarPelaTag() {
      const a = st.acao;
      if (!a || a.tipo !== "tag") return;
      const info = st.porId.get(a.info.id);
      fecharModal(P + "ModalTag");
      if (!info) return;
      if (st.destravado) { abrirEditar(info); return; }
      // Travado: pede a senha e segue direto para a edição
      st.depoisDestravar = () => abrirEditar(st.porId.get(info.id) || info);
      abrirModal(P + "ModalDestravar", () => id("Pin").focus());
    }

    /* ---------- Pessoas visíveis (só visualização) ---------- */
    function prepararSeletorPessoas() {
      const caixa = id("Pessoas");

      // Com busca, "Marcar/Desmarcar" vale só para quem apareceu na lista
      const encontradas = () => Array.from(id("PessoasLista").querySelectorAll(".eq-pessoa-item:not([hidden]) input[data-email]"))
        .map(chk => chk.dataset.email);
      id("PessoasTodas").addEventListener("click", () => {
        encontradas().forEach(p => st.ocultas.delete(p));
        renderAdmin();
      });
      id("PessoasNenhuma").addEventListener("click", () => {
        encontradas().forEach(p => st.ocultas.add(p));
        renderAdmin();
      });

      const busca = id("PessoasBusca");
      busca.addEventListener("input", filtrarListaPessoas);
      busca.addEventListener("keydown", e => { if (e.key === "Enter") e.preventDefault(); });

      // Ao abrir, o cursor já vai para a busca; ao fechar, a busca é limpa
      caixa.addEventListener("toggle", () => {
        if (caixa.open) busca.focus();
        else if (busca.value) { busca.value = ""; filtrarListaPessoas(); }
      });

      id("PessoasLista").addEventListener("change", e => {
        const chk = e.target.closest("input[data-email]");
        if (!chk) return;
        if (chk.checked) st.ocultas.delete(chk.dataset.email);
        else st.ocultas.add(chk.dataset.email);
        renderAdmin();
      });

      // Fecha ao clicar fora ou com Esc
      document.addEventListener("click", e => {
        if (caixa.open && !caixa.contains(e.target)) caixa.open = false;
      });
      document.addEventListener("keydown", e => {
        if (e.key === "Escape" && caixa.open && !modalAberto()) {
          // Primeiro Esc limpa a busca; o segundo fecha
          if (busca.value) { busca.value = ""; filtrarListaPessoas(); return; }
          caixa.open = false;
          caixa.querySelector("summary").focus();
        }
      });
    }

    // Busca dentro do dropdown "Pessoas": só esconde itens da lista
    function filtrarListaPessoas() {
      const termo = norm(id("PessoasBusca").value);
      let achou = 0;
      id("PessoasLista").querySelectorAll(".eq-pessoa-item").forEach(item => {
        const mostra = !termo || item.dataset.busca.includes(termo);
        item.hidden = !mostra;
        if (mostra) achou++;
      });
      id("PessoasVazio").hidden = !termo || achou > 0;
      id("PessoasTodas").textContent = termo ? "Marcar encontradas" : "Marcar todas";
      id("PessoasNenhuma").textContent = termo ? "Desmarcar encontradas" : "Desmarcar todas";
      id("PessoasTodas").disabled = id("PessoasNenhuma").disabled = termo && !achou;
    }

    function atualizarSeletorPessoas(infos) {
      const lista = id("PessoasLista");

      // Só remonta quando muda quem está no módulo (não perde o foco ao marcar)
      const chave = st.pessoas.join("|") + "#" + [...st.foraEquipe].join("|");
      if (chave !== st.chavePessoas) {
        st.chavePessoas = chave;
        lista.replaceChildren();
        st.pessoas.forEach(p => {
          const item = el("label", "eq-pessoa-item");
          const chk = el("input");
          chk.type = "checkbox";
          chk.dataset.email = p;
          const nome = el("span", "eq-pessoa-nome", curto(p));
          nome.title = st.foraEquipe.has(p) ? `${p} (fora do ${T.modulo})` : p;
          const qtd = el("span", "eq-pessoa-qtd");
          qtd.dataset.email = p;
          item.dataset.busca = norm(p + " " + curto(p));
          item.append(chk, nome, qtd);
          lista.append(item);
        });
        filtrarListaPessoas();
      }

      lista.querySelectorAll("input[data-email]").forEach(chk => {
        chk.checked = !st.ocultas.has(chk.dataset.email);
      });
      lista.querySelectorAll(".eq-pessoa-qtd").forEach(q => {
        q.textContent = infos.filter(i => i.dono === q.dataset.email).length;
      });

      const vis = st.pessoas.filter(p => !st.ocultas.has(p)).length;
      id("PessoasQtd").textContent = vis === st.pessoas.length ? "todas" : `${vis} de ${st.pessoas.length}`;
      id("Pessoas").classList.toggle("eq-pessoas-ativo", vis !== st.pessoas.length);
    }

    function atualizarBarraSelecao() {
      const barra = id("BarraSelecao");
      const n = st.selecionados.size;
      barra.hidden = !(st.destravado && n > 0);
      if (barra.hidden) return;

      id("SelTexto").textContent = plural(n, "selecionado", "selecionados");
      const sel = id("SelDestino");
      sel.replaceChildren(new Option("Mover para…", ""), new Option("Sem responsável", "__sem__"));
      destinos().forEach(p => sel.append(new Option(curto(p), p)));
    }

    function abrirFaixa(abrir) {
      id("FaixaDestinos").hidden = !abrir;
      const t = id("FaixaToggle");
      t.setAttribute("aria-expanded", String(abrir));
      t.setAttribute("aria-label", abrir ? "Recolher a faixa de destinos" : "Abrir a faixa de destinos");
    }

    /* =====================================================
       ARRASTAR E SOLTAR
    ===================================================== */
    function prepararArraste() {
      const painel = id("Admin");
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
        const i = Number(c.dataset.id);
        const lista = st.selecionados.has(i) ? [...st.selecionados] : [i];
        st.arrastando = lista;
        st.ultimoUso = Date.now();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", lista.join(","));

        // Mexer no layout só depois que o navegador "pegou" o card
        setTimeout(() => {
          document.body.classList.add("eq-arrastando");
          lista.forEach(x => painel.querySelectorAll(`.eq-card[data-id="${x}"]`)
            .forEach(y => y.classList.add("eq-sendo-arrastado")));
        }, 0);
      });

      // A faixa de destinos só abre quando o card arrastado passa por cima dela
      painel.querySelector(".eq-faixa").addEventListener("dragenter", () => {
        if (!st.arrastando || !id("FaixaDestinos").hidden) return;
        st.faixaAutoAberta = true;
        abrirFaixa(true);
      });

      document.addEventListener("dragend", () => {
        if (!st.arrastando) return;
        st.arrastando = null;
        marcarAlvo(null);
        document.body.classList.remove("eq-arrastando");
        painel.querySelectorAll(".eq-sendo-arrastado").forEach(x => x.classList.remove("eq-sendo-arrastado"));
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
        const lista = st.arrastando;
        marcarAlvo(null);
        pedirMovimento(lista, alvo.dataset.destino || null);
      });
    }

    // Perto da borda do quadro, as colunas rolam sozinhas para o lado
    function rolarNaBorda(e) {
      const sc = id("Colunas");
      const r = sc.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom) return;
      if (e.clientX > r.right - 70) sc.scrollLeft += 18;
      else if (e.clientX < r.left + 70 && e.clientX > r.left) sc.scrollLeft -= 18;
    }

    /* =====================================================
       MOVER (permanente ou temporário)
    ===================================================== */
    function pedirMovimento(lista, destino) {
      if (!st.destravado) return;
      let infos = lista.map(i => st.porId.get(Number(i))).filter(Boolean);

      // O que já está exatamente onde foi solto não precisa mudar
      infos = infos.filter(i => destino === null ? !!i.dono : !(i.dono === destino && !i.cob));
      if (!infos.length) return;

      // Soltar na coluna do próprio dono = devolver antes da hora
      if (destino && infos.every(i => i.dono === destino && i.cob)) {
        abrirConfirmar({
          titulo: infos.length === 1 ? `Devolver ${T.um}` : `Devolver ${infos.length} ${T.varios}`,
          texto: `Encerrar a cobertura agora e devolver para ${curto(destino)}?`,
          nomes: infos.map(i => i.nome),
          botao: "Devolver",
          executar: () => rpc("encerrar_cobertura", ids(infos.map(i => i.id))),
          sucesso: `Devolvido para ${curto(destino)}.`,
          limparSelecao: infos.map(i => i.id)
        });
        return;
      }

      abrirMover(infos, destino);
    }

    function abrirMover(infos, destino) {
      const n = infos.length;
      id("MoverTitulo").textContent = n === 1 ? `Mover ${T.um}` : `Mover ${n} ${T.varios}`;
      preencherNomes(id("MoverLista"), infos.map(i => i.nome));

      const origens = [...new Set(infos.map(i => (i.cob ? i.cob.para_email : i.dono) || ""))];
      id("MoverRota").replaceChildren(
        el("strong", null, origens.length > 1 ? "Vários responsáveis" : (curto(origens[0]) || "Sem responsável")),
        icone("seta"),
        el("strong", null, destino ? curto(destino) : "Sem responsável")
      );

      const temCob = infos.some(i => i.cob || i.futura);
      const donos = [...new Set(infos.map(i => i.dono).filter(Boolean))];
      const podeTemp = destino && infos.every(i => i.dono && i.dono !== destino);

      document.querySelectorAll(`input[name="${P}Tipo"]`).forEach(r => { r.checked = false; });
      id("TipoTemp").disabled = !podeTemp;
      id("OpcoesTipo").hidden = destino === null;

      id("TxtPermanente").textContent = destino
        ? `${curto(destino)} passa a ser ${n === 1 ? "o responsável fixo" : "responsável fixo de todos"}.` +
          (temCob ? ` As coberturas desses ${T.varios} são encerradas.` : "")
        : "";
      id("TxtTemporario").textContent = podeTemp
        ? (donos.length === 1
            ? `Volta sozinho para ${curto(donos[0])} depois da data final.`
            : `Cada ${T.um} volta sozinho para o seu responsável fixo depois da data final.`)
        : (destino && infos.some(i => !i.dono)
            ? `Indisponível: há ${T.um} sem responsável fixo. Faça primeiro uma troca permanente.`
            : `Indisponível: esta pessoa já é a responsável fixa de algum desses ${T.varios}.`);

      id("MoverSemResp").hidden = destino !== null;
      id("MoverSemResp").textContent = `Os ${T.varios} voltam para a caixa Sem responsável` +
        (temCob ? " e as coberturas deles são encerradas." : ".");

      id("MoverInicio").value = st.hoje;
      id("MoverInicio").min = st.hoje;
      id("MoverFim").value = "";
      id("MoverFim").min = st.hoje;
      id("MoverMotivo").value = "";
      id("MoverMsg").textContent = "";

      st.acao = { tipo: "mover", ids: infos.map(i => i.id), destino, donos };
      atualizarMover();
      abrirModal(P + "ModalMover");
    }

    function tipoEscolhido(a) {
      return document.querySelector(`input[name="${P}Tipo"]:checked`)?.value || (a.destino === null ? "permanente" : "");
    }

    function atualizarMover() {
      const a = st.acao;
      if (!a || a.tipo !== "mover") return;
      const tipo = tipoEscolhido(a);
      const temp = tipo === "temporario";
      id("MoverDatas").hidden = !temp;

      const fim = id("MoverFim").value;
      const dica = id("MoverDica");
      dica.hidden = !(temp && fim);
      if (temp && fim) {
        const quem = a.donos.length === 1 ? curto(a.donos[0]) : "cada responsável fixo";
        dica.textContent = `Em ${ddmm(somarDias(fim, 1))} ${a.ids.length === 1 ? `o ${T.um} volta` : `os ${T.varios} voltam`} para ${quem}, sem precisar fazer nada.`;
      }
      id("MoverFim").min = id("MoverInicio").value || st.hoje;
      id("MoverConfirmar").disabled = !tipo || (temp && !fim);
    }

    async function confirmarMover() {
      const a = st.acao;
      const tipo = tipoEscolhido(a);
      const msg = id("MoverMsg");
      msg.textContent = "";

      let chamada;
      if (tipo === "temporario") {
        const inicio = id("MoverInicio").value;
        const fim = id("MoverFim").value;
        if (!inicio || !fim) { msg.textContent = "Informe o início e a data final."; return; }
        if (fim < inicio) { msg.textContent = "A data final não pode ser antes do início."; return; }
        chamada = rpc("cobrir", {
          ...ids(a.ids), p_para: a.destino, p_inicio: inicio, p_fim: fim,
          p_motivo: id("MoverMotivo").value || null
        });
      } else if (tipo === "permanente") {
        chamada = rpc("atribuir", { ...ids(a.ids), p_email: a.destino });
      } else {
        msg.textContent = "Escolha se a mudança é permanente ou temporária.";
        return;
      }

      await executar(P + "MoverConfirmar", msg, chamada, P + "ModalMover",
        a.destino ? `Movido para ${curto(a.destino)}.` : "Movido para Sem responsável.", a.ids);
    }

    /* =====================================================
       CRIAR ITEM (instituição / convênio)
    ===================================================== */
    function abrirCriar() {
      id("CriarNome").value = "";
      id("CriarMsg").textContent = "";
      const sel = id("CriarResp");
      sel.replaceChildren(new Option("Sem responsável", ""));
      destinos().forEach(p => sel.append(new Option(curto(p), p)));
      if (cfg.agenda) {
        id("CriarAgendaCampo").hidden = !st.agendas;
        if (st.agendas) opcoesAgenda(id("CriarAgenda"), null);
        id("CriarAgenda").dataset.escolhida = "";
      }
      if (cfg.empresas) montarEmpresas("CriarEmpresas", []);
      st.acao = { tipo: "criar" };
      abrirModal(P + "ModalCriar", () => id("CriarNome").focus());
    }

    async function confirmarCriar() {
      const msg = id("CriarMsg");
      msg.textContent = "";
      const nome = id("CriarNome").value.trim().replace(/\s+/g, " ");
      const resp = id("CriarResp").value || null;
      if (!nome) { msg.textContent = cfg.criar.semNome; id("CriarNome").focus(); return; }

      const args = { p_nome: nome, p_responsavel: resp };
      const agenda = cfg.agenda && st.agendas ? Number(id("CriarAgenda").value) || null : null;
      if (agenda) args.p_agenda = agenda;
      const ag = agenda ? `, na agenda ${nomeAgenda(agenda)}` : "";
      const empresas = cfg.empresas ? lerEmpresas("CriarEmpresas") : [];
      const chamada = (async () => {
        const r = await supabaseClient.rpc(cfg.criar.rpc, args);
        if (r.error || !empresas.length) return r;
        // A função de criar não recebe as empresas: grava logo depois no convênio novo
        const { data, error } = await supabaseClient.from(cfg.tabelas.itens).select("id")
          .eq("nome", nome).eq("ativo", true).order("id", { ascending: false }).limit(1);
        if (error || !data || !data.length) return { error: error || { message: "Convênio criado, mas não foi possível gravar as empresas." } };
        return rpc("definir_empresas", { p_id: data[0].id, p_empresas: empresas });
      })();
      await executar(P + "CriarConfirmar", msg, chamada, P + "ModalCriar",
        resp ? `${nome} criado para ${curto(resp)}${ag}.` : `${nome} criado em Sem responsável${ag}.`);
      if (agenda) document.dispatchEvent(new CustomEvent("calendario:vinculos"));
    }

    /* =====================================================
       RENOMEAR / EXCLUIR ITEM
    ===================================================== */
    function abrirEditar(info) {
      if (!st.destravado) return;
      id("EditarNome").value = info.nome;
      id("EditarMsg").textContent = "";
      if (cfg.agenda) {
        id("EditarAgendaCampo").hidden = !st.agendas;
        if (st.agendas) opcoesAgenda(id("EditarAgenda"), info.agenda);
      }
      if (cfg.empresas) montarEmpresas("EditarEmpresas", info.empresas || []);
      st.acao = { tipo: "editar", id: info.id, nome: info.nome, agenda: info.agenda, empresas: info.empresas || [] };
      abrirModal(P + "ModalEditar", () => { id("EditarNome").focus(); id("EditarNome").select(); });
    }

    async function confirmarRenomear() {
      const a = st.acao;
      if (!a || a.tipo !== "editar") return;
      const msg = id("EditarMsg");
      msg.textContent = "";
      const nome = id("EditarNome").value.trim().replace(/\s+/g, " ");
      if (!nome) { msg.textContent = cfg.criar.semNome; id("EditarNome").focus(); return; }
      const mudouNome = nome !== a.nome;
      // Agenda que sumiu do calendário conta como "sem agenda"
      const agendaAntes = nomeAgenda(a.agenda) ? a.agenda : null;
      const agenda = cfg.agenda && st.agendas ? Number(id("EditarAgenda").value) || null : agendaAntes;
      const mudouAgenda = agenda !== agendaAntes;
      const empresas = cfg.empresas ? lerEmpresas("EditarEmpresas") : [];
      const mudouEmpresas = !!cfg.empresas && !mesmasEmpresas(empresas, a.empresas || []);
      if (!mudouNome && !mudouAgenda && !mudouEmpresas) { fecharModal(P + "ModalEditar"); return; }

      const chamada = (async () => {
        if (mudouNome) {
          const r = await supabaseClient.rpc(cfg.editar.renomear, { p_id: a.id, p_nome: nome });
          if (r.error) return r;
        }
        if (mudouAgenda) {
          const r = await rpc("associar_agenda", { p_id: a.id, p_agenda: agenda });
          if (r.error) return r;
        }
        if (mudouEmpresas) return rpc("definir_empresas", { p_id: a.id, p_empresas: empresas });
        return { error: null };
      })();
      const textos = [];
      if (mudouEmpresas) textos.push(empresas.length ? `Empresas: ${empresas.join(" / ")}.` : "Empresas removidas.");
      if (mudouNome) textos.push(`${a.nome} agora se chama ${nome}.`);
      if (mudouAgenda) textos.push(agenda ? `Agenda: ${nomeAgenda(agenda)}.` : "Agenda removida.");
      await executar(P + "EditarSalvar", msg, chamada, P + "ModalEditar", textos.join(" "));
      if (mudouAgenda) document.dispatchEvent(new CustomEvent("calendario:vinculos"));
    }

    function pedirExcluir() {
      const a = st.acao;
      if (!a || a.tipo !== "editar") return;
      const info = st.porId.get(a.id);
      fecharModal(P + "ModalEditar");
      const quem = info && (info.cob ? info.cob.para_email : info.dono);
      abrirConfirmar({
        titulo: `Excluir ${T.um}`,
        texto: `${a.nome} sai do quadro` +
          (quem ? ` e deixa de ser de ${curto(quem)}` : "") +
          (info && (info.cob || info.futura) ? "; as coberturas dele são encerradas" : "") +
          ". Não dá para desfazer por aqui.",
        botao: "Excluir",
        executar: () => supabaseClient.rpc(cfg.editar.excluir, { p_id: a.id }),
        sucesso: `${a.nome} excluído.`,
        limparSelecao: [a.id]
      });
    }

    /* =====================================================
       AUSÊNCIA DE UMA PESSOA
    ===================================================== */
    function itensDe(p) {
      return [...st.porId.values()].filter(i => i.dono === p);
    }

    function abrirAusencia(pessoa) {
      const sel = id("AusPessoa");
      sel.replaceChildren(new Option("Escolha a pessoa…", ""));
      st.pessoas.forEach(p => {
        const n = itensDe(p).length;
        if (n) sel.append(new Option(`${curto(p)} · ${plural(n, T.um, T.varios)}`, p));
      });
      sel.value = pessoa || "";
      id("AusInicio").value = st.hoje;
      id("AusInicio").min = st.hoje;
      id("AusFim").value = "";
      id("AusFim").min = st.hoje;
      id("AusMotivo").value = "Férias";
      document.querySelector(`input[name="${P}AusModo"][value="uma"]`).checked = true;
      id("AusMsg").textContent = "";
      st.acao = { tipo: "ausencia" };
      montarAusencia();
      abrirModal(P + "ModalAusencia");
    }

    function opcoesCobertura(select, exceto, vazio) {
      select.replaceChildren(new Option(vazio, ""));
      destinos().filter(p => p !== exceto).forEach(p => select.append(new Option(curto(p), p)));
    }

    function modoAusencia() {
      return document.querySelector(`input[name="${P}AusModo"]:checked`).value;
    }

    function montarAusencia() {
      const p = id("AusPessoa").value;
      const modo = modoAusencia();

      const uma = id("AusPara");
      const escolhida = uma.value;
      opcoesCobertura(uma, p, "Escolher…");
      if (escolhida && escolhida !== p) uma.value = escolhida;
      uma.disabled = modo !== "uma";

      const lista = id("AusLista");
      lista.hidden = modo !== "dividir" || !p;
      lista.replaceChildren();
      if (modo === "dividir" && p) {
        itensDe(p).forEach(i => {
          const linha = el("label", "eq-dist-linha");
          const s = el("select");
          s.dataset.id = i.id;
          opcoesCobertura(s, p, "Sem cobertura");
          linha.append(el("span", null, i.nome), s);
          lista.append(linha);
        });
      }
      id("AusFim").min = id("AusInicio").value || st.hoje;
    }

    async function confirmarAusencia() {
      const msg = id("AusMsg");
      msg.textContent = "";
      const p = id("AusPessoa").value;
      const inicio = id("AusInicio").value;
      const fim = id("AusFim").value;
      const modo = modoAusencia();

      if (!p) { msg.textContent = "Escolha quem vai se ausentar."; return; }
      if (!inicio || !fim) { msg.textContent = "Informe o início e a data final."; return; }
      if (fim < inicio) { msg.textContent = "A data final não pode ser antes do início."; return; }

      let distribuicao;
      if (modo === "uma") {
        const para = id("AusPara").value;
        if (!para) { msg.textContent = "Escolha quem vai cobrir."; return; }
        distribuicao = itensDe(p).map(i => ({ [cfg.chave]: i.id, para }));
      } else {
        distribuicao = [...id("AusLista").querySelectorAll("select")]
          .filter(s => s.value)
          .map(s => ({ [cfg.chave]: Number(s.dataset.id), para: s.value }));
        if (!distribuicao.length) { msg.textContent = `Escolha quem cobre pelo menos um ${T.um}.`; return; }
      }

      const chamada = rpc("registrar_ausencia", {
        p_email: p, p_inicio: inicio, p_fim: fim, p_motivo: id("AusMotivo").value || null,
        p_distribuicao: distribuicao
      });
      await executar(P + "AusConfirmar", msg, chamada, P + "ModalAusencia",
        `Ausência de ${curto(p)} registrada até ${ddmm(fim)}.`);
    }

    function confirmarEncerrarAusencia(p, n) {
      abrirConfirmar({
        titulo: "Encerrar ausência",
        texto: `${curto(p)} voltou antes? ${plural(n, `${T.um} volta`, `${T.varios} voltam`)} para ${curto(p)} agora.`,
        botao: "Encerrar ausência",
        executar: () => rpc("encerrar_ausencia", { p_email: p }),
        sucesso: `${T.Varios} devolvidos para ${curto(p)}.`
      });
    }

    /* =====================================================
       CADEADO
    ===================================================== */
    async function confirmarDestravar() {
      const pin = id("Pin").value.trim();
      const msg = id("PinMsg");
      msg.textContent = "";
      if (!/^\d{6}$/.test(pin)) { msg.textContent = "Digite os 6 números da sua senha."; return; }

      const btn = id("PinConfirmar");
      btn.disabled = true;
      // Confere a senha no próprio Supabase: é o mesmo login de sempre
      const { error } = await supabaseClient.auth.signInWithPassword({ email: st.email, password: pin });
      btn.disabled = false;

      if (error) {
        msg.textContent = "Senha incorreta.";
        id("Pin").select();
        return;
      }

      const depois = st.depoisDestravar;
      st.destravado = true;
      fecharModal(P + "ModalDestravar");
      st.ultimoUso = Date.now();
      clearInterval(st.timerTrava);
      st.timerTrava = setInterval(checarTrava, 15000);
      renderAdmin();
      if (depois) depois();
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
      const b = id("Cadeado");
      b.classList.toggle("aberto", st.destravado);
      b.setAttribute("aria-pressed", String(st.destravado));
      id("BtnAusencia").disabled = !st.destravado;
      const resto = id("CadeadoResto");
      if (st.destravado) {
        const min = Math.max(1, Math.ceil((TRAVA_MS - (Date.now() - st.ultimoUso)) / 60000));
        id("CadeadoTexto").textContent = "Edição liberada";
        resto.textContent = `· trava em ${min} min`;
        resto.hidden = false;
        b.title = "Clique para travar agora";
      } else {
        id("CadeadoTexto").textContent = "Edição travada";
        resto.hidden = true;
        b.title = "Clique e digite sua senha para editar";
      }
    }

    /* =====================================================
       IMPRIMIR / PDF
       Monta a lista num bloco só de impressão (#relatorioImpressao,
       fora das seções) e chama a impressão do navegador, onde dá para
       escolher "Salvar como PDF". Sem biblioteca: a CSP só aceita
       scripts do próprio site. Três recortes:
        - geral     : ausências, uma seção por pessoa e os sem responsável
        - ausencias : só quem está (ou vai ficar) fora e com quem ficou cada item
        - pessoa    : os itens de uma pessoa, o que ela cobre e a ausência dela
    ===================================================== */
    function abrirImprimir(pessoa) {
      const sel = id("ImpPessoa");
      sel.replaceChildren(new Option("Escolha a pessoa…", ""));
      st.pessoas.forEach(p => sel.append(new Option(curto(p), p)));
      sel.value = pessoa || "";
      const modo = pessoa ? "pessoa" : "geral";
      document.querySelector(`input[name="${P}ImpModo"][value="${modo}"]`).checked = true;
      id("ImpMsg").textContent = "";
      abrirModal(P + "ModalImprimir");
    }

    async function confirmarImprimir() {
      const msg = id("ImpMsg");
      msg.textContent = "";
      const modo = document.querySelector(`input[name="${P}ImpModo"]:checked`).value;
      const p = id("ImpPessoa").value;
      if (modo === "pessoa" && !p) { msg.textContent = "Escolha a pessoa."; return; }

      // Recarrega antes: outra pessoa pode ter mexido desde a última carga
      const btn = id("ImpConfirmar");
      btn.disabled = true;
      const ok = await carregar();
      btn.disabled = false;
      if (!ok) { msg.textContent = "Não foi possível atualizar os dados. Tente novamente."; return; }

      fecharModal(P + "ModalImprimir");
      imprimir(modo, p);
    }

    function imprimir(modo, p) {
      let raiz = $("relatorioImpressao");
      if (!raiz) {
        raiz = el("div", "relatorio");
        raiz.id = "relatorioImpressao";
        document.body.append(raiz);
      }
      raiz.replaceChildren(...montarRelatorio(modo, p));

      // O título vira o nome sugerido do arquivo PDF
      const recorte = modo === "pessoa" ? curto(p) : modo === "ausencias" ? "ausencias" : "geral";
      const tituloAntes = document.title;
      document.title = `${T.modulo} - ${recorte} - ${st.hoje}`;
      document.body.classList.add("imprimindo");

      const limpar = () => {
        window.removeEventListener("afterprint", limpar);
        document.body.classList.remove("imprimindo");
        document.title = tituloAntes;
        raiz.replaceChildren();
      };
      window.addEventListener("afterprint", limpar);
      window.print();
    }

    function montarRelatorio(modo, p) {
      const infos = [...st.porId.values()];
      const partes = [];

      const titulo = {
        geral: `Distribuição de ${T.varios}`,
        ausencias: "Ausências e redistribuição",
        pessoa: `${T.Varios} de ${curto(p)}`
      }[modo];
      const agora = new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short"
      }).format(new Date());

      const cab = el("header", "rel-cab");
      cab.append(el("p", "rel-modulo", `Locus · ${T.modulo}`), el("h1", null, titulo),
        el("p", "rel-gerado", `Situação em ${ddmmaaaa(st.hoje)} · gerado em ${agora} por ${curto(st.email)}`));
      partes.push(cab);

      if (modo === "geral") {
        const ausentes = new Set(infos.filter(i => i.cob).map(i => i.dono));
        const resumo = el("div", "rel-resumo");
        [
          [infos.length, T.Varios],
          [st.pessoas.length, "Pessoas"],
          [infos.filter(i => i.cob).length, "Em cobertura"],
          [ausentes.size, "Ausentes hoje"],
          [infos.filter(i => !i.dono).length, "Sem responsável"]
        ].forEach(([n, rotulo]) => {
          const b = el("div", "rel-resumo-item");
          b.append(el("strong", null, n), el("span", null, rotulo));
          resumo.append(b);
        });
        partes.push(resumo);

        const aus = secaoAusencias(null);
        if (aus) partes.push(aus);

        const pessoas = el("section", "rel-bloco");
        pessoas.append(el("h2", "rel-h2", "Por pessoa"));
        st.pessoas.forEach(x => pessoas.append(secaoPessoa(x, infos)));
        partes.push(pessoas);

        const sem = infos.filter(i => !i.dono);
        if (sem.length) {
          const s = el("section", "rel-bloco");
          s.append(el("h2", "rel-h2", `Sem responsável · ${sem.length}`),
            tabela([T.Um, ...colEmpresas()], sem.map(i => [i.nome, ...celEmpresas(i)])));
          partes.push(s);
        }
      } else if (modo === "ausencias") {
        partes.push(secaoAusencias(null) ||
          el("p", "rel-vazio", "Ninguém ausente nem com ausência agendada."));
      } else {
        partes.push(secaoPessoa(p, infos));
        const aus = secaoAusencias(p);
        if (aus) partes.push(aus);
      }
      return partes;
    }

    // Uma tabela por ausência (em andamento ou agendada): com quem ficou cada item
    function secaoAusencias(soDe) {
      const grupos = new Map();
      st.coberturas.forEach(c => {
        if (soDe && c.de_email !== soDe) return;
        if (!st.porId.has(c.item_id)) return;
        const k = [c.de_email, c.inicio, c.fim, c.motivo || ""].join("|");
        if (!grupos.has(k)) grupos.set(k, { de: c.de_email, inicio: c.inicio, fim: c.fim, motivo: c.motivo, cobs: [] });
        grupos.get(k).cobs.push(c);
      });
      if (!grupos.size) return null;

      const s = el("section", "rel-bloco");
      s.append(el("h2", "rel-h2", "Ausências e redistribuição"));
      [...grupos.values()]
        .sort((a, b) => a.inicio.localeCompare(b.inicio) || a.de.localeCompare(b.de))
        .forEach(g => {
          const emAndamento = g.inicio <= st.hoje;
          const caixa = el("div", "rel-ausencia");
          const linha = el("div", "rel-ausencia-cab");
          linha.append(el("h3", null, curto(g.de)),
            el("span", "rel-selo" + (emAndamento ? "" : " rel-selo-agendado"),
              `${g.motivo || "Ausência"} · ${ddmmaaaa(g.inicio)} a ${ddmmaaaa(g.fim)}`));
          caixa.append(linha);
          caixa.append(el("p", "rel-nota",
            `${emAndamento ? "Fora agora." : "Agendada."} Os ${T.varios} voltam para ${curto(g.de)} em ${ddmmaaaa(somarDias(g.fim, 1))}.`));

          const nomes = new Map(g.cobs.map(c => [c.item_id, c.para_email]));
          const linhas = [...st.porId.values()]
            .filter(i => nomes.has(i.id))
            .map(i => [i.nome, ...celEmpresas(i), curto(nomes.get(i.id))]);
          // Itens da pessoa que ficaram sem ninguém no período (dividir item por item)
          itensDe(g.de).filter(i => !nomes.has(i.id)).forEach(i =>
            linhas.push({ cels: [i.nome, ...celEmpresas(i), "Sem cobertura"], classe: "rel-alerta" }));
          caixa.append(tabela([T.Um, ...colEmpresas(), "Fica com"], linhas));
          s.append(caixa);
        });
      return s;
    }

    function secaoPessoa(p, infos) {
      const meus = infos.filter(i => i.dono === p);
      const fora = meus.filter(i => i.cob);
      const cobrindo = infos.filter(i => i.cob && i.cob.para_email === p);
      const agendadas = st.coberturas.filter(c => c.inicio > st.hoje && c.para_email === p && st.porId.has(c.item_id));

      const s = el("section", "rel-pessoa");
      const cab = el("div", "rel-pessoa-cab");
      cab.append(el("h3", null, curto(p)), el("span", "rel-email", p));
      if (fora.length) {
        const volta = fora.reduce((m, i) => (i.cob.fim > m ? i.cob.fim : m), "");
        cab.append(el("span", "rel-selo", `${fora[0].cob.motivo || "Ausente"} até ${ddmmaaaa(volta)}`));
      }
      if (st.foraEquipe.has(p)) cab.append(el("span", "rel-selo rel-selo-agendado", `Fora do ${T.modulo}`));
      s.append(cab);

      let resumo = plural(meus.length, `${T.um} fixo`, `${T.varios} fixos`);
      if (fora.length) resumo += ` · ${fora.length} com outra pessoa`;
      if (cobrindo.length) resumo += ` · cobrindo ${cobrindo.length}`;
      s.append(el("p", "rel-nota", resumo));

      if (meus.length) {
        s.append(tabela([T.Um, ...colEmpresas(), "Quem faz agora", "Observação"], meus.map(i => {
          const cels = [i.nome, ...celEmpresas(i),
            i.cob ? `${curto(i.cob.para_email)} (até ${ddmmaaaa(i.cob.fim)})` : curto(p),
            i.futura ? `Agendado: com ${curto(i.futura.para_email)} de ${ddmm(i.futura.inicio)} a ${ddmm(i.futura.fim)}` : ""];
          return i.cob ? { cels, classe: "rel-destaque" } : cels;
        })));
      }
      if (cobrindo.length) {
        s.append(el("h4", null, `Cobrindo de outras pessoas · ${cobrindo.length}`));
        s.append(tabela([T.Um, ...colEmpresas(), "De", "Até"], cobrindo.map(i =>
          [i.nome, ...celEmpresas(i), curto(i.cob.de_email), ddmmaaaa(i.cob.fim)])));
      }
      if (agendadas.length) {
        s.append(el("h4", null, `Coberturas agendadas · ${agendadas.length}`));
        s.append(tabela([T.Um, ...colEmpresas(), "De", "Período"], agendadas.map(c => {
          const i = st.porId.get(c.item_id);
          return [i.nome, ...celEmpresas(i), curto(c.de_email), `${ddmmaaaa(c.inicio)} a ${ddmmaaaa(c.fim)}`];
        })));
      }
      if (!meus.length && !cobrindo.length && !agendadas.length) {
        s.append(el("p", "rel-vazio", `Nenhum ${T.um} no momento.`));
      }
      return s;
    }

    // Faturamento: coluna com as empresas que o faturista fecha
    function colEmpresas() { return cfg.empresas ? ["Empresas"] : []; }
    function celEmpresas(i) { return cfg.empresas ? [(i.empresas || []).join(" / ")] : []; }

    // linhas: arrays de textos ou { cels, classe } para destacar a linha
    function tabela(cabecalhos, linhas) {
      const t = el("table", "rel-tabela");
      const trCab = el("tr");
      cabecalhos.forEach(h => trCab.append(el("th", null, h)));
      const thead = el("thead");
      thead.append(trCab);
      const tbody = el("tbody");
      linhas.forEach(l => {
        const tr = el("tr", Array.isArray(l) ? null : l.classe);
        (Array.isArray(l) ? l : l.cels).forEach(c => tr.append(el("td", null, c)));
        tbody.append(tr);
      });
      t.append(thead, tbody);
      return t;
    }

    /* =====================================================
       VISÃO DE QUEM NÃO É GESTOR
    ===================================================== */
    function renderUsuario() {
      const raiz = id("Usuario");
      raiz.replaceChildren();
      const me = st.email;

      // Nível Consulta: não tem itens, só consulta quem responde por cada um
      if (!st.operador) {
        if (st.consulta) raiz.append(blocoConsulta());
        else raiz.append(el("p", "eq-vazio eq-vazio-grande", `Não foi possível carregar a lista de ${T.varios}.`));
        return;
      }
      const infos = [...st.porId.values()];

      const cobrindo = infos.filter(i => i.cob && i.cob.para_email === me);
      const fixos = infos.filter(i => i.dono === me && !i.cob);
      const fora = infos.filter(i => i.dono === me && i.cob);
      const agendadas = st.coberturas.filter(c => c.inicio > st.hoje && c.para_email === me);

      if (!cobrindo.length && !fixos.length && !fora.length && !agendadas.length) {
        raiz.append(el("p", "eq-vazio eq-vazio-grande", `Nenhum ${T.um} atribuído a você ainda.`));
        if (st.consulta) raiz.append(blocoConsulta());
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
          ...(st.porId.get(c.item_id) || { nome: T.Um }),
          agendaTxt: `De ${curto(c.de_email)}, de ${ddmm(c.inicio)} a ${ddmm(c.fim)}`
        }));
        raiz.append(bloco(`Coberturas agendadas · ${lista.length}`, `Você vai cobrir estes ${T.varios} nas datas abaixo.`, lista, "agenda"));
      }

      raiz.append(bloco(`Meus ${T.varios} fixos · ${fixos.length}`, null, fixos, "fixo"));

      raiz.append(fora.length
        ? bloco(`Seus ${T.varios} com outra pessoa`, "Enquanto você está fora, quem responde por eles é:", fora, "fora")
        : bloco(`Seus ${T.varios} com outra pessoa`, `Nenhum no momento. Quando você tiver uma ausência registrada, aparece aqui quem está cobrindo cada ${T.um}.`, [], "fora"));

      if (st.consulta) raiz.append(blocoConsulta());
    }

    /* ---------- Todos os itens (somente consulta) ----------
       Mostra quem responde por cada item. Não tem nenhuma ação:
       os dados vêm de <prefixo>consultar_responsaveis(), que só lê. */
    function blocoConsulta() {
      const s = el("section", "eq-bloco eq-bloco-consulta");

      const topo = el("div", "eq-consulta-topo");
      topo.append(el("h2", null, `Todos os ${T.varios} · ${st.consulta.length}`),
        el("span", "eq-selo-consulta", "Somente consulta"));
      s.append(topo);
      s.append(el("p", "eq-bloco-desc",
        `Veja quem responde por cada ${T.um}. Para mudar alguma coisa, fale com um gestor do ${T.modulo}.`));

      const barra = el("div", "eq-consulta-barra");
      const busca = el("label", "eq-busca");
      busca.append(el("span", "visualmente-oculto", `Buscar ${T.um} ou pessoa`), icone("busca"));
      const input = el("input");
      input.type = "search";
      input.placeholder = `Buscar ${T.um} ou pessoa…`;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.value = st.consultaBusca;
      busca.append(input);

      const filtros = el("div", "eq-consulta-filtros");
      filtros.setAttribute("role", "group");
      filtros.setAttribute("aria-label", `Filtrar ${T.varios}`);
      const opcoes = [["todos", "Todos"], ["cobertura", "Em cobertura"], ["sem", "Sem responsável"]];
      const botoes = opcoes.map(([valor, rotulo]) => {
        const b = el("button", "eq-filtro", rotulo);
        b.type = "button";
        b.dataset.filtro = valor;
        b.setAttribute("aria-pressed", String(st.consultaFiltro === valor));
        return b;
      });
      filtros.append(...botoes);
      barra.append(busca, filtros);
      s.append(barra);

      const lista = el("div", "eq-consulta-lista");
      const vazio = el("p", "eq-consulta-vazio", `Nenhum ${T.um} encontrado.`);
      s.append(lista, vazio);

      // Só a lista é redesenhada ao buscar/filtrar, para não perder o foco do campo
      const desenhar = () => {
        lista.replaceChildren();
        const termo = norm(st.consultaBusca);
        let n = 0;
        st.consulta.forEach(h => {
          if (st.consultaFiltro === "cobertura" && !h.cobrindo) return;
          if (st.consultaFiltro === "sem" && h.dono) return;
          if (termo && !norm(`${h.nome} ${curto(h.dono)} ${curto(h.cobrindo)}`).includes(termo)) return;
          lista.append(linhaConsulta(h));
          n++;
        });
        vazio.hidden = n > 0;
      };

      input.addEventListener("input", () => { st.consultaBusca = input.value; desenhar(); });
      botoes.forEach(b => b.addEventListener("click", () => {
        st.consultaFiltro = b.dataset.filtro;
        botoes.forEach(x => x.setAttribute("aria-pressed", String(x === b)));
        desenhar();
      }));

      desenhar();
      return s;
    }

    function linhaConsulta(h) {
      const me = st.email;
      const meu = h.dono === me || h.cobrindo === me;
      const linha = el("div", "eq-consulta-linha" + (meu ? " eq-consulta-meu" : ""));
      if (cfg.agenda) {
        // O nome vira botão: agenda e atalho para o calendário
        const nome = el("button", "eq-consulta-nome eq-link-nome");
        nome.type = "button";
        nome.title = "Ver agenda no calendário";
        nome.append(el("span", null, h.nome));
        const ag = nomeAgenda(h.agenda);
        if (ag) {
          const t = el("span", "eq-consulta-agenda");
          t.append(icone("agenda"), document.createTextNode(ag));
          nome.append(t);
        }
        nome.addEventListener("click", () => abrirTag(h));
        linha.append(nome);
      } else {
        linha.append(el("span", "eq-consulta-nome", h.nome));
      }

      let quem;
      if (h.cobrindo === me) {
        quem = el("span", "eq-pill eq-pill-cobrindo", `Você, cobrindo ${curto(h.dono)} até ${ddmm(h.fim)}`);
      } else if (h.dono === me && h.cobrindo) {
        quem = el("span", "eq-pill eq-pill-fora", `Seu · com ${curto(h.cobrindo)} até ${ddmm(h.fim)}`);
      } else if (h.dono === me) {
        quem = el("span", "eq-pill eq-pill-voce", "Você");
      } else if (h.cobrindo) {
        quem = el("span", "eq-consulta-quem", `${curto(h.cobrindo)} (cobrindo ${curto(h.dono)} até ${ddmm(h.fim)})`);
      } else if (h.dono) {
        quem = el("span", "eq-consulta-quem", curto(h.dono));
      } else {
        quem = el("span", "eq-pill eq-pill-sem", "Sem responsável");
      }
      linha.append(quem);
      return linha;
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
      id("ConfTitulo").textContent = op.titulo;
      id("ConfTexto").textContent = op.texto;
      preencherNomes(id("ConfLista"), op.nomes || []);
      id("ConfBotao").textContent = op.botao;
      id("ConfMsg").textContent = "";
      st.acao = { tipo: "confirmar", ...op };
      abrirModal(P + "ModalConfirmar");
    }

    async function confirmarGenerico() {
      const a = st.acao;
      await executar(P + "ConfBotao", id("ConfMsg"), a.executar(), P + "ModalConfirmar", a.sucesso, a.limparSelecao);
    }

    // Roda a chamada ao banco, mostra o erro no próprio modal ou fecha e recarrega
    async function executar(btnId, msg, promessa, modalId, textoSucesso, idsSelecao) {
      const btn = $(btnId);
      btn.disabled = true;
      const { error } = await promessa;
      btn.disabled = false;
      if (error) {
        console.error(`Erro no ${T.modulo}:`, error);
        msg.textContent = error.message || "Não foi possível salvar. Tente novamente.";
        return;
      }
      (idsSelecao || []).forEach(i => st.selecionados.delete(i));
      fecharModal(modalId);
      await carregar();
      avisar(textoSucesso);
    }

    function abrirModal(modalId, aoAbrir) {
      const m = $(modalId);
      m._focoAnterior = document.activeElement;
      m.hidden = false;
      (aoAbrir || (() => m.querySelector("input, select, button:not(.modal-fechar)")?.focus()))();
    }

    function fecharModal(modalId) {
      const m = $(modalId);
      if (m.hidden) return;
      m.hidden = true;
      if (modalId === P + "ModalDestravar") {
        id("Pin").value = "";
        st.depoisDestravar = null; // usado (ou a senha foi cancelada)
      }
      st.acao = null;
      m._focoAnterior?.focus?.();
    }

    function prepararModais() {
      MODAIS.forEach(modalId => {
        $(modalId).addEventListener("click", e => {
          // Só o X / botões [data-fechar] fecham; clique no fundo é ignorado
          if (e.target.closest("[data-fechar]")) fecharModal(modalId);
        });
      });
      document.addEventListener("keydown", e => {
        if (e.key !== "Escape") return;
        const aberto = MODAIS.find(m => !$(m).hidden);
        if (aberto) fecharModal(aberto);
      });

      // Motivos
      [id("MoverMotivo"), id("AusMotivo")].forEach((s, i) => {
        if (i === 0) s.append(new Option("Sem motivo", ""));
        MOTIVOS.forEach(m => s.append(new Option(m, m)));
      });

      // Mover
      document.querySelectorAll(`input[name="${P}Tipo"]`).forEach(r => r.addEventListener("change", atualizarMover));
      id("MoverInicio").addEventListener("input", atualizarMover);
      id("MoverFim").addEventListener("input", atualizarMover);
      id("MoverConfirmar").addEventListener("click", confirmarMover);

      // Destravar
      id("Pin").addEventListener("input", e => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });
      id("Pin").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); confirmarDestravar(); } });
      // O form existe só para o Chrome entender o par email/senha; nunca envia
      id("PinForm").addEventListener("submit", e => e.preventDefault());
      id("PinUsuario").value = st.email || "";
      id("PinConfirmar").addEventListener("click", confirmarDestravar);

      // Ausência
      id("AusPessoa").addEventListener("change", montarAusencia);
      id("AusInicio").addEventListener("input", montarAusencia);
      document.querySelectorAll(`input[name="${P}AusModo"]`).forEach(r => r.addEventListener("change", montarAusencia));
      id("AusConfirmar").addEventListener("click", confirmarAusencia);

      // Criar
      id("CriarConfirmar").addEventListener("click", confirmarCriar);
      id("CriarNome").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); confirmarCriar(); } });
      id("CriarNome").addEventListener("input", () => { id("CriarMsg").textContent = ""; });

      // Renomear / excluir
      id("EditarSalvar").addEventListener("click", confirmarRenomear);
      id("EditarExcluir").addEventListener("click", pedirExcluir);
      id("EditarNome").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); confirmarRenomear(); } });
      id("EditarNome").addEventListener("input", () => { id("EditarMsg").textContent = ""; });

      // Confirmação genérica
      id("ConfBotao").addEventListener("click", confirmarGenerico);

      // Imprimir / PDF: escolher a pessoa já marca "Uma pessoa"
      id("ImpPessoa").addEventListener("change", e => {
        if (e.target.value) document.querySelector(`input[name="${P}ImpModo"][value="pessoa"]`).checked = true;
      });
      id("ImpConfirmar").addEventListener("click", confirmarImprimir);

      if (!cfg.agenda) return;

      // Agenda no calendário
      id("TagIr").addEventListener("click", irParaEntrega);
      id("TagEditar").addEventListener("click", editarPelaTag);
      // Ao digitar o nome, sugere a agenda (até a pessoa escolher uma)
      id("CriarAgenda").addEventListener("change", e => { e.target.dataset.escolhida = "1"; });
      id("CriarNome").addEventListener("input", () => {
        const sel = id("CriarAgenda");
        if (!st.agendas || sel.dataset.escolhida) return;
        const sug = sugerirAgenda(id("CriarNome").value);
        sel.value = sug ? String(sug) : "";
      });
      // O calendário mudou (convênio criado, renomeado ou excluído)
      document.addEventListener("faturamento:agendas", () => {
        if (st.pronto && !modalAberto() && !st.arrastando) carregar();
      });
    }
  }

  /* =====================================================
     OS DOIS QUADROS
  ===================================================== */

  // Na tela "Pré-faturamento"; no código e no banco continua "equipe"
  // (ids eq*, funções equipe_*) para não quebrar nada.
  criarQuadro({
    prefixo: "eq",
    painel: "painelEquipe",
    modulo: "prefat",
    evento: "equipe:recarregar",
    rpc: "equipe_",
    argIds: "p_hospitais",
    chave: "hospital_id",
    tabelas: { itens: "hospitais", resp: "hospital_responsavel", cob: "hospital_coberturas" },
    textos: { um: "hospital", varios: "hospitais", Um: "Hospital", Varios: "Hospitais", modulo: "Pré-faturamento" },
    criar: { rpc: "equipe_criar_hospital", semNome: "Informe o nome da instituição." },
    editar: { renomear: "equipe_renomear_hospital", excluir: "equipe_excluir_hospital" }
  });

  // Quem faz cada convênio. Os nomes são livres, ex.: "AMIL (Clínica)",
  // e cada um pode apontar para um convênio do Calendário de entrega.
  criarQuadro({
    prefixo: "fat",
    painel: "painelFaturamento",
    modulo: "faturamento",
    evento: "faturamento:recarregar",
    rpc: "fat_",
    argIds: "p_convenios",
    chave: "convenio_id",
    tabelas: { itens: "fat_convenios", resp: "fat_responsavel", cob: "fat_coberturas" },
    textos: { um: "convênio", varios: "convênios", Um: "Convênio", Varios: "Convênios", modulo: "Faturamento" },
    criar: { rpc: "fat_criar_convenio", semNome: "Informe o nome do convênio." },
    editar: { renomear: "fat_renomear_convenio", excluir: "fat_excluir_convenio" },
    agenda: true,  // cada convênio pode apontar para um convênio do Calendário
    empresas: ["CH", "CTS", "CTN", "HA"]  // empresas que o faturista fecha naquele convênio
  });
})();
