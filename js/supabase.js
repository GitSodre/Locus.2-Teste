const SUPABASE_URL = "https://tkqdqydcthdztitfzmrs.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_i4isIUlDwBdLYQBcmEDijw_lFJmKhNG";

/*
 * Por padrão o Supabase guarda a sessão no localStorage, que sobrevive
 * mesmo depois de fechar e reabrir o navegador — por isso um favorito
 * apontando pro dashboard.html caía direto sem pedir login de novo.
 *
 * Usando sessionStorage, a sessão só dura enquanto a aba/janela do
 * navegador estiver aberta. Ao fechar tudo e abrir de novo (inclusive
 * pelos favoritos), o login será exigido novamente.
 */
const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      storage: window.sessionStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);

/*
 * O Supabase sempre devolve error.message em inglês. Essa função traduz
 * as mensagens mais comuns que aparecem nas telas de senha (primeiro
 * acesso / redefinir senha); qualquer mensagem não mapeada cai num
 * texto genérico em vez de mostrar o inglês cru pro usuário.
 */
function traduzirErroAuth(mensagem) {
  const mapa = {
    "New password should be different from the old password.":
      "A nova senha precisa ser diferente da senha atual.",
    "Password should be at least 6 characters":
      "A senha precisa ter pelo menos 6 caracteres.",
    "Auth session missing!":
      "Sessão expirada. Peça um novo link e tente de novo.",
    "Invalid login credentials":
      "Email ou senha inválidos."
  };

  return mapa[mensagem] || "Não foi possível concluir a operação. Tente novamente.";
}
