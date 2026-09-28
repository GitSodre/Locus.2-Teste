// Mostrar / ocultar senha
const btnOlho = document.getElementById("toggleSenha");
btnOlho.addEventListener("click", () => {
  const senha = document.getElementById("senha");
  const mostrar = senha.type === "password";
  senha.type = mostrar ? "text" : "password";
  btnOlho.setAttribute("aria-pressed", String(mostrar));
  btnOlho.setAttribute("aria-label", mostrar ? "Ocultar senha" : "Mostrar senha");
});

// Enter faz login
document.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    document.getElementById("btnEntrar").click();
  }
});

// Mensagem na própria tela, no lugar do alert()
const msgLogin = document.getElementById("msg");
function mostrarErroLogin(texto) {
  msgLogin.textContent = texto;
}

document.getElementById("btnEntrar").addEventListener("click", async () => {
  const btn = document.getElementById("btnEntrar");
  if (btn.disabled) return;

  const email = document.getElementById("login").value.trim();
  const senha = document.getElementById("senha").value.trim();

  mostrarErroLogin("");

  if (!email || !senha) {
    mostrarErroLogin("Preencha o email e a senha.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Entrando...";

  const { data: loginData, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password: senha
  });

  if (error) {
    btn.disabled = false;
    btn.textContent = "Entrar";
    mostrarErroLogin("Email ou senha incorretos. Confira e tente de novo.");
    return;
  }

  // Verifica se este é o primeiro acesso do usuário: se for, ele ainda
  // está usando a senha temporária cadastrada pelo admin e precisa
  // definir sua própria senha (PIN de 6 dígitos) antes de entrar.
  //
  // A consulta usa o email devolvido pela sessão (já normalizado pelo
  // Supabase), e não o que foi digitado — assim uma diferença de
  // maiúsculas/minúsculas não faz a checagem passar batido.
  const emailSessao = loginData.user?.email || email;

  const { data: userRow, error: errUsuario } = await supabaseClient
    .from("usuarios")
    .select("primeiro_acesso")
    .eq("email", emailSessao)
    .maybeSingle();

  if (errUsuario) {
    console.error("Erro ao verificar primeiro acesso:", errUsuario);
  }

  if (userRow?.primeiro_acesso) {
    window.location.href = "primeiro-acesso.html";
    return;
  }

  window.location.href = "dashboard.html";
});
