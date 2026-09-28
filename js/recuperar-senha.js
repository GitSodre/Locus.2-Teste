document.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    document.getElementById("btnEnviar").click();
  }
});

document.getElementById("btnEnviar").addEventListener("click", async () => {
  const email = document.getElementById("email").value.trim();
  const msg = document.getElementById("msg");
  const btn = document.getElementById("btnEnviar");

  msg.classList.remove("erro");

  if (!email) {
    msg.classList.add("erro");
    msg.textContent = "Informe seu email.";
    return;
  }

  btn.disabled = true;

  // Deriva a URL a partir da própria página atual (e não só de
  // window.location.origin, que corta qualquer subpasta — ex: se o
  // site estiver em https://gitsodre.github.io/locus/, origin sozinho
  // vira https://gitsodre.github.io e o link do email cai numa página
  // que não existe).
  const baseUrl = window.location.href.replace(/recuperar-senha\.html.*$/, "");

  // redirectTo também precisa estar na lista de "Redirect URLs" do
  // projeto no Supabase (Authentication > URL Configuration), senão o
  // link do email não funciona.
  await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: baseUrl + "redefinir-senha.html"
  });

  btn.disabled = false;

  // Mensagem igual em qualquer caso — evita revelar quais emails
  // estão ou não cadastrados no sistema.
  msg.textContent = "Se este email estiver cadastrado, você receberá um link para redefinir sua senha.";
});
