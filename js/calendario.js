/*
 * CALENDARIO.JS — calendário de entrega de faturamento.
 *
 * Só controle de datas: quando cada convênio tem que ser entregue.
 * Um convênio aparece uma vez só, mesmo que seja faturado por mais de
 * uma empresa (as datas são as mesmas). Quem faz cada convênio fica no
 * Faturamento (js/quadro.js): lá, cada convênio ("AMIL (Clínica)",
 * "AMIL (CTN)"...) pode apontar para um convênio daqui ("AMIL"). O
 * detalhe mostra esses nomes e o Faturamento pede, pelo evento
 * "calendario:ir-para", para abrir a próxima data de entrega.
 *
 * Quem vê o quê (as regras de verdade estão no banco, sql/faturamento.sql):
 *  - Consulta          : vê o calendário, a lista de convênios e as
 *                        observações. Não altera nada.
 *  - Operador e Gestor : também criam, editam e excluem convênios,
 *                        transferem o prazo de um convênio num mês
 *                        (ajuste pontual) e lançam observações do dia.
 *
 * Os prazos são calculados aqui a partir da regra de cada convênio.
 * A observação marcada "não há expediente" tira o dia da conta de dias
 * úteis. Sábado, domingo e dias sem expediente nunca são dia de entrega:
 * a data cai para o dia útil anterior ou seguinte, conforme a regra.
 *
 * Nada aqui usa estilo inline nem HTML com dados do banco: os textos
 * entram sempre por textContent (a CSP do vercel.json bloqueia inline).
 */
