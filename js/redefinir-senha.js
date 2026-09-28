/*
 * Redefinição de senha pelo link do email.
 *
 * Aceita dois formatos de link:
 *
 * 1) NOVO (recomendado): ...redefinir-senha.html?token_hash=XXX&type=recovery
 *    O token só é validado quando a pessoa clica em "Redefinir senha".
 *    Assim, antivírus/filtros de email que "abrem" o link antes do
 *    usuário (Outlook Safe Links, Defender etc.) não gastam o token.
 *    Exige ajustar o template de email no Supabase.
 *
 * 2) ANTIGO: o Supabase valida o token ao abrir o link e redireciona
 *    para cá com #access_token=... (ou com #error_code=... se o token
 *    já tinha sido usado/expirado). Continua funcionando.
 */

// Captura o que veio na URL logo no início, antes de o Supabase
// processar e limpar o endereço.
const paramsHash  = new URLSearchParams(window.location.hash.slice(1));
const paramsQuery = new URLSearchParams(window.location.search);

const erroNaUrl = paramsHash.get("error_code") || paramsQuery.get("error_code");
const tokenHash = paramsQuery.get("token_hash");
const linkComToken = !!tokenHash && paramsQuery.get("type") === "recovery";

const msgEl = document.getElementById("msg");
const btnRedefinir = document.getElementById("btnRedefinir");

const TXT_LINK_USADO =
  "Este link já foi usado ou expirou. Solicite um novo em \"Esqueci minha senha\" e use sempre o email mais recente.";
const TXT_LINK_INVALIDO =
  "Link inválido ou expirado. Solicite a recuperação novamente.";

// true quando já existe uma sessão de recuperação válida nesta aba
let sessaoPronta = false;

// Registrado já no carregamento do script (antes ficava dentro do
// DOMContentLoaded e podia perder o evento).
supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY" && session) sessaoPronta = true;
});

function mostrarErro(texto) {
  msgEl.classList.add("erro");
  msgEl.textContent = texto;
}

function bloquearTela(texto) {
  mostrarErro(texto);
  btnRedefinir.disabled = true;
}

async function validarLink() {
  // O próprio Supabase avisou que o token não serve mais
  if (erroNaUrl) {
    bloquearTela(erroNaUrl === "otp_expired" ? TXT_LINK_USADO : TXT_LINK_INVALIDO);
    return;
  }

  // Formato novo: nada a validar agora, o token é conferido no clique
  if (linkComToken) return;

  // Formato antigo: getSession() espera o cliente terminar de ler a URL
  // (em vez do timeout fixo de 3 segundos, que dava "expirado" em rede
  // lenta e também ao recarregar a página depois de o link ser lido).
  const { data } = await supabaseClient.auth.getSession();
  if (data?.session) {
    sessaoPronta = true;
    return;
  }

  bloquearTela(TXT_LINK_INVALIDO);
}

validarLink();

function apenasNumeros(input) {
  input.value = input.value.replace(/\D/g, "").slice(0, 6);
}

document.getElementById("pin1").addEventListener("input", e => apenasNumeros(e.target));
document.getElementById("pin2").addEventListener("input", e => apenasNumeros(e.target));

// Enter confirma, igual às outras telas
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && !btnRedefinir.disabled) {
    btnRedefinir.click();
  }
});

btnRedefinir.addEventListener("click", async () => {
  const pin1 = document.getElementById("pin1").value;
  const pin2 = document.getElementById("pin2").value;

  msgEl.classList.remove("erro");
  msgEl.textContent = "";

  if (pin1.length !== 6 || pin2.length !== 6) {
    mostrarErro("A senha precisa ter exatamente 6 números.");
    return;
  }
  if (pin1 !== pin2) {
    mostrarErro("As senhas digitadas não coincidem.");
    return;
  }

  btnRedefinir.disabled = true;

  // Formato novo: valida o token agora, por ação da própria pessoa
  if (!sessaoPronta) {
    if (!linkComToken) {
      bloquearTela(TXT_LINK_INVALIDO);
      return;
    }

    const { error: errOtp } = await supabaseClient.auth.verifyOtp({
      token_hash: tokenHash,
      type: "recovery"
    });

    if (errOtp) {
      console.error("Erro ao validar link de recuperação:", errOtp);
      bloquearTela(TXT_LINK_USADO);
      return;
    }

    sessaoPronta = true;
    // Tira o token da barra de endereço (já foi gasto)
    history.replaceState(null, "", window.location.pathname);
  }

  const { error } = await supabaseClient.auth.updateUser({ password: pin1 });

  if (error) {
    // A sessão continua válida: a pessoa pode corrigir e tentar de novo
    btnRedefinir.disabled = false;
    mostrarErro(traduzirErroAuth(error.message));
    return;
  }

  msgEl.textContent = "Senha redefinida com sucesso! Redirecionando para o login...";

  await supabaseClient.auth.signOut();
  setTimeout(() => { window.location.href = "index.html"; }, 1500);
});

/* Voltar para a tela de login.
 *
 * Quem está nesta tela pode ter uma sessão temporária aberta (token do
 * link de recuperação). Se a gente só redirecionasse, essa sessão
 * continuaria valendo. Por isso o botão encerra a sessão antes de voltar.
 */
document.getElementById("btnVoltarLogin")?.addEventListener("click", async () => {
  try {
    await supabaseClient.auth.signOut();
  } catch (e) {
    console.error("Erro ao encerrar a sessão:", e);
  }
  window.location.href = "index.html";
});