(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
                 "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const DIAS_CURTOS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const CHIPS_POR_DIA = 4;            // no máximo; se o dia for baixo, menos (o resto fica atrás de "+N")
  const RECARGA_MIN_MS = 30 * 1000;   // recarga ao voltar para a aba

  const st = {
    email: "",
    editor: false,          // Operador ou Gestor no Calendário
    pronto: false,
    hoje: "",
    ano: 0,
    mes: 0,                 // 0 a 11
    convenios: [],
    obs: new Map(),         // "aaaa-mm-dd" -> [observações do dia]
    semExpediente: new Map(), // "aaaa-mm-dd" -> texto (dia que não conta como útil)
    ajustes: new Map(),     // "id|aaaa-mm-01" -> {prazo, motivo, ajustado_por}
    vinculos: new Map(),    // id -> nomes no Faturamento que usam este convênio
    janelas: true,
    busca: "",
    abertos: new Set(),     // convênios expandidos na lista lateral
    lateral: false,         // lista lateral aberta (começa fechada)
    edicao: null,           // convênio no modal de edição (null = criação)
    tipo: "periodo",        // tipo escolhido no modal
    detalhe: null,          // {c, a, m} no modal de detalhe
    obsData: null,          // dia aberto no modal de observações
    carga: 0,               // descarta respostas de cargas antigas
    ultimaCarga: 0
  };

  const podeEditar = () => st.editor;

  /* =====================================================
     UTILITÁRIOS
  ===================================================== */
  function hojeSP() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
  }

  function dataSP(ts) {
    if (!ts) return "";
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date(ts));
  }

  const D = (a, m, d) => new Date(Date.UTC(a, m, d));
  const iso = d => d.toISOString().slice(0, 10);
  const deIso = s => { const [a, m, d] = s.split("-").map(Number); return D(a, m - 1, d); };
  const somarDias = (d, n) => D(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n);
  const ultimoDia = (a, m) => D(a, m + 1, 0).getUTCDate();
  const pad = n => String(n).padStart(2, "0");
  const mesIso = (a, m) => `${a}-${pad(m + 1)}-01`;
  const chave = (id, a, m) => `${id}|${mesIso(a, m)}`;
  const ddmm = s => s ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : "";
  const ddmmaaaa = s => s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "";
  const curto = email => (email || "").split("@")[0];

  function somarMes(a, m, n) {
    const t = a * 12 + m + n;
    return [Math.floor(t / 12), ((t % 12) + 12) % 12];
  }

  function norm(txt) {
    return (txt || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }

  function botao(classe, texto, aoClicar) {
    const b = el("button", classe, texto);
    b.type = "button";
    if (aoClicar) b.addEventListener("click", aoClicar);
    return b;
  }

  function lista(itens) {
    if (itens.length <= 1) return itens.join("");
    return itens.slice(0, -1).join(", ") + " e " + itens[itens.length - 1];
  }

  let avisoEl = null;
  function avisar(texto) {
    if (!avisoEl) {
      avisoEl = el("div", "aviso-atualizacao");
      avisoEl.setAttribute("role", "status");
      avisoEl.setAttribute("aria-live", "polite");
      document.body.append(avisoEl);
    }
    avisoEl.textContent = texto;
    avisoEl.hidden = false;
    clearTimeout(avisoEl._timer);
    avisoEl._timer = setTimeout(() => { avisoEl.hidden = true; }, 4000);
  }

  // Mensagens das funções do banco já vêm em português; o resto vira genérico
  function mensagemErro(error, padrao) {
    if (error && (error.code === "P0001" || error.code === "42501") && error.message) return error.message;
    return padrao;
  }

  /* =====================================================
     REGRAS DE PRAZO
  ===================================================== */
  function diaUtil(d) {
    const w = d.getUTCDay();
    return w > 0 && w < 6 && !st.semExpediente.has(iso(d));
  }

  function ajustar(d, sentido) {
    const passo = sentido === "anterior" ? -1 : 1;
    let x = d;
    for (let i = 0; i < 40 && !diaUtil(x); i++) x = somarDias(x, passo);
    return x;
  }

  // n-ésimo dia útil do mês (se o mês não tiver tantos, o último dia útil)
  function enesimoDiaUtil(a, m, n) {
    let contagem = 0;
    let ultimo = null;
    for (let d = 1; d <= ultimoDia(a, m); d++) {
      const x = D(a, m, d);
      if (!diaUtil(x)) continue;
      ultimo = x;
      if (++contagem === n) return x;
    }
    return ultimo || ajustar(D(a, m, ultimoDia(a, m)), "anterior");
  }

  /* Janela de entrega do convênio no mês, já com o ajuste pontual (se
     houver): {ini, fim, base, regraFim?, ajuste?}. */
  function janela(c, a, m) {
    const j = janelaRegra(c, a, m);
    if (!j || !c.id) return j;
    const aj = st.ajustes.get(chave(c.id, a, m));
    if (!aj) return j;
    const r = { ...j, regraFim: j.fim, fim: aj.prazo, ajuste: aj };
    // Dia fixo é um dia só: muda inteiro. Período e dia útil mantêm o início.
    if (c.tipo === "fixo" || r.ini > r.fim) r.ini = r.fim;
    return r;
  }

  /* Janela pela regra do convênio: {ini, fim, base}.
     base = a data "de calendário" antes do ajuste de fim de semana/feriado. */
  function janelaRegra(c, a, m) {
    const ult = ultimoDia(a, m);
    if (c.tipo === "fixo") {
      const base = D(a, m, Math.min(c.dia_inicio, ult));
      const f = ajustar(base, c.ajuste);
      return { ini: iso(f), fim: iso(f), base: iso(base) };
    }
    if (c.tipo === "periodo") {
      const baseFim = D(a, m, Math.min(c.dia_fim, ult));
      let i = ajustar(D(a, m, Math.min(c.dia_inicio, ult)), "proximo");
      const f = ajustar(baseFim, c.ajuste);
      if (i > f) i = f;
      return { ini: iso(i), fim: iso(f), base: iso(baseFim) };
    }
    if (c.tipo === "util") {
      return { ini: iso(enesimoDiaUtil(a, m, 1)), fim: iso(enesimoDiaUtil(a, m, c.dia_util)), base: null };
    }
    return null; // livre
  }

  function notaAjuste(j) {
    if (!j) return "";
    if (j.ajuste) return notaAjustePontual(j);
    if (!j.base || j.base === j.fim) return "";
    const fer = st.semExpediente.get(j.base);
    const motivo = fer ? `não tem expediente (${fer})` : `cai num ${DIAS[deIso(j.base).getUTCDay()]}`;
    return `${ddmm(j.base)} ${motivo}: ${j.fim > j.base ? "adiado" : "antecipado"} para ${ddmm(j.fim)}`;
  }

  function notaAjustePontual(j) {
    const a = j.ajuste;
    const quem = a.ajustado_por ? ` por ${curto(a.ajustado_por)}` : "";
    const motivo = a.motivo ? `: ${a.motivo}` : "";
    return `Só neste mês, de ${ddmm(j.regraFim)} para ${ddmm(j.fim)}${quem}${motivo}`;
  }

  function textoRegra(c) {
    const ajuste = c.ajuste === "anterior" ? "antecipa" : "adia";
    if (c.tipo === "fixo") return `Todo dia ${c.dia_inicio} (se não for dia útil, ${ajuste})`;
    if (c.tipo === "periodo") return `Do dia ${c.dia_inicio} ao dia ${c.dia_fim} (se o último dia não for útil, ${ajuste})`;
    if (c.tipo === "util") return `Até o ${c.dia_util}º dia útil do mês`;
    const dias = c.dias_semana || [];
    return dias.length === 5 ? "Livre: qualquer dia útil" : `Livre: ${lista(dias.map(d => DIAS[d]))}`;
  }

  function textoPrazo(j) {
    if (!j) return "Qualquer dia permitido no mês";
    return j.ini === j.fim ? ddmm(j.fim) : `${ddmm(j.ini)} a ${ddmm(j.fim)}`;
  }

  /* Sem status: não há marcação de entrega, então só importa a data.
     O que passou já aparece esmaecido na grade (dia passado). Um prazo
     que já tinha passado quando o convênio foi cadastrado não aparece. */
  function antesDoCadastro(c, j) {
    return !!j && j.fim < c.criadoDia;
  }

  /* Convênios que aparecem no mês. Um convênio só conta a partir do
     mês em que foi criado. */
  function visiveis(a, m) {
    const mes = mesIso(a, m);
    return st.convenios.filter(c => mes >= c.criadoMes);
  }

  /* =====================================================
     INÍCIO
  ===================================================== */
  document.addEventListener("DOMContentLoaded", async () => {
    const { data } = await supabaseClient.auth.getSession();
    if (!data?.session) return; // o dashboard.js já manda para o login

    st.email = (data.session.user?.email || "").toLowerCase();
    if (!(await carregarPapel())) return;

    st.hoje = hojeSP();
    st.ano = Number(st.hoje.slice(0, 4));
    st.mes = Number(st.hoje.slice(5, 7)) - 1;

    prepararTela();
    aplicarPapel();

    $("painelCalendario").hidden = false;
    st.pronto = true;

    await carregar();
  });

  async function carregarPapel() {
    const { data, error } = await supabaseClient.rpc("cal_papel");
    if (error) {
      // Funções ainda não criadas no Supabase: a aba fica escondida
      console.warn("Calendário indisponível (rode sql/faturamento.sql):", error.message);
      return false;
    }
    const p = Array.isArray(data) ? data[0] : data;
    if (!p || !p.liberado) return false;
    st.editor = p.editor === true;
    return true;
  }

  function aplicarPapel() {
    $("calSubtitulo").textContent = st.editor
      ? "Prazos de entrega de todos os convênios. Clique num convênio para transferir o prazo de um mês."
      : "Prazos de entrega dos convênios, para consulta.";
    $("calBtnNovo").hidden = !st.editor;
    aplicarLateral();
  }

  function prepararTela() {
    $("calMesAnterior").addEventListener("click", () => mudarMes(-1));
    $("calMesProximo").addEventListener("click", () => mudarMes(1));
    $("calMesHoje").addEventListener("click", () => {
      st.hoje = hojeSP();
      st.ano = Number(st.hoje.slice(0, 4));
      st.mes = Number(st.hoje.slice(5, 7)) - 1;
      carregar();
    });

    $("calJanelas").addEventListener("change", e => { st.janelas = e.target.checked; render(); });

    $("calBtnLateral").addEventListener("click", () => {
      st.lateral = !st.lateral;
      aplicarLateral();
      if (st.lateral) renderLateral();
    });
    $("calLateralFechar").addEventListener("click", () => {
      st.lateral = false;
      aplicarLateral();
      $("calBtnLateral").focus();
    });
    $("calBuscaConvenio").addEventListener("input", e => { st.busca = norm(e.target.value); renderLateral(); });
    $("calBtnNovo").addEventListener("click", () => abrirConvenio(null));

    prepararModais();

    // A altura dos dias acompanha a janela (e é zero com a aba escondida):
    // quando ela muda, recalcula quantos convênios cabem em cada dia
    let timerEncaixe = null;
    new ResizeObserver(() => {
      clearTimeout(timerEncaixe);
      timerEncaixe = setTimeout(encaixarChips, 60);
    }).observe($("calGrade"));

    // O dia aberto pelo "+N" fecha ao clicar fora dele ou com Esc
    document.addEventListener("click", e => {
      if (!e.target.closest(".cal-dia-expandido, .cal-mais")) recolherDias();
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !modalAberto()) recolherDias();
    });

    // Recarrega ao voltar para a aba (outra pessoa pode ter mexido)
    const talvezRecarregar = () => {
      if (!st.pronto || document.hidden || modalAberto()) return;
      if (Date.now() - st.ultimaCarga > RECARGA_MIN_MS) {
        st.hoje = hojeSP();
        carregar();
      }
    };
    window.addEventListener("focus", talvezRecarregar);
    document.addEventListener("visibilitychange", talvezRecarregar);

    // O painel Usuários avisa quando o nível de alguém no Calendário muda
    document.addEventListener("calendario:recarregar", async () => {
      if (!st.pronto) return;
      if (await carregarPapel()) {
        aplicarPapel();
        carregar();
      }
    });

    // Faturamento: um convênio de lá foi associado (ou desassociado) a um daqui
    document.addEventListener("calendario:vinculos", () => {
      if (st.pronto && !modalAberto()) carregar();
    });
    // Faturamento: "Ir para a próxima entrega"
    document.addEventListener("calendario:ir-para", e => irParaEntrega(e.detail && e.detail.id));
  }

  // Avisa o Faturamento que a lista de convênios daqui mudou
  const avisarFaturamento = () => document.dispatchEvent(new CustomEvent("faturamento:agendas"));

  function aplicarLateral() {
    $("calLateral").hidden = !st.lateral;
    $("calCorpo").classList.toggle("cal-corpo-lateral", st.lateral);
    $("calBtnLateral").setAttribute("aria-expanded", String(st.lateral));
  }

  function mudarMes(n) {
    [st.ano, st.mes] = somarMes(st.ano, st.mes, n);
    carregar();
  }

  /* =====================================================
     DADOS
  ===================================================== */
  async function carregar() {
    const minha = ++st.carga;
    const [a0, m0] = somarMes(st.ano, st.mes, -1);
    const [a1, m1] = somarMes(st.ano, st.mes, 1);

    // Observações: do mês anterior ao seguinte e também os próximos meses
    // a partir de hoje (a prévia do cadastro calcula 4 meses à frente).
    const [ah, mh] = [Number(st.hoje.slice(0, 4)), Number(st.hoje.slice(5, 7)) - 1];
    const [af, mf] = somarMes(ah, mh, 4);
    const obsDe = [mesIso(a0, m0), mesIso(ah, mh)].sort()[0];
    const obsAte = [iso(D(a1, m1 + 1, 0)), iso(D(af, mf + 1, 0))].sort()[1];

    renderTituloMes();
    const [resConv, resObs, resAjustes, resVinc] = await Promise.all([
      supabaseClient.rpc("cal_listar_convenios"),
      supabaseClient.rpc("cal_listar_observacoes", { p_de: obsDe, p_ate: obsAte }),
      supabaseClient.rpc("cal_listar_ajustes", { p_de: mesIso(a0, m0), p_ate: mesIso(a1, m1) }),
      supabaseClient.rpc("cal_listar_vinculos")
    ]);
    if (minha !== st.carga) return false; // o mês mudou no meio do caminho

    st.ultimaCarga = Date.now();
    if (resConv.error) {
      console.error("Erro ao carregar o calendário:", resConv.error);
      $("calMsg").textContent = "Não foi possível carregar o calendário. Tente recarregar a página.";
      return false;
    }
    $("calMsg").textContent = "";

    st.convenios = (resConv.data || []).map(c => ({
      ...c,
      dias_semana: c.dias_semana || [],
      criadoDia: dataSP(c.criado_em),
      criadoMes: dataSP(c.criado_em).slice(0, 8) + "01"
    }));

    if (resObs.error) console.warn("Observações indisponíveis:", resObs.error.message);
    if (resAjustes.error) console.warn("Ajustes indisponíveis:", resAjustes.error.message);
    st.obs = new Map();
    st.semExpediente = new Map();
    (resObs.data || []).forEach(o => {
      if (!st.obs.has(o.data)) st.obs.set(o.data, []);
      st.obs.get(o.data).push(o);
      if (o.sem_expediente && !st.semExpediente.has(o.data)) st.semExpediente.set(o.data, o.texto);
    });
    st.ajustes = new Map((resAjustes.data || []).map(a => [`${a.convenio_id}|${a.mes}`, a]));

    // Sem a função (sql/faturamento-calendario-vinculo.sql) só não mostra os nomes
    if (resVinc.error) console.warn("Vínculos com o Faturamento indisponíveis:", resVinc.error.message);
    st.vinculos = new Map();
    (resVinc.data || []).forEach(v => {
      if (!st.vinculos.has(v.cal_convenio_id)) st.vinculos.set(v.cal_convenio_id, []);
      st.vinculos.get(v.cal_convenio_id).push(v.nome);
    });

    if (st.obsData && !$("calModalObs").hidden) renderObsLista();

    // Convênio aberto no modal pode ter mudado ou sumido
    if (st.detalhe) {
      const c = st.convenios.find(x => x.id === st.detalhe.c.id);
      if (c) { st.detalhe.c = c; preencherDetalhe(); } else fecharModal("calModalDetalhe");
    }

    render();
    return true;
  }

  /* =====================================================
     RENDERIZAÇÃO
  ===================================================== */
  function render() {
    renderTituloMes();
    renderGrade();
    renderLivres();
    if (st.lateral) renderLateral();
  }

  function renderTituloMes() {
    $("calMesTitulo").textContent = `${MESES[st.mes]} ${st.ano}`;
  }

  /* ---------- Grade do mês ---------- */
  function renderGrade() {
    const grade = $("calGrade");
    grade.replaceChildren();
    DIAS_CURTOS.forEach(d => grade.append(el("div", "cal-dia-semana", d)));

    const a = st.ano, m = st.mes;

    // A janela de um mês pode escorregar para o vizinho (ex.: dia 31 num
    // sábado adiado para o dia 2), por isso entram os meses ao lado também.
    const itens = [];
    [-1, 0, 1].forEach(n => {
      const [aa, mm] = somarMes(a, m, n);
      visiveis(aa, mm).forEach(c => {
        if (c.tipo === "livre") return;
        const j = janela(c, aa, mm);
        if (!antesDoCadastro(c, j)) itens.push({ c, a: aa, m: mm, j });
      });
    });

    const primeiro = D(a, m, 1).getUTCDay();
    for (let i = 0; i < primeiro; i++) grade.append(el("div", "cal-dia cal-dia-vazio"));

    for (let d = 1; d <= ultimoDia(a, m); d++) {
      const data = iso(D(a, m, d));
      const util = diaUtil(D(a, m, d));
      const cel = el("div", "cal-dia");
      cel.dataset.data = data;
      if (!util) cel.classList.add("cal-dia-fds");
      if (data === st.hoje) cel.classList.add("cal-dia-hoje");
      else if (data < st.hoje) cel.classList.add("cal-dia-passado");

      const topo = el("div", "cal-dia-topo");
      const num = el("span", "cal-dia-num", String(d));
      if (data === st.hoje) num.setAttribute("aria-label", `Hoje, ${ddmm(data)}`);
      topo.append(num);

      // Observações do dia: um balão discreto (com a contagem se houver mais de uma)
      const obsDia = st.obs.get(data) || [];
      if (obsDia.length) {
        const ind = botao("cal-obs-ind" + (st.semExpediente.has(data) ? " cal-obs-ind-sem" : ""), null, () => abrirObs(data));
        ind.append(icone("obs"));
        if (obsDia.length > 1) ind.append(el("span", null, String(obsDia.length)));
        ind.title = obsDia.map(o => (o.sem_expediente ? "[Sem expediente] " : "") + o.texto).join("\n");
        ind.setAttribute("aria-label", `${obsDia.length} observação(ões) em ${ddmm(data)}`);
        topo.append(ind);
      }
      cel.append(topo);
      // Dia sem expediente: o motivo numa linha própria, para caber inteiro
      const sem = st.semExpediente.get(data);
      if (sem) {
        const f = el("span", "cal-feriado", sem);
        f.title = `Sem expediente: ${sem}`;
        cel.append(f);
      }

      // "+" no canto para quem pode lançar observação
      if (podeEditar()) {
        const add = botao("cal-dia-add", "+", () => abrirObs(data, true));
        add.title = "Adicionar observação neste dia";
        add.setAttribute("aria-label", `Adicionar observação em ${ddmm(data)}`);
        cel.append(add);
      }

      // Sábado, domingo e feriado não são dia de entrega: a janela não
      // aparece neles (o prazo final nunca cai nesses dias).
      const doDia = itens
        .filter(x => data >= x.j.ini && data <= x.j.fim)
        .filter(x => data === x.j.fim || (st.janelas && util))
        .sort((x, y) => (data === y.j.fim) - (data === x.j.fim) ||
                        x.c.nome.localeCompare(y.c.nome, "pt-BR"));

      doDia.forEach(x => cel.append(chipConvenio(x, data === x.j.fim)));
      grade.append(cel);
    }
    encaixarChips();
  }

  /* Cada dia mostra só os chips que cabem nele (até CHIPS_POR_DIA); o
     resto fica atrás de "+N". No computador a grade tem a altura da
     janela, então o quanto cabe depende do tamanho da tela. Os prazos
     finais vêm primeiro, então o que fica escondido são as janelas. */
  function encaixarChips() {
    $("calGrade").querySelectorAll(".cal-dia:not(.cal-dia-vazio)").forEach(cel => {
      if (cel.classList.contains("cal-dia-expandido")) return;
      cel.querySelector(".cal-mais")?.remove();
      const chips = [...cel.querySelectorAll(".cal-chip")];
      chips.forEach(c => { c.hidden = false; });
      if (!chips.length) return;

      const cabe = () => cel.scrollHeight <= cel.clientHeight + 1;
      let vis = Math.min(chips.length, CHIPS_POR_DIA);
      chips.slice(vis).forEach(c => { c.hidden = true; });
      if (vis === chips.length && cabe()) return;

      // O "+N" vai na linha do número do dia, que tem espaço sobrando
      const mais = botao("cal-mais", "", () => expandirDia(cel));
      cel.querySelector(".cal-dia-topo").append(mais);
      const contar = () => {
        const resto = chips.length - vis;
        mais.textContent = `+${resto}`;
        mais.setAttribute("aria-label", `Mostrar mais ${resto} convênio(s)`);
      };
      contar();
      while (vis > 0 && !cabe()) {
        chips[--vis].hidden = true;
        contar();
      }
    });
  }

  // "+N": o dia abre por cima dos vizinhos com todos os convênios
  function expandirDia(cel) {
    recolherDias();
    cel.classList.add("cal-dia-expandido");
    cel.querySelectorAll(".cal-chip[hidden]").forEach(c => { c.hidden = false; });
    cel.querySelector(".cal-mais")?.remove();
  }

  function recolherDias() {
    const abertos = $("calGrade").querySelectorAll(".cal-dia-expandido");
    if (!abertos.length) return;
    abertos.forEach(c => c.classList.remove("cal-dia-expandido"));
    encaixarChips();
  }

  function chipConvenio(x, ehFim) {
    const { c, j } = x;
    const ajustado = ehFim && j.ajuste;
    const chip = botao("cal-chip", `${ajustado ? "↻ " : ""}${c.nome}`, () => abrirDetalhe(c, x.a, x.m));
    chip.dataset.conv = c.id;
    chip.classList.add(ehFim ? "cal-fim" : "cal-janela");
    if (ajustado) chip.classList.add("cal-ajustado");
    const partes = [c.nome, textoRegra(c), `Prazo: ${textoPrazo(j)}`];
    if (j.ajuste) partes.push(notaAjustePontual(j));
    const fat = st.vinculos.get(c.id);
    if (fat) partes.push(`Faturamento: ${lista(fat)}`);
    chip.title = partes.join("\n");
    return chip;
  }

  /* ---------- Convênios de entrega livre ---------- */
  function renderLivres() {
    const caixa = $("calLivres");
    caixa.replaceChildren();
    const livres = visiveis(st.ano, st.mes)
      .filter(c => c.tipo === "livre")
      .sort((x, y) => x.nome.localeCompare(y.nome, "pt-BR"));
    caixa.hidden = !livres.length;
    if (!livres.length) return;

    // Uma linha só, fora da grade para não poluir o calendário
    const rotulo = el("span", "cal-livres-rotulo", "Entrega livre:");
    rotulo.title = "Aceitam entrega em qualquer dia indicado do mês";
    caixa.append(rotulo);
    livres.forEach(c => {
      const b = botao("cal-livre", null, () => abrirDetalhe(c, st.ano, st.mes));
      b.dataset.conv = c.id;
      b.append(el("span", "cal-livre-nome", c.nome),
               el("span", "cal-livre-info", textoRegra(c).replace("Livre: ", "")));
      b.title = `${c.nome}\n${textoRegra(c)}`;
      caixa.append(b);
    });
  }

  /* ---------- Lista lateral de convênios ---------- */
  function renderLateral() {
    const caixa = $("calListaConvenios");
    caixa.replaceChildren();

    const achados = st.convenios
      .filter(c => !st.busca || norm(c.nome).includes(st.busca))
      .sort((x, y) => x.nome.localeCompare(y.nome, "pt-BR"));

    $("calLateralQtd").textContent = `· ${st.convenios.length}`;

    if (!achados.length) {
      caixa.append(el("p", "cal-lateral-vazio", st.convenios.length ? "Nenhum convênio encontrado." : "Nenhum convênio cadastrado ainda."));
      return;
    }

    achados.forEach(c => {
      const aberto = st.abertos.has(c.id);
      const j = janela(c, st.ano, st.mes);
      const item = el("div", "cal-conv" + (aberto ? " cal-conv-aberto" : ""));

      const cab = botao("cal-conv-cab", null, () => {
        if (st.abertos.has(c.id)) st.abertos.delete(c.id); else st.abertos.add(c.id);
        renderLateral();
      });
      cab.setAttribute("aria-expanded", String(aberto));
      cab.append(el("span", "cal-conv-nome", c.nome));
      cab.append(el("span", "cal-conv-seta", aberto ? "▾" : "▸"));
      item.append(cab);

      if (aberto) {
        const corpo = el("dl", "cal-conv-corpo");
        const linha = (rotulo, valor) => { corpo.append(el("dt", null, rotulo), el("dd", null, valor)); };
        linha("Regra", textoRegra(c));
        linha(`Prazo em ${MESES_CURTOS[st.mes]}`, textoPrazo(j));
        const nota = notaAjuste(j);
        if (nota) linha("Ajuste", nota);
        const fat = st.vinculos.get(c.id);
        if (fat) linha("Faturamento", lista(fat));
        item.append(corpo);

        const acoes = el("div", "cal-conv-acoes");
        acoes.append(botao("btn-cinza btn-small", "Abrir", () => abrirDetalhe(c, st.ano, st.mes)));
        if (podeEditar()) {
          acoes.append(botao("btn-cinza btn-small", "Editar", () => abrirConvenio(c)));
          acoes.append(botao("btn-vermelho btn-small", "Excluir", e => excluirConvenio(c, e.currentTarget)));
        }
        item.append(acoes);
      }
      caixa.append(item);
    });
  }

  /* =====================================================
     MODAIS
  ===================================================== */
  function modalAberto() {
    return !!document.querySelector(".cal-modal:not([hidden])");
  }

  function abrirModal(id, foco) {
    const m = $(id);
    m._focoAnterior = document.activeElement;
    m.hidden = false;
    (foco || m.querySelector("input, select, button:not(.modal-fechar)"))?.focus();
  }

  function fecharModal(id) {
    const m = $(id);
    if (m.hidden) return;
    m.hidden = true;
    if (id === "calModalDetalhe") st.detalhe = null;
    if (id === "calModalConvenio") st.edicao = null;
    if (id === "calModalObs") st.obsData = null;
    m._focoAnterior?.focus?.();
  }

  function prepararModais() {
    document.querySelectorAll(".cal-modal").forEach(m => {
      m.addEventListener("click", e => {
        // Só o X / botões [data-fechar] fecham; clique no fundo é ignorado
        if (e.target.closest("[data-fechar]")) fecharModal(m.id);
      });
    });
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      const aberto = document.querySelector(".cal-modal:not([hidden])");
      if (aberto) fecharModal(aberto.id);
    });

    // Detalhe
    $("calDetEditar").addEventListener("click", () => {
      const c = st.detalhe?.c;
      fecharModal("calModalDetalhe");
      if (c) abrirConvenio(c);
    });
    $("calDetExcluir").addEventListener("click", async () => {
      const c = st.detalhe?.c;
      if (c && await excluirConvenio(c, $("calDetExcluir"), $("calDetMsg"))) fecharModal("calModalDetalhe");
    });

    // Convênio
    const semana = $("calConvSemana");
    [1, 2, 3, 4, 5].forEach(d => {
      const rotulo = el("label", "usuario-equipe");
      const chk = el("input");
      chk.type = "checkbox";
      chk.value = String(d);
      chk.addEventListener("change", renderPrevia);
      rotulo.append(chk, document.createTextNode(DIAS[d]));
      semana.append(rotulo);
    });
    document.querySelectorAll("#calConvTipos [data-tipo]").forEach(b => b.addEventListener("click", () => {
      st.tipo = b.dataset.tipo;
      aplicarTipo();
    }));
    ["calConvInicio", "calConvFim", "calConvUtil"].forEach(id => $(id).addEventListener("input", renderPrevia));
    $("calConvAjuste").addEventListener("change", renderPrevia);
    $("calConvNome").addEventListener("input", () => { $("calConvMsg").textContent = ""; });
    $("calConvSalvar").addEventListener("click", salvarConvenio);
    $("calConvDesativar").addEventListener("click", async () => {
      const c = st.edicao;
      if (c && await excluirConvenio(c, $("calConvDesativar"), $("calConvMsg"))) fecharModal("calModalConvenio");
    });

    // Observações do dia
    $("calObsSalvar").addEventListener("click", salvarObs);
    $("calObsTexto").addEventListener("input", () => { $("calObsMsg").textContent = ""; });
  }

  /* ---------- Detalhe de um convênio no mês ---------- */
  function abrirDetalhe(c, a, m) {
    st.detalhe = { c, a, m };
    preencherDetalhe();
    abrirModal("calModalDetalhe");
  }

  function preencherDetalhe() {
    const { c, a, m } = st.detalhe;
    const j = janela(c, a, m);
    $("calDetTitulo").textContent = c.nome;
    $("calDetMsg").textContent = "";

    const corpo = $("calDetCorpo");
    corpo.replaceChildren();
    const dl = el("dl", "cal-det-lista");
    const linha = (rotulo, valor, classe) => {
      dl.append(el("dt", null, rotulo));
      dl.append(el("dd", classe || null, valor));
    };
    linha("Mês", `${MESES[m]} ${a}`);
    linha("Regra", textoRegra(c));
    linha("Prazo", textoPrazo(j));
    if (j && j.ajuste) linha("Prazo da regra", ddmm(j.regraFim));
    const nota = notaAjuste(j);
    if (nota) linha("Ajuste", nota, j && j.ajuste ? "cal-det-ajustado" : null);
    const fat = st.vinculos.get(c.id);
    linha("Faturamento", fat ? lista(fat) : "Nenhum convênio do Faturamento associado");
    corpo.append(dl);

    renderAjustePontual(c, a, m, j);
    $("calDetEditar").hidden = !podeEditar();
    $("calDetExcluir").hidden = !podeEditar();
    $("calDetEditar").closest(".modal-botoes").hidden = $("calDetEditar").hidden;
  }

  /* ---------- Criar / editar convênio ---------- */
  function abrirConvenio(c) {
    st.edicao = c;
    $("calConvTitulo").textContent = c ? `Editar ${c.nome}` : "Novo convênio";
    $("calConvMsg").textContent = "";
    $("calConvNome").value = c ? c.nome : "";

    st.tipo = c ? c.tipo : "periodo";
    $("calConvInicio").value = c && c.dia_inicio ? c.dia_inicio : (st.tipo === "fixo" ? 10 : 1);
    $("calConvFim").value = c && c.dia_fim ? c.dia_fim : 5;
    $("calConvUtil").value = c && c.dia_util ? c.dia_util : 5;
    $("calConvAjuste").value = c ? c.ajuste : "proximo";
    const dias = c && c.tipo === "livre" ? c.dias_semana : [1, 2, 3, 4, 5];
    $("calConvSemana").querySelectorAll("input").forEach(chk => { chk.checked = dias.includes(Number(chk.value)); });

    $("calConvDesativar").hidden = !(c && podeEditar());
    aplicarTipo();
    abrirModal("calModalConvenio", $("calConvNome"));
  }

  function aplicarTipo() {
    document.querySelectorAll("#calConvTipos [data-tipo]").forEach(b =>
      b.setAttribute("aria-pressed", String(b.dataset.tipo === st.tipo)));
    document.querySelectorAll("#calModalConvenio [data-para]").forEach(e => {
      e.hidden = !e.dataset.para.split(" ").includes(st.tipo);
    });
    $("calConvInicioRotulo").textContent = st.tipo === "periodo" ? "Do dia" : "Dia do mês";
    renderPrevia();
  }

  function lerFormulario() {
    const inteiro = id => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? v : null; };
    return {
      nome: $("calConvNome").value.trim().replace(/\s+/g, " "),
      tipo: st.tipo,
      dia_inicio: st.tipo === "fixo" || st.tipo === "periodo" ? inteiro("calConvInicio") : null,
      dia_fim: st.tipo === "periodo" ? inteiro("calConvFim") : null,
      dia_util: st.tipo === "util" ? inteiro("calConvUtil") : null,
      dias_semana: st.tipo === "livre"
        ? [...$("calConvSemana").querySelectorAll("input:checked")].map(c => Number(c.value)) : null,
      ajuste: $("calConvAjuste").value
    };
  }

  // Mesmo que o banco confere; aqui só para avisar antes de enviar
  function problemaDaRegra(f) {
    const entre = (v, a, b) => v != null && v >= a && v <= b;
    if (f.tipo === "fixo" && !entre(f.dia_inicio, 1, 31)) return "Informe o dia do mês (1 a 31).";
    if (f.tipo === "periodo") {
      if (!entre(f.dia_inicio, 1, 31) || !entre(f.dia_fim, 1, 31)) return "Informe o primeiro e o último dia do período (1 a 31).";
      if (f.dia_fim < f.dia_inicio) return "O último dia do período precisa ser depois do primeiro.";
    }
    if (f.tipo === "util" && !entre(f.dia_util, 1, 23)) return "Informe qual dia útil (1 a 23).";
    if (f.tipo === "livre" && !f.dias_semana.length) return "Marque ao menos um dia da semana.";
    return "";
  }

  function renderPrevia() {
    const caixa = $("calConvPrevia");
    caixa.replaceChildren();
    const f = lerFormulario();
    const problema = problemaDaRegra(f);
    if (problema) {
      caixa.append(el("p", "cal-previa-erro", problema));
      return;
    }

    const regra = { ...f };
    const [a0, m0] = [Number(st.hoje.slice(0, 4)), Number(st.hoje.slice(5, 7)) - 1];
    for (let i = 0; i < 4; i++) {
      const [a, m] = somarMes(a0, m0, i);
      const linha = el("div", "cal-previa-linha");
      linha.append(el("span", "cal-previa-mes", `${MESES_CURTOS[m]}/${a}`));
      const valor = el("span", "cal-previa-valor");
      if (f.tipo === "livre") {
        let dias = 0;
        for (let d = 1; d <= ultimoDia(a, m); d++) {
          const x = D(a, m, d);
          if (diaUtil(x) && f.dias_semana.includes(x.getUTCDay())) dias++;
        }
        valor.append(el("strong", null, `${dias} dias disponíveis`));
        valor.append(el("span", "cal-previa-nota", f.dias_semana.length === 5 ? "qualquer dia útil" : lista(f.dias_semana.map(d => DIAS[d]))));
      } else {
        const j = janela(regra, a, m);
        valor.append(el("strong", null, textoPrazo(j)));
        const nota = f.tipo === "util"
          ? `${f.dia_util}º dia útil cai numa ${DIAS[deIso(j.fim).getUTCDay()]}`
          : notaAjuste(j);
        if (nota) valor.append(el("span", "cal-previa-nota" + (f.tipo === "util" ? "" : " cal-previa-ajuste"), nota));
      }
      linha.append(valor);
      caixa.append(linha);
    }
  }

  async function salvarConvenio() {
    const f = lerFormulario();
    const msg = $("calConvMsg");
    msg.textContent = "";

    if (!f.nome) { msg.textContent = "Informe o nome do convênio."; $("calConvNome").focus(); return; }
    const problema = problemaDaRegra(f);
    if (problema) { msg.textContent = problema; return; }

    const btn = $("calConvSalvar");
    btn.disabled = true;
    const regra = {
      p_nome: f.nome, p_tipo: f.tipo, p_dia_inicio: f.dia_inicio, p_dia_fim: f.dia_fim,
      p_dia_util: f.dia_util, p_dias_semana: f.dias_semana, p_ajuste: f.ajuste
    };
    const { error } = st.edicao
      ? await supabaseClient.rpc("cal_editar_convenio", { p_id: st.edicao.id, ...regra })
      : await supabaseClient.rpc("cal_criar_convenio", regra);
    btn.disabled = false;

    if (error) {
      console.error("Erro ao salvar convênio do calendário:", error);
      msg.textContent = mensagemErro(error, "Não foi possível salvar o convênio.");
      return;
    }

    const criado = !st.edicao;
    fecharModal("calModalConvenio");
    avisar(criado ? `${f.nome} criado.` : `${f.nome} atualizado.`);
    avisarFaturamento();
    await carregar();
  }

  /* Exclui do calendário (o banco guarda como inativo, para o histórico).
     Os convênios do Faturamento ligados a ele ficam sem agenda.
     Devolve true se excluiu. */
  async function excluirConvenio(c, btn, msg) {
    const fat = st.vinculos.get(c.id) || [];
    const aviso = fat.length
      ? `\n\nNo Faturamento, ${lista(fat)} ${fat.length === 1 ? "fica" : "ficam"} sem agenda e ${fat.length === 1 ? "pode" : "podem"} ser associado${fat.length === 1 ? "" : "s"} a outro convênio depois.`
      : "";
    if (!confirm(`Excluir ${c.nome} do calendário?\n\nEle some do calendário, com as datas e os ajustes dele.${aviso}`)) return false;

    if (btn) btn.disabled = true;
    let { error } = await supabaseClient.rpc("cal_excluir_convenio", { p_id: c.id });
    // Banco sem o sql/faturamento-calendario-vinculo.sql: usa a função antiga
    if (error && error.code === "PGRST202") {
      ({ error } = await supabaseClient.rpc("cal_desativar_convenio", { p_id: c.id }));
    }
    if (btn) btn.disabled = false;
    if (error) {
      console.error("Erro ao excluir convênio do calendário:", error);
      const texto = mensagemErro(error, "Não foi possível excluir o convênio.");
      if (msg) msg.textContent = texto; else avisar(texto);
      return false;
    }
    st.abertos.delete(c.id);
    avisar(`${c.nome} excluído do calendário.`);
    avisarFaturamento();
    await carregar();
    return true;
  }

  /* ---------- Vindo do Faturamento: próxima data de entrega ---------- */

  // {a, m, data, j?} da próxima entrega a partir de hoje (null se não houver)
  function proximaEntrega(c) {
    const [ah, mh] = [Number(st.hoje.slice(0, 4)), Number(st.hoje.slice(5, 7)) - 1];
    // Começa no mês anterior: o prazo dele pode ter escorregado para este mês
    for (let n = -1; n <= 13; n++) {
      const [a, m] = somarMes(ah, mh, n);
      if (mesIso(a, m) < c.criadoMes) continue;
      if (c.tipo === "livre") {
        for (let d = 1; d <= ultimoDia(a, m); d++) {
          const x = D(a, m, d);
          if (iso(x) >= st.hoje && diaUtil(x) && c.dias_semana.includes(x.getUTCDay())) return { a, m, data: iso(x) };
        }
        continue;
      }
      const j = janela(c, a, m);
      if (!j || antesDoCadastro(c, j) || j.fim < st.hoje) continue;
      return { a, m, j, data: j.fim };
    }
    return null;
  }

  async function irParaEntrega(id) {
    if (!st.pronto || !id) return;
    $("navCalendario")?.click();
    document.querySelectorAll(".cal-modal:not([hidden])").forEach(m => fecharModal(m.id));

    // Sempre a partir do mês de hoje, com os dados frescos
    st.hoje = hojeSP();
    st.ano = Number(st.hoje.slice(0, 4));
    st.mes = Number(st.hoje.slice(5, 7)) - 1;
    if (!(await carregar())) return;

    const c = st.convenios.find(x => x.id === id);
    if (!c) { avisar("Esse convênio não está mais no Calendário de entrega."); return; }
    const p = proximaEntrega(c);
    if (!p) { avisar(`${c.nome} não tem data de entrega nos próximos meses.`); return; }

    // A grade mostra o mês da data (pode ser o seguinte ao de hoje)
    const [da, dm] = [Number(p.data.slice(0, 4)), Number(p.data.slice(5, 7)) - 1];
    if (da !== st.ano || dm !== st.mes) {
      st.ano = da;
      st.mes = dm;
      if (!(await carregar())) return;
    }

    const dia = DIAS[deIso(p.data).getUTCDay()];
    if (c.tipo === "livre") {
      destacar($("calLivres").querySelectorAll(`.cal-livre[data-conv="${c.id}"]`), null);
      avisar(`${c.nome}: entrega livre. Próximo dia possível: ${ddmm(p.data)} (${dia}).`);
      return;
    }
    const cel = $("calGrade").querySelector(`.cal-dia[data-data="${p.data}"]`);
    if (cel && cel.querySelector(`.cal-chip[data-conv="${c.id}"][hidden]`)) expandirDia(cel);
    destacar($("calGrade").querySelectorAll(`.cal-chip[data-conv="${c.id}"]`), cel);
    const prazo = p.j.ini === p.j.fim ? `${ddmm(p.data)} (${dia})` : `${ddmm(p.j.ini)} a ${ddmm(p.data)} (prazo final ${dia})`;
    avisar(`Próxima entrega de ${c.nome}: ${prazo}.`);
  }

  // Pisca os chips do convênio e rola até o dia do prazo
  function destacar(chips, cel) {
    chips.forEach(ch => ch.classList.add("cal-destaque"));
    (cel || chips[0])?.scrollIntoView({ behavior: "smooth", block: "center" });
    const fim = [...chips].find(ch => ch.classList.contains("cal-fim")) || chips[0];
    fim?.focus({ preventScroll: true });
    setTimeout(() => chips.forEach(ch => ch.classList.remove("cal-destaque")), 6000);
  }

  /* ---------- Ajuste pontual (só este convênio, só este mês) ---------- */
  function renderAjustePontual(c, a, m, j) {
    const caixa = $("calDetAjuste");
    caixa.replaceChildren();
    const pode = podeEditar() && j;
    caixa.hidden = !pode;
    if (!pode) return;

    caixa.append(el("h3", null, "Transferir só este mês"));
    caixa.append(el("p", "painel-aviso", "Muda o prazo final apenas deste convênio neste mês. A regra do convênio continua a mesma."));

    const fim = deIso(j.fim);
    const proximo = ajustar(somarDias(fim, 1), "proximo");
    const anterior = ajustar(somarDias(fim, -1), "anterior");

    const motivo = el("input", "cal-ajuste-motivo");
    motivo.type = "text";
    motivo.placeholder = "Motivo (opcional): operadora não recebe no feriado…";
    motivo.setAttribute("aria-label", "Motivo do ajuste");
    if (j.ajuste && j.ajuste.motivo) motivo.value = j.ajuste.motivo;

    const rapidos = el("div", "cal-ajuste-botoes");
    rapidos.append(
      botao("btn-cinza btn-small", `Adiar para ${ddmm(iso(proximo))} (${DIAS[proximo.getUTCDay()]})`,
        () => ajustarPrazo(c, a, m, iso(proximo), motivo.value)),
      botao("btn-cinza btn-small", `Antecipar para ${ddmm(iso(anterior))} (${DIAS[anterior.getUTCDay()]})`,
        () => ajustarPrazo(c, a, m, iso(anterior), motivo.value))
    );

    const outra = el("div", "cal-ajuste-data");
    const campo = el("input", "cal-numero cal-ajuste-campo");
    campo.type = "date";
    campo.value = j.fim;
    campo.setAttribute("aria-label", "Outra data para o prazo");
    outra.append(campo, botao("btn-cinza btn-small", "Usar esta data", () => ajustarPrazo(c, a, m, campo.value, motivo.value)));

    caixa.append(rapidos, outra, motivo);

    if (j.ajuste) {
      caixa.append(botao("btn-vermelho btn-small cal-ajuste-voltar", `Voltar ao prazo da regra (${ddmm(j.regraFim)})`,
        () => removerAjuste(c, a, m)));
    }
  }

  async function ajustarPrazo(c, a, m, data, motivo) {
    const msg = $("calDetMsg");
    msg.textContent = "";
    if (!data) { msg.textContent = "Escolha a nova data."; return; }
    const d = deIso(data);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      msg.textContent = "A nova data cai num fim de semana. Escolha um dia útil.";
      return;
    }
    if (st.semExpediente.has(data) &&
        !confirm(`${ddmm(data)} está marcado sem expediente (${st.semExpediente.get(data)}). Usar esta data mesmo assim?`)) return;

    const { error } = await supabaseClient.rpc("cal_ajustar_prazo", {
      p_convenio: c.id, p_mes: mesIso(a, m), p_prazo: data, p_motivo: (motivo || "").trim() || null
    });
    if (error) {
      console.error("Erro ao ajustar prazo:", error);
      msg.textContent = mensagemErro(error, "Não foi possível ajustar o prazo.");
      return;
    }
    avisar(`Prazo de ${c.nome} transferido para ${ddmm(data)} só neste mês.`);
    await carregar();
  }

  async function removerAjuste(c, a, m) {
    if (!confirm(`Voltar ${c.nome} ao prazo da regra em ${MESES[m].toLowerCase()}?`)) return;
    const { error } = await supabaseClient.rpc("cal_remover_ajuste", { p_convenio: c.id, p_mes: mesIso(a, m) });
    if (error) {
      console.error("Erro ao remover ajuste:", error);
      $("calDetMsg").textContent = mensagemErro(error, "Não foi possível desfazer o ajuste.");
      return;
    }
    avisar("Prazo voltou para o da regra.");
    await carregar();
  }

  /* ---------- Observações do dia ---------- */
  function icone(nome) {
    const span = el("span", "cal-icone");
    // SVG fixo, sem nenhum dado do banco
    if (nome === "obs") {
      span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
    }
    return span;
  }

  function abrirObs(data, focarForm) {
    st.obsData = data;
    $("calObsTitulo").textContent = `Observações · ${ddmmaaaa(data)} (${DIAS[deIso(data).getUTCDay()]})`;
    $("calObsMsg").textContent = "";
    $("calObsForm").hidden = !podeEditar();
    $("calObsTexto").value = "";
    $("calObsSemExpediente").checked = false;
    renderObsLista();
    abrirModal("calModalObs", podeEditar() && (focarForm || !(st.obs.get(data) || []).length) ? $("calObsTexto") : null);
  }

  function renderObsLista() {
    const caixa = $("calObsLista");
    caixa.replaceChildren();
    const itens = st.obs.get(st.obsData) || [];
    if (!itens.length) {
      caixa.append(el("p", "painel-aviso cal-obs-vazio", podeEditar()
        ? "Nenhuma observação neste dia ainda."
        : "Nenhuma observação neste dia."));
      return;
    }
    itens.forEach(o => {
      const item = el("div", "cal-obs-item");
      const corpo = el("div", "cal-obs-corpo");
      if (o.sem_expediente) corpo.append(el("span", "cal-obs-tag", "Sem expediente"));
      corpo.append(el("p", "cal-obs-texto", o.texto));
      const quando = o.criado_em ? new Date(o.criado_em).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
      }) : "";
      corpo.append(el("span", "cal-obs-meta", [o.criado_por ? curto(o.criado_por) : "", quando].filter(Boolean).join(" · ")));
      item.append(corpo);
      if (podeEditar()) {
        const rem = botao("btn-cinza btn-small", "Remover", () => removerObs(o));
        rem.setAttribute("aria-label", `Remover a observação: ${o.texto}`);
        item.append(rem);
      }
      caixa.append(item);
    });
  }

  async function salvarObs() {
    const texto = $("calObsTexto").value.trim();
    if (!texto) { $("calObsMsg").textContent = "Escreva a observação."; $("calObsTexto").focus(); return; }
    const btn = $("calObsSalvar");
    btn.disabled = true;
    const { error } = await supabaseClient.rpc("cal_criar_observacao", {
      p_data: st.obsData, p_texto: texto, p_sem_expediente: $("calObsSemExpediente").checked
    });
    btn.disabled = false;
    if (error) {
      console.error("Erro ao salvar observação:", error);
      $("calObsMsg").textContent = mensagemErro(error, "Não foi possível salvar a observação.");
      return;
    }
    $("calObsTexto").value = "";
    $("calObsSemExpediente").checked = false;
    avisar(`Observação adicionada em ${ddmm(st.obsData)}.`);
    await carregar();
  }

  async function removerObs(o) {
    if (!confirm(`Remover esta observação de ${ddmm(o.data)}?\n\n${o.texto}`)) return;
    const { error } = await supabaseClient.rpc("cal_remover_observacao", { p_id: o.id });
    if (error) {
      console.error("Erro ao remover observação:", error);
      $("calObsMsg").textContent = mensagemErro(error, "Não foi possível remover a observação.");
      return;
    }
    avisar("Observação removida.");
    await carregar();
  }
})();
